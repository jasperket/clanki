# Clanki

An MCP server that lets an AI assistant create and edit Anki flashcards through
the AnkiConnect add-on. This glossary fixes the vocabulary for that domain,
because Anki's own terms overlap with everyday flashcard language in ways that
have already caused bugs in this repo.

## Language

**Deck**:
A named collection of Notes. Nested Decks are expressed with `::` in the name:
`Biology::Cells` is a Deck named `Cells` inside one named `Biology`, and Anki
creates the parent if it does not exist. The separator is Anki's and has no
escape, so a Deck cannot be named literally `Biology::Cells`. An empty path
segment becomes the literal word `blank` (`::a` is stored as `blank::a`), and
whitespace around a separator is trimmed (`a :: b` is stored as `a::b`). An
empty or all-whitespace name is not refused either -- it produces a Deck named
`blank` -- so `validateDeckName` rejects it before Anki invents one. Unlike a
Tag, a Deck name may contain a space. The probed behaviour is re-checkable with
`npm run probe:decks`.
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
generated. Anki translates the names of its built-in Note Types per collection,
so this server never assumes one is called `Basic` or `Cloze`.
_Avoid_: model (the AnkiConnect wire format calls this `modelName`; that name is
forced on us by the API and should not spread into our own prose or identifiers)

**Note Type Role**:
One of exactly two jobs this server needs done: `basic` or `cloze`. A Role is
ours and is never translated. A Role is not a Note Type name — that distinction
is the whole point, because the Note Type filling a Role differs per collection.

**Fills**:
The relation between the two. In a German collection, `Einfach` fills the basic
Role and `Lückentext` fills the cloze Role.

**Resolution**:
Working out which Note Type fills each Role, by structure rather than by name.
Yields that Note Type's Field names at the same time, since AnkiConnect returns
a Note Type's Fields alongside it.

**Ambiguous Collection**:
A collection offering more than one candidate for a Role. Resolution stops and
asks the user to name one, rather than guessing — see
[ADR 0004](./docs/adr/0004-note-types-are-resolved-by-role.md).

**Field**:
A named slot on a Note. Field names come from whichever Note Type fills the Role
and are read from the collection at runtime, because Anki translates them too:
the Fields of the basic Role are `Front`/`Back` in English and
`Vorderseite`/`Rückseite` in German. Field names are exact and case-sensitive,
and AnkiConnect silently discards values written to a Field the Note Type does
not have.

**Tag**:
A label attached to a Note, not to a Card. A Tag cannot contain a space: Anki
treats one as a separator and stores `organic chemistry` as two Tags. A tab or
newline is worse — Anki removes it, welding the Tag into one word. Write
`organic_chemistry`, or `organic::chemistry` for a hierarchy. Anki also strips
leading and trailing whitespace, drops an empty or all-whitespace Tag, dedupes
Tags on a Note, and folds a Tag's case to whichever casing the collection saw
first, so a Tag's exact spelling is not the caller's to choose. Enforced by
`validateTags`; the probed behaviour is recorded in
[ADR 0005](./docs/adr/0005-domain-invariants-live-in-the-domain-layer.md).

**Cloze Deletion**:
The `{{c1::...}}` construct inside the first Field of a Note whose Note Type
fills the cloze Role. Each distinct number generates its own Card.
_Avoid_: using this for the Note itself ("a cloze deletion" meaning the whole
card), or as a display placeholder

**Rejected Note**:
A Note in a bulk request that the collection will not accept, identified by its
position in the caller's input and the reason Anki gave. Most often a duplicate
first Field; an empty first Field is another. `addNotes` is all-or-nothing, so
these are found with `canAddNotesWithErrorDetail` before sending.
_Avoid_: duplicate (that is one cause among several, not the category)

**Media**:
An image or audio file attached to a Note by URL. AnkiConnect downloads the file
and appends a reference tag to the end of the named Field; this server never
fetches the file itself.

## A note on Card vs Note

The MCP tool names (`create-card`, `update-cloze-card`, ...) say **Card** even
though they all operate on **Notes**. This is deliberate and is recorded in
[ADR 0002](./docs/adr/0002-tool-names-say-card-internals-say-note.md). Use
**Note** everywhere else: in identifiers, comments, log lines, and counts.
