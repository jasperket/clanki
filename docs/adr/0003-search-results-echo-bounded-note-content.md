# Search results echo bounded Note content

`validateClozeText` in `src/notes.ts` and `buildBulkSummary` both refuse to
interpolate Note content into the strings they return, and say so in comments:
tool output is read by the model as trusted, and Note text routinely originates
from an LLM reading an untrusted page — the injection vector
[ADR 0001](./0001-sanitize-media-filenames-ourselves.md) covers for media URLs.
`find-cards` returns Note content anyway. This looks like a violation of that
rule and is not.

The rule those comments state is about **error and summary messages**, where the
content adds nothing a position index cannot say. A search tool is different in
kind: "which of these Notes did I mean?" cannot be answered without showing
something from the Notes. Returning only ids and Tags would satisfy the tool's
narrowest purpose — obtaining a `noteId` — while making it useless for the job
callers actually have. The deck resource (`anki://deck/<name>`) already returns
full Note content today, so the precedent exists; a resource is fetched because
the client chose to, while a tool is called autonomously mid-task, which argues
for bounding the exposure rather than refusing it.

So `find-cards` shows Note content under two limits, both in `src/notes.ts`:
`SEARCH_FIELD_EXCERPT_LENGTH` caps each Field and strips its HTML, and
`SEARCH_RESULT_LIMIT` caps how many Notes are listed while still reporting the
true number of matches. The cap is not only a safety measure — `deck:Default`
against a large collection would otherwise return megabytes into the caller's
context.

Truncation lives in `truncateSummary`, deliberately separate from
`summarizeNote`, which both readers share. Folding the two together would
silently truncate the deck resource as well, changing a shipped surface under
cover of a refactor.

What has **not** changed: error paths still never echo Note content, and neither
does the "no matches" message.
