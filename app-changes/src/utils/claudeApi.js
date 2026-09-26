import { CLAUDE_API_URL, CLAUDE_MODEL, CLAUDE_MAX_TOKENS, CLAUDE_API_VERSION, SUPPORTED_IMAGE_TYPES, MAX_PDF_PAGES } from '../constants.js';

function normalizeMediaType(contentType) {
  return contentType ? contentType.split(';')[0].trim().toLowerCase() : null;
}

function countPdfPages(bytes) {
  if (!bytes || !bytes.length) return null;
  var binary = '';
  for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  var matches = binary.match(/\/Type\s*\/Page(?:\s|\/|>)/g);
  return matches ? matches.length : null;
}

function toBase64(bytes) {
  var binary = '';
  for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function fetchBinary(url) {
  try {
    var response = await fetch(url);
    if (response.ok) return new Uint8Array(await response.arrayBuffer());
  } catch (e) {
    console.warn('[claudeApi] attachment fetch failed:', e && e.message);
  }
  return null;
}

async function buildMessageContent(ticketContext, attachments, uploadedFiles) {
  var content = [{ type: 'text', text: ticketContext }];
  var ticketAttachments = attachments || [];
  for (var i = 0; i < ticketAttachments.length; i++) {
    var attachment = ticketAttachments[i];
    var mediaType = normalizeMediaType(attachment.contentType);
    if (SUPPORTED_IMAGE_TYPES.indexOf(mediaType) === -1 && mediaType !== 'application/pdf') continue;
    var bytes = await fetchBinary(attachment.contentUrl);
    if (!bytes) {
      content.push({ type: 'text', text: '[Attachment could not be fetched: ' + attachment.filename + ']' });
      continue;
    }
    if (mediaType === 'application/pdf') {
      var pages = countPdfPages(bytes);
      if (pages !== null && pages > MAX_PDF_PAGES) {
        content.push({ type: 'text', text: '[PDF skipped because it exceeds the ' + MAX_PDF_PAGES + '-page limit: ' + attachment.filename + ']' });
      } else {
        content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: toBase64(bytes) } });
      }
    } else {
      content.push({ type: 'text', text: '[Image attachment: ' + attachment.filename + ']' });
    }
  }
  (uploadedFiles || []).forEach(function(file) {
    if (file.kind === 'text') content.push({ type: 'text', text: '[Agent-uploaded file: ' + file.name + ']\n' + file.content });
  });
  return content;
}

function requestOptions(apiKey, body) {
  var options = {
    url: CLAUDE_API_URL,
    type: 'POST',
    contentType: 'application/json',
    data: JSON.stringify(body)
  };
  if (apiKey) {
    options.cors = true;
    options.headers = {
      'x-api-key': apiKey,
      'anthropic-version': CLAUDE_API_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
      'Content-Type': 'application/json'
    };
  } else {
    options.secure = true;
    options.headers = {
      'x-api-key': '{{setting.claudeApiKey}}',
      'anthropic-version': CLAUDE_API_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
      'X-Zendesk-UA-Override': 'none',
      'X-Requested-With': ''
    };
  }
  return options;
}

// The system prompt may be a string or an array of cached text blocks.
function systemPromptText(systemPrompt) {
  if (Array.isArray(systemPrompt)) return systemPrompt.map(function(block) { return block.text || ''; }).join('\n\n');
  return systemPrompt || '';
}

export async function analyzeTicketWithClaude(ticketContext, attachments, uploadedFiles, apiKey, systemPrompt) {
  var body = {
    model: CLAUDE_MODEL,
    max_tokens: CLAUDE_MAX_TOKENS,
    system: systemPrompt,
    messages: [{ role: 'user', content: await buildMessageContent(ticketContext, attachments, uploadedFiles) }]
  };
  var response = await window.zafClient.request(requestOptions(apiKey, body));
  var textBlock = response && response.content
    ? response.content.filter(function(block) { return block.type === 'text' && block.text; })[0]
    : null;
  if (!textBlock) throw new Error('Invalid response from Claude API: ' + JSON.stringify(response));
  return {
    rawMarkdown: textBlock.text,
    usage: response.usage || null,
    promptText: [
      '=== SYSTEM PROMPT ===',
      systemPromptText(systemPrompt),
      '',
      '=== USER MESSAGE TEXT ===',
      ticketContext || '',
      '',
      'Binary attachments are omitted from this copy.'
    ].join('\n')
  };
}

export async function generateHandoffNote(ticketContext, escalationText, orgName, apiKey) {
  var prompt = ['Write a concise internal handoff note.', 'Account: ' + (orgName || 'Not provided'), 'Ticket context:', ticketContext, 'Escalation:', escalationText, 'Output only the handoff note.'].join('\n\n');
  var body = {
    model: CLAUDE_MODEL,
    max_tokens: 512,
    system: 'You are a concise internal support assistant. Write factual handoff notes.',
    messages: [{ role: 'user', content: prompt }]
  };
  var response = await window.zafClient.request(requestOptions(apiKey, body));
  if (!response || !response.content || !response.content[0] || !response.content[0].text) throw new Error('Invalid response from Claude API: ' + JSON.stringify(response));
  return response.content[0].text.trim();
}

export function buildTicketContext(ticket, requester, formattedConversation, additionalContext, uploadedFiles, organization, orgExternalId, team) {
  var lines = [
    '=== TEAM ===', 'Selected team: ' + (team || 'Not selected'),
    '', '=== TICKET INFORMATION ===', 'Ticket ID: ' + (ticket.id || 'N/A'), 'Subject: ' + (ticket.subject || 'No subject'), 'Status: ' + (ticket.status || 'N/A'), 'Priority: ' + (ticket.priority || 'N/A'), 'Type: ' + (ticket.type || 'N/A'),
    '', '=== ORGANIZATION ===', 'Organization Name: ' + (organization && organization.name ? organization.name : 'N/A'), 'Organization External ID: ' + (orgExternalId || 'N/A'),
    '', '=== REQUESTER ===', 'Name: ' + (requester ? requester.name : 'N/A'), 'Email: ' + (requester ? requester.email : 'N/A'), 'Role: ' + (requester ? requester.role : 'N/A'),
    '', '=== DESCRIPTION ===', ticket.description || 'No description provided.', '', '=== CONVERSATION HISTORY ===', (formattedConversation || '').replace(/\s+/g, ' ').trim()
  ];
  if (additionalContext && additionalContext.trim()) lines.push('', '=== ADDITIONAL CONTEXT FROM AGENT ===', additionalContext.trim());
  if (uploadedFiles && uploadedFiles.length) lines.push('', '=== AGENT-UPLOADED FILES ===', uploadedFiles.map(function(file) { return '- ' + file.name; }).join('\n'));
  return lines.join('\n');
}
