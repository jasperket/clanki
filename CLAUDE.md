## Agent skills

### Issue tracker

Issues live in GitHub Issues on `jasperket/clanki`, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Testing this server against real Anki

This repo's own server is installed as a local-scope MCP server named `clanki`,
pointing at `build/index.js`. Use it to verify changes against a real
collection instead of reasoning about what AnkiConnect would do.

```bash
npm run build   # the MCP server runs build/index.js, so rebuild before testing
```

Its tools appear as `mcp__clanki__create-card`, `mcp__clanki__create-deck`,
`mcp__clanki__create-cloze-card`, `mcp__clanki__create-cards-bulk`,
`mcp__clanki__create-cloze-cards-bulk`, `mcp__clanki__update-card` and
`mcp__clanki__update-cloze-card`. Decks are exposed as a **resource**
(`anki://deck/<name>`), not a tool — there is no `list-decks`.

MCP servers load at session start, so a server installed mid-session is not
available until the session restarts. To drive it from a running session,
spawn a headless one and pass the tools explicitly:

```bash
claude -p "<prompt>" --allowedTools "mcp__clanki__create-card" "mcp__clanki__create-deck"
```

Tool responses are plain success strings that do not echo stored values, so
they confirm only that the call did not error. To confirm what actually landed
in the collection, query AnkiConnect directly on `http://127.0.0.1:8765`
(`findNotes`, then `notesInfo`) and inspect the fields.

**Rules when testing against a live collection:**

- Requires Anki running with AnkiConnect; otherwise tools return a connection
  error rather than the behavior under test.
- Create a throwaway deck, never write to the user's real decks.
- Clean up afterwards: `deleteMediaFile` for generated media (they are named
  `image_*` / `audio_*`), then `deleteNotes`, then `deleteDecks`.
- Anki writes to a real collection — ask before creating or deleting anything
  the user did not ask you to touch.
