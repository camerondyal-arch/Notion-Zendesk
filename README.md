# Notion → Zendesk playbook sync

A scheduled GitHub Action compiles the Notion playbooks into per-team prompt blocks and upserts them into a Zendesk custom object. The Zendesk app reads those records at draft time, so Notion is never in the request path.

## What each record holds

| `external_id` | Content |
|---|---|
| `shared` | Part A + Part B + Part D (the same for every team) |
| `part_c:<team>` | That team's Part C (one record per team) |

The app assembles `shared` + `part_c:<selectedTeam>` + conversation. Stable content goes first so prompt caching stays warm across teams.

## One-time setup

### 1. Zendesk: create the custom object

In **Admin Center → Objects and rules → Custom objects**, create an object (for example, key `support_prompt`) with these fields:

- `content`: multi-line text (holds the compiled markdown)
- `team`: text (optional; only set on the per-team records)

The object key goes in `ZENDESK_OBJECT_KEY`.

Create an API token under **Admin Center → Apps and integrations → APIs → Zendesk API**. The sync authenticates as `{email}/token:{api_token}`.

> **Size check:** Zendesk text fields have a length cap. The full Part D (~220KB compiled) may not fit in one field. Trimming Part D to only the relevant links drops it to ~60–70KB, which stores comfortably. The sync logs each record's size, and Zendesk rejects an oversized upsert with a 4xx error.

### 2. Notion: get the IDs and grant access

- Copy the 32-character page IDs (the hex string) from the Part A, B, and D URLs.
- Put the team playbooks in a small database with one row per team. Give it a `Team` property (title, select, or text) and a `Playbook` property (a relation to the Part C page, or a URL). The sync reads this database, so adding a team needs no code change. Note the database ID.
- Share your Notion integration with every page and the database (**••• → Connections**). Otherwise fetches come back empty.

### 3. GitHub: secrets

Set these under **Settings → Secrets and variables → Actions**, or with the `gh` CLI:

```bash
gh secret set NOTION_API_KEY
gh secret set NOTION_PLAYBOOK_DB_ID
gh secret set SHARED_PAGE_A
gh secret set SHARED_PAGE_B
gh secret set SHARED_PAGE_D
gh secret set ZENDESK_SUBDOMAIN      # e.g. "acme" for acme.zendesk.com
gh secret set ZENDESK_EMAIL
gh secret set ZENDESK_API_TOKEN
gh secret set ZENDESK_OBJECT_KEY     # optional; defaults to "support_prompt"
```

### 4. Run it

- **Actions → Sync Notion playbooks to Zendesk → Run workflow**, or wait for the 30-minute cron.
- Check that the custom object records appear and that `content` looks right.

To run locally, export the same variables and run `npm ci && npm run sync`.

## App-side change

Where the app builds the prompt today, read from the custom object instead of Notion:

1. Read the record with external ID `shared`.
2. Read `part_c:<selectedTeam>`. Normalize the team name the same way the sync does: trim, lowercase, and replace runs of whitespace with `-`.
3. Send `shared` + `part_c:<team>` + conversation to Claude, in that order.
4. Add a prompt-cache breakpoint after `shared`, and optionally another after Part C.

## Adjusting to your setup

- The team registry is read from the team name in the title column (or a `Team` property) and the Part C page from `Playbook`, which can be a relation, a URL, or a text field holding a link or @-mention. See `readTeamName` and `readPlaybookPageId` in `sync.js`.
- Optional: skip pages whose `last_edited_time` hasn't changed since the last run (store the timestamps in a record) to avoid re-walking unchanged pages.
