# Tool names say "card", internals say "note"

Every tool this server exposes operates on Anki **Notes** (`addNote`,
`updateNoteFields`, `notesInfo`) and none addresses a Card, yet the tool names
are `create-card`, `update-card`, `create-cloze-card` and `update-cloze-card`.
We keep the "card" spelling in the public tool names because it is the word
users and Anki's own "Add Card" UI use, and renaming them would break every
saved prompt and MCP client config for no user-visible benefit.

Everywhere else — identifiers, comments, log lines and especially counts — we
say Note, because conflating the two produced a real bug: the deck resource
reported a note count as a number of cards, which is wrong for any deck holding
cloze notes. See [CONTEXT.md](../../CONTEXT.md) for the definitions.
