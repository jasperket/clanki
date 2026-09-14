# Clanki

An MCP server that lets an AI assistant create and edit Anki flashcards through
the AnkiConnect add-on. This glossary fixes the vocabulary for that domain,
because Anki's own terms overlap with everyday flashcard language in ways that
have already caused bugs in this repo.

## Language

**Deck**:
A named collection of Notes. Nested decks are expressed with `::` in the name.
_Avoid_: collection (in Anki that means the entire database, not one deck)

**Note**:
The record that holds field values. Every tool in this server creates or edits
Notes, never Cards.

**Card**:
A review item Anki generates from a Note. One Note produces one or more Cards,
and a Cloze Deletion produces one Card per deletion number. We never address
Cards individually — there is no `cardId` anywhere in this codebase.
_Avoid_: flashcard

**Note Type**:
The template that determines which Fields a Note has and how its Cards are
generated. This server only uses the two built-in types, `Basic` and `Cloze`.
_Avoid_: model (the AnkiConnect wire format calls this `modelName`; that name is
forced on us by the API and should not spread into our own prose or identifiers)

**Field**:
A named slot on a Note. `Basic` has `Front` and `Back`; `Cloze` has `Text` and
`Back Extra`. Field names are exact and case-sensitive, and AnkiConnect silently
discards values written to a Field the Note Type does not have.

**Tag**:
A label attached to a Note, not to a Card. Tags cannot contain spaces — Anki
treats a space as a separator between two Tags.

**Cloze Deletion**:
The `{{c1::...}}` construct inside a `Cloze` Note's `Text` Field. Each distinct
number generates its own Card.
_Avoid_: using this for the Note itself ("a cloze deletion" meaning the whole
card), or as a display placeholder

**Media**:
An image or audio file attached to a Note by URL. AnkiConnect downloads the file
and appends a reference tag to the end of the named Field; this server never
fetches the file itself.

## A note on Card vs Note

The MCP tool names (`create-card`, `update-cloze-card`, ...) say **Card** even
though they all operate on **Notes**. This is deliberate and is recorded in
[ADR 0002](./docs/adr/0002-tool-names-say-card-internals-say-note.md). Use
**Note** everywhere else: in identifiers, comments, log lines, and counts.
