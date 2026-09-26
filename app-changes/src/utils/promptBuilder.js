const NOTION_PROMPT_INSTRUCTIONS = `You are an internal drafting assistant for Anrok customer support. Produce a concise markdown-formatted suggested response that a human teammate reviews before sending.

Use Parts A through D as the source of truth. If an exact article or procedure is not verified in those Notion sources, link to the verified article only and do not invent steps, labels, URLs, dates, tax treatment, contacts, or outcomes.

Hard rules:
- Start the Suggested reply with Hi [requester first name], or Hi there, when no requester name is available.
- Do not provide tax advice or select tax categories. Direct tax-treatment questions to a qualified tax professional.
- Keep Technical Solutions separate from Engineering. Technical Solutions follows up directly with the customer.
- Do not use generic question-closing phrases or fault-implying language.
- Do not include a signature block.
- Ignore PDFs over 100 pages and state that they were skipped when relevant.

Return these sections in order: Category, Confidence, Next actions, Information gaps, Escalation, Internal notes, Phrase check, and Suggested reply.`;

// Returns system blocks ordered for prompt caching: the instructions and the
// shared Parts A/B/D are identical for every team and every ticket, so they go
// first and are cached; the team's Part C follows with its own breakpoint.
// Nothing that varies per ticket belongs in here.
export function buildNotionSystemPrompt(team, knowledge) {
  var shared = knowledge && knowledge.shared ? knowledge.shared : '';
  var stable = shared
    ? NOTION_PROMPT_INSTRUCTIONS + '\n\n' + shared
    : NOTION_PROMPT_INSTRUCTIONS + '\n\nNo Notion playbook content was loaded. Do not invent procedures or article links.';

  var teamSection = ['Selected Team: ' + (team || 'Not selected'), ''];
  if (knowledge && knowledge.partCIncluded) {
    // The sync already prefixes this with a "## Part C - Team Playbook" heading.
    teamSection.push(knowledge.partC);
  } else {
    teamSection.push('No Part C playbook is available for the ' + (team || 'selected') + ' team yet. Rely on Parts A, B and D, and flag anything team-specific as an information gap.');
  }

  return [
    { type: 'text', text: stable, cache_control: { type: 'ephemeral', ttl: '1h' } },
    { type: 'text', text: teamSection.join('\n'), cache_control: { type: 'ephemeral', ttl: '1h' } }
  ];
}
