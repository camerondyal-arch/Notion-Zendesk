// sync.js
//
// Compiles the Notion playbooks into prompt blocks and upserts them into a
// Zendesk custom object. Runs on a schedule from GitHub Actions — nobody is
// waiting on it, so the slow (~60s) Notion block-walk is fine here.
//
// Output model (assemble-from-parts, so the giant Part D is stored ONCE):
//   block "shared"           -> Part A + Part B + Part D
//   block "part_c:<team>"    -> that team's Part C, one per team
//
// Zendesk caps a custom object record at 32 KB, so each block is split into
// chunk records "<block>#1", "<block>#2", ... and an index record "<block>"
// whose content is JSON: {"chunks": N}. To read a block, fetch the index, then
// chunks 1..N in order and join them with no separator.
//
// Your Zendesk app then reads  shared + part_c:<selectedTeam>  at draft time
// and concatenates in this order (stable content first, for prompt caching):
//   [ shared ]  ->  [ part_c:<team> ]  ->  [ conversation ]

import { Client } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";

const REQUIRED = [
  "NOTION_API_KEY",
  "NOTION_PLAYBOOK_DB_ID",
  "SHARED_PAGE_A",
  "SHARED_PAGE_B",
  "SHARED_PAGE_D",
  "ZENDESK_SUBDOMAIN",
  "ZENDESK_EMAIL",
  "ZENDESK_API_TOKEN",
];
// Strip stray whitespace/newlines that often ride along when pasting secrets.
for (const k of [...REQUIRED, "ZENDESK_OBJECT_KEY"]) {
  if (process.env[k]) process.env[k] = process.env[k].trim();
}
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(", ")}`);
  process.exit(1);
}

const {
  NOTION_API_KEY,
  NOTION_PLAYBOOK_DB_ID,            // Notion DB: one row per team -> its Part C page
  SHARED_PAGE_A,                    // Part A page id
  SHARED_PAGE_B,                    // Part B page id
  SHARED_PAGE_D,                    // Part D page id
  ZENDESK_SUBDOMAIN,                // e.g. "acme" for acme.zendesk.com
  ZENDESK_EMAIL,                    // agent email used with the API token
  ZENDESK_API_TOKEN,
} = process.env;
// `||` rather than a destructuring default: an unset Actions secret arrives as "".
const ZENDESK_OBJECT_KEY = process.env.ZENDESK_OBJECT_KEY || "support_prompt";

const notion = new Client({ auth: NOTION_API_KEY });
const n2m = new NotionToMarkdown({ notionClient: notion });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Notion: convert a page to a markdown string, retrying on 429/409 ---
async function pageToMarkdown(pageId) {
  for (let attempt = 0; ; attempt++) {
    try {
      const blocks = await n2m.pageToMarkdown(pageId);
      return (n2m.toMarkdownString(blocks).parent ?? "").trim();
    } catch (err) {
      const status = err?.status ?? err?.code;
      const retryable = status === 429 || status === "rate_limited" || status === 409 || status === 529;
      if (retryable && attempt < 6) {
        const retryAfter = Number(err?.headers?.["retry-after"]) || 2 ** attempt;
        console.warn(`Notion ${status} on ${pageId}; retrying in ${retryAfter}s`);
        await sleep(retryAfter * 1000);
        continue;
      }
      throw err;
    }
  }
}

// --- Notion: read the team -> Part C registry from a database ---
// Reads the team from "Team" or the title column, and the page from "Playbook"
// (relation, URL, or a text field holding a link / page mention).
async function getTeams() {
  const teams = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: NOTION_PLAYBOOK_DB_ID,
      start_cursor: cursor,
    });
    for (const row of res.results) {
      const team = readTeamName(row);
      const pageId = readPlaybookPageId(row);
      if (team && pageId) teams.push({ team, pageId });
      else console.warn(`Skipping a registry row (missing team or playbook): ${row.id}`);
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return teams;
}

function readTeamName(row) {
  const p = row.properties ?? {};
  // Prefer an explicit "Team" property, else fall back to the row's title (e.g. "Name").
  const t = p.Team ?? p.team ?? Object.values(p).find((x) => x?.type === "title");
  if (!t) return null;
  if (t.type === "title") return slug(t.title?.map((x) => x.plain_text).join(""));
  if (t.type === "select") return slug(t.select?.name);
  if (t.type === "rich_text") return slug(t.rich_text?.map((x) => x.plain_text).join(""));
  return null;
}

function readPlaybookPageId(row) {
  const p = row.properties ?? {};
  const pb = p.Playbook ?? p.playbook;
  if (pb?.type === "relation" && pb.relation?.[0]?.id) return pb.relation[0].id;
  if (pb?.type === "url" && pb.url) return extractPageId(pb.url);
  if (pb?.type === "rich_text") {
    // A pasted link or an @-mention of the page.
    for (const rt of pb.rich_text ?? []) {
      if (rt.type === "mention" && rt.mention?.type === "page") return rt.mention.page.id;
      const id = extractPageId(rt.href ?? rt.text?.link?.url ?? rt.plain_text);
      if (id) return id;
    }
  }
  return null;
}

// The Zendesk app must normalize the selected team name the same way.
function slug(s) {
  return s ? s.trim().toLowerCase().replace(/\s+/g, "-") || null : null;
}

function extractPageId(url) {
  const m = String(url).match(/([0-9a-f]{32})/i);
  return m ? m[1] : null;
}

// --- Zendesk: upsert one custom object record by external_id ---
// "Set Custom Object Record by External Id": PATCH with ?external_id= creates
// the record if it doesn't exist, otherwise updates it.
// https://developer.zendesk.com/api-reference/custom-data/custom-objects/custom_object_records/
async function upsertRecord(externalId, fields) {
  const url =
    `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/custom_objects/` +
    `${encodeURIComponent(ZENDESK_OBJECT_KEY)}/records?external_id=${encodeURIComponent(externalId)}`;

  const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString("base64");
  const body = {
    custom_object_record: {
      name: externalId,
      custom_object_fields: fields, // e.g. { content: "...", team: "support" }
    },
  };

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "PATCH",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return;
    if (res.status === 429 && attempt < 5) {
      const retryAfter = Number(res.headers.get("retry-after")) || 2 ** attempt;
      console.warn(`Zendesk 429 on "${externalId}"; retrying in ${retryAfter}s`);
      await sleep(retryAfter * 1000);
      continue;
    }
    const detail = await res.text();
    if (res.status === 404) {
      // Tell "object doesn't exist" apart from "endpoint/record problem".
      const probe = await fetch(
        `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/custom_objects/${encodeURIComponent(ZENDESK_OBJECT_KEY)}`,
        { headers: { Authorization: `Basic ${auth}` } },
      );
      if (probe.status === 404) {
        throw new Error(
          `Zendesk custom object "${ZENDESK_OBJECT_KEY}" not found. Create it in Admin Center -> ` +
            `Objects and rules -> Custom objects, or set ZENDESK_OBJECT_KEY to its key.`,
        );
      }
    }
    throw new Error(`Zendesk upsert "${externalId}" failed: ${res.status} ${detail}`);
  }
}

// Zendesk measures the 32 KB cap on the JSON-encoded record. Budget well under
// it, counting each character as it would be escaped (non-ASCII as \uXXXX).
const CHUNK_BUDGET = 24_000;
const encodedSize = (str) => JSON.stringify(str).replace(/[^\x00-\x7f]/g, "\\uXXXX").length;

// Split on paragraph breaks where possible; hard-split any oversized paragraph.
function splitIntoChunks(text) {
  const chunks = [];
  let cur = "";
  for (const para of text.split(/(?<=\n\n)/)) {
    if (encodedSize(cur + para) <= CHUNK_BUDGET) {
      cur += para;
      continue;
    }
    if (cur) chunks.push(cur);
    cur = "";
    let rest = para;
    while (encodedSize(rest) > CHUNK_BUDGET) {
      let cut = Math.floor(rest.length / 2);
      let step = cut;
      // Largest prefix that fits (binary search on length).
      while (step > 1) {
        step = Math.ceil(step / 2);
        cut += encodedSize(rest.slice(0, cut)) > CHUNK_BUDGET ? -step : step;
      }
      while (encodedSize(rest.slice(0, cut)) > CHUNK_BUDGET) cut--;
      // Don't split a surrogate pair.
      if (/[\ud800-\udbff]/.test(rest[cut - 1])) cut--;
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    cur = rest;
  }
  if (cur || !chunks.length) chunks.push(cur);
  return chunks;
}

// Write chunks first, then the index, so readers never see an index that
// points past the chunks written so far. Leftover chunks beyond N from an
// earlier, longer sync are harmless: readers stop at N.
async function writeBlock(block, content, extraFields = {}) {
  const chunks = splitIntoChunks(content);
  for (let i = 0; i < chunks.length; i++) {
    await upsertRecord(`${block}#${i + 1}`, { content: chunks[i], ...extraFields });
  }
  await upsertRecord(block, { content: JSON.stringify({ chunks: chunks.length }), ...extraFields });
  console.log(`Synced "${block}" (${content.length} chars in ${chunks.length} chunk(s))`);
}

