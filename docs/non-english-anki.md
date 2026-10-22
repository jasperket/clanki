# Using Anki in a language other than English

Anki translates the names of its built-in note types, and their fields, when a
collection is created — a German collection has `Einfach` with the fields
`Vorderseite` and `Rückseite`, not `Basic` with `Front` and `Back`. Clanki finds
them by their structure rather than their names, so this works with no setup
whatever language you use.

If your collection contains several note types that look alike, Clanki cannot
tell which you meant. It stops and lists the candidates rather than guessing,
because guessing wrong would write your text into a field that does not exist,
and Anki discards it without an error. Name the one you want:

| Variable | What it does |
| --- | --- |
| `CLANKI_BASIC_NOTE_TYPE` | Note type for ordinary two-sided notes, e.g. `Einfach` |
| `CLANKI_CLOZE_NOTE_TYPE` | Note type for cloze notes, e.g. `Lückentext` |
| `CLANKI_BASIC_FIELDS` | Its two fields, front first, e.g. `Vorderseite,Rückseite` |
| `CLANKI_CLOZE_FIELDS` | Its two fields, text first, e.g. `Text,Extra` |

Naming the note type is usually enough — Clanki reads its fields from your
collection in order. The `_FIELDS` variables are only needed for a note type
whose fields are not in front-then-back order. Both are checked against your
collection at startup, so a typo is reported rather than silently losing content.

For where to set these variables in your client, see
[Configuration in the README](../README.md#configuration).
