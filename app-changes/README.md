# Zendesk app changes

These changes switch the Ticket summary app from calling Notion on every draft to reading the playbooks the sync stores in Zendesk. They also cache the playbooks with Claude, so repeat drafts cost less.

## Files

| File in the app | What to do |
|---|---|
| `src/utils/zendeskKnowledge.js` | **New.** Copy it in from `src/utils/zendeskKnowledge.js` here. |
| `src/utils/promptBuilder.js` | **Replace** it with the version here. |
| `src/utils/claudeApi.js` | **Replace** it with the version here. |
| `src/App.jsx` | Make the three edits below. |
| `src/utils/notionApi.js` | No longer used. Leave it for now, and delete it once the new version is working. |

## `App.jsx` edits

**1. Imports.** Find:

```js
import { loadNotionKnowledge } from './utils/notionApi.js';
```

Replace with:

```js
import { loadZendeskKnowledge } from './utils/zendeskKnowledge.js';
```

**2. Inside `loadAndAnalyze`.** Find:

```js
      const notionStart = performance.now();
      const notionKnowledge = await loadNotionKnowledge(team);
      const notionRetrievalMs = performance.now() - notionStart;

      const promptStart = performance.now();
      const notionSystemPrompt = buildNotionSystemPrompt(team, notionKnowledge);
      const promptCreationMs = performance.now() - promptStart;

      const claudeStart = performance.now();
      const result = await analyzeTicketWithClaude(ctx, collectedAttachments, uploadedFiles, apiKey, notionSystemPrompt);
      const claudeWaitMs = performance.now() - claudeStart;
      setTimings({ notionRetrievalMs, promptCreationMs, claudeWaitMs });
```

Replace with:

```js
      const notionStart = performance.now();
      const notionKnowledge = await loadZendeskKnowledge(team);
      const notionRetrievalMs = performance.now() - notionStart;

      const promptStart = performance.now();
      const notionSystemPrompt = buildNotionSystemPrompt(team, notionKnowledge);
      const promptCreationMs = performance.now() - promptStart;

      const claudeStart = performance.now();
      const result = await analyzeTicketWithClaude(ctx, collectedAttachments, uploadedFiles, apiKey, notionSystemPrompt);
      const claudeWaitMs = performance.now() - claudeStart;
      const cachedTokens = result.usage ? (result.usage.cache_read_input_tokens || 0) : null;
      setTimings({ notionRetrievalMs, promptCreationMs, claudeWaitMs, cachedTokens });
```

**3. The timing panel.** Find:

```jsx
          <TimingRow>
            <TimingLabel>Notion retrieval</TimingLabel>
```

Replace with:

```jsx
          <TimingRow>
            <TimingLabel>Playbook retrieval</TimingLabel>
```

Then find:

```jsx
          <TimingRow>
            <TimingLabel>Claude response wait</TimingLabel>
            <TimingValue>{(timings.claudeWaitMs / 1000).toFixed(2)} s</TimingValue>
          </TimingRow>
```

Add this right after it:

```jsx
          {timings.cachedTokens !== null && (
            <TimingRow>
              <TimingLabel>Cached prompt tokens</TimingLabel>
              <TimingValue>{timings.cachedTokens.toLocaleString()}</TimingValue>
            </TimingRow>
          )}
```

## Zendesk permissions

The app reads the records as the agent who is using it. Agents therefore need **view** access to the Support Prompt custom object. If drafting fails with "Could not read playbooks from Zendesk", grant that access under **Admin Center → Objects and rules → Custom objects → Support Prompt**, or in the agent role's custom object permissions.

## What changes for agents

- **Faster drafts:** "Playbook retrieval" should drop from many seconds (walking Notion) to a fraction of a second (two Zendesk reads).
- **Cheaper repeat drafts:** the shared playbook, and then the team's Part C, are cached with Claude for an hour. "Cached prompt tokens" is 0 on the first draft and should be large on later drafts within the hour.
- **Teams without a Part C:** every team in the dropdown still drafts. If a team has no row in the Notion Playbook Directory, the prompt says so and relies on Parts A, B and D.
- **Different part order:** the prompt now goes instructions, Parts A, B and D, then the selected team and its Part C. Before, it went instructions, team, then A, B, C and D. The order changed so the shared part can be cached across every team and ticket.