// Read a block back exactly the way the Zendesk app does: list records filtered
// by external_id (index first, then its chunks) and join the chunk contents.
async function fetchRecordContents(externalIds) {
  const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString("base64");
  const out = {};
  for (let i = 0; i < externalIds.length; i += 100) {
    const batch = externalIds.slice(i, i + 100);
    const url =
      `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/custom_objects/` +
      `${encodeURIComponent(ZENDESK_OBJECT_KEY)}/records?page[size]=100` +
      `&filter[external_ids]=${encodeURIComponent(batch.join(","))}`;
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) throw new Error(`Zendesk read-back failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    for (const r of json.custom_object_records ?? []) {
      if (batch.includes(r.external_id)) out[r.external_id] = r.custom_object_fields?.content ?? "";
    }
  }
  return out;
}

async function verifyBlock(block, expected) {
  const index = await fetchRecordContents([block]);
  if (index[block] === undefined) throw new Error(`Read-back: index record "${block}" not found`);
  const { chunks } = JSON.parse(index[block]);
  const ids = Array.from({ length: chunks }, (_, i) => `${block}#${i + 1}`);
  const parts = await fetchRecordContents(ids);
  const missing = ids.filter((id) => parts[id] === undefined);
  if (missing.length) throw new Error(`Read-back: "${block}" is missing ${missing.join(", ")}`);
  if (ids.map((id) => parts[id]).join("") !== expected) {
    throw new Error(`Read-back: "${block}" content does not match what was written`);
  }
  console.log(`Verified "${block}" reads back intact (${chunks} chunk(s))`);
}

async function main() {
  // Shared block: A + B + D. Fetched sequentially to stay gentle on Notion's
  // ~3 req/s limit (each page fans out into many block calls internally).
  const a = await pageToMarkdown(SHARED_PAGE_A);
  const b = await pageToMarkdown(SHARED_PAGE_B);
  const d = await pageToMarkdown(SHARED_PAGE_D);

  const shared = [
    "## Part A - Reply Writing & Tone Standards\n\n" + a,
    "## Part B - Role, Workflow & Output Specification\n\n" + b,
    "## Part D - Help Center Article Directory\n\n" + d,
  ].join("\n\n---\n\n");

  await writeBlock("shared", shared);
  await verifyBlock("shared", shared);

  // Per-team Part C. One team failing shouldn't block the others.
  const teams = await getTeams();
  const failures = [];
  for (const { team, pageId } of teams) {
    try {
      const c = await pageToMarkdown(pageId);
      const content = "## Part C - Team Playbook\n\n" + c;
      await writeBlock(`part_c:${team}`, content, { team });
      await verifyBlock(`part_c:${team}`, content);
    } catch (err) {
      console.error(`Failed "part_c:${team}":`, err);
      failures.push(team);
    }
  }

  console.log(`Done. shared + ${teams.length - failures.length}/${teams.length} team playbook(s).`);
  if (failures.length) throw new Error(`Failed teams: ${failures.join(", ")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
