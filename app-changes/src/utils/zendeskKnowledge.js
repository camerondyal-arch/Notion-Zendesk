// Reads the compiled playbooks that the GitHub Action syncs from Notion into
// the Zendesk custom object. Each block is stored as an index record
// ("shared", "part_c:<team>") whose content is {"chunks": N}, plus chunk
// records "<block>#1".."<block>#N" that are joined in order.
const OBJECT_KEY = 'support_prompt';
const PAGE_SIZE = 100;

// Must match slug() in the sync: trim, lowercase, whitespace runs -> "-".
export function teamSlug(team) {
  return String(team || '').trim().toLowerCase().replace(/\s+/g, '-');
}

async function fetchRecordContents(externalIds) {
  var contents = {};
  for (var i = 0; i < externalIds.length; i += PAGE_SIZE) {
    var batch = externalIds.slice(i, i + PAGE_SIZE);
    var url = '/api/v2/custom_objects/' + OBJECT_KEY + '/records?page[size]=' + PAGE_SIZE +
      '&filter[external_ids]=' + encodeURIComponent(batch.join(','));
    var response;
    try {
      response = await window.zafClient.request({ url: url, type: 'GET' });
    } catch (error) {
      var details = error && error.responseJSON ? error.responseJSON : error;
      throw new Error('Could not read playbooks from Zendesk (' + OBJECT_KEY + '). ' + JSON.stringify(details) +
        ' Check that agents have view access to the Support Prompt custom object.');
    }
    var records = response && response.custom_object_records ? response.custom_object_records : [];
    for (var j = 0; j < records.length; j++) {
      var record = records[j];
      if (batch.indexOf(record.external_id) === -1) continue;
      var fields = record.custom_object_fields || {};
      contents[record.external_id] = fields.content || '';
    }
  }
  return contents;
}

function chunkIds(block, index) {
  var count = 0;
  try { count = JSON.parse(index).chunks || 0; } catch (e) { count = 0; }
  var ids = [];
  for (var i = 1; i <= count; i++) ids.push(block + '#' + i);
  return ids;
}

function joinChunks(block, ids, contents) {
  var parts = [];
  for (var i = 0; i < ids.length; i++) {
    if (contents[ids[i]] === undefined) {
      throw new Error('Playbook "' + block + '" is incomplete in Zendesk (missing ' + ids[i] + '). Try again in a minute; a sync may be in progress.');
    }
    parts.push(contents[ids[i]]);
  }
  return parts.join('');
}

export async function loadZendeskKnowledge(team) {
  var partCBlock = 'part_c:' + teamSlug(team);
  var indexes = await fetchRecordContents(['shared', partCBlock]);
  if (indexes.shared === undefined) {
    throw new Error('No shared playbook found in Zendesk. Check that the Notion → Zendesk sync has run.');
  }
  var sharedIds = chunkIds('shared', indexes.shared);
  var partCIds = indexes[partCBlock] === undefined ? [] : chunkIds(partCBlock, indexes[partCBlock]);
  var contents = await fetchRecordContents(sharedIds.concat(partCIds));
  var partC = joinChunks(partCBlock, partCIds, contents);
  return {
    shared: joinChunks('shared', sharedIds, contents),
    partC: partC,
    partCIncluded: partC.length > 0
  };
}
