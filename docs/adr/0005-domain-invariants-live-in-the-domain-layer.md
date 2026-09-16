# Domain invariants live in the domain layer

`validateTags` sits in `src/notes.ts` next to `validateClozeText`, not as a Zod
`.refine()` on the six tag schemas in `src/index.ts`. The Zod schemas stay
`z.array(z.string()).optional()`.

The split is: Zod validates **shape** (is this an array of strings), `notes.ts`
validates **meaning** (is this a usable Tag). That is already how this repo
works — Cloze syntax is checked in `notes.ts`, the media filename allowlist in
`media.ts`, and `src/index.ts` contains no `.regex()`, `.refine()`, `.trim()` or
`.transform()` at all. Keeping semantic rules out of the schemas means they
guard `buildBasicNote`, `buildClozeNote` and `buildNoteUpdate` against any
future non-MCP caller importing `notes.ts` directly, and they stay testable as
plain functions.

It also avoids a defect in the Zod error path. `src/index.ts` formats a
`ZodError` as `` `${e.path.join(".")}: ${e.message}` `` joined with `", "`. That
renders `cards[3].tags[1]` as `cards.3.tags.1`, where an array index is
indistinguishable from an object key named `3`, and the separator is unescaped,
so a message containing a comma looks like the boundary between two failures. A
plain `Error` thrown from `notes.ts` sidesteps both. **`validateTags`' message
must still contain no comma**, because a caller may route it through that join.

## What the Tag rule actually is

Probed against a live collection, because Anki does not document a Tag grammar
and the rule turned out not to be the obvious one. Every codepoint JavaScript's
`\s` matches was tested individually. Four distinct behaviours:

| Behaviour | Codepoints | Effect |
|---|---|---|
| **Split** | `U+0020`, `U+3000` | one Tag becomes two |
| **Deleted** | `U+0009` `U+000A` `U+000B` `U+000C` `U+000D` | character removed, Tag welded: `aa<TAB>bb` stores as `aabb` |
| **Normalised** | `U+2000`→`U+2002`, `U+2001`→`U+2003` | stored, but as different bytes than sent |
| **Unchanged** | the other 20, incl. `U+00A0` `U+1680` `U+2002`–`U+200A` `U+2028` `U+2029` `U+202F` `U+205F` `U+FEFF` `U+200B` `U+0085` | stored exactly as sent |

So `TAG_SPLITTING_CHARS` and `TAG_STRIPPED_CHARS` are explicit sets.

**Do not replace them with `/\s/`.** It is wrong in both directions: it matches
20 codepoints Anki stores perfectly well, so it would reject valid Tags, and it
would describe tab and newline as "splitting" when Anki deletes them — teaching
the caller a wrong model of what went wrong. `/\s/` is the obvious
simplification and it is the one to refuse.

Also probed and deliberately **not** rejected, because Anki handles each without
corrupting anything: leading and trailing whitespace (stripped), empty and
all-whitespace Tags (dropped), duplicates on one Note (deduped), quotes, `::`
hierarchies, non-ASCII letters, and a 300-character Tag. Refusing these would
fail calls that do no harm. Tag case is folded to whatever the collection saw
first (`biology` becomes `Biology` if that already exists), so tests must never
assert a Tag's casing.

## Why the message names the offending Tag

[ADR 0003](./0003-search-results-echo-bounded-note-content.md) says error
messages do not interpolate Note content. Its stated test is "where the content
adds nothing a position index cannot say" — and for a Tag, that test fails. The
position says *which* Tag is wrong but not what to write instead, and the fix
depends on the value. Without it the caller, usually a model mid-task, has to
guess between `organic_chemistry`, `organic::chemistry` and `OrganicChemistry`;
different sessions guess differently, which fragments a Tag hierarchy — a milder
form of the bug being prevented.

So this narrows ADR 0003 rather than contradicting it. The echo is bounded the
way `media.ts` bounds a rejected URL, with one difference: `media.ts` *drops*
characters outside its allowlist, but here the offending character is the point
of the message, so splitting and stripping characters are rendered **visible**
as `\uXXXX` escapes instead. A newline therefore appears as six literal
characters and cannot forge a line of tool output. Past the display cap the
message describes the fix instead of printing a truncated suggestion, which
would not be a Tag the caller could send.

## Correction of record

[Issue #9](https://github.com/jasperket/clanki/issues/9) was filed as a
create/update asymmetry: `update-card` joined tags with spaces before calling
`replaceTags`, while `create-card` passed the array to `addNote` untouched. That
asymmetry never existed. Anki splits a Tag on its spaces itself, so the join was
a redundant second split in front of Anki's own, and both paths were always
affected. PR #14 removed the join and changed nothing observable.

There was also never any corrupt state to repair: because Anki splits at storage
time, `notesInfo` cannot return a Tag containing a space, so the read path only
ever saw clean tokens.

## Limits

One Anki version, one profile, one platform, observed behaviour rather than
documented grammar. Anki could change any of this in a release. The tests in
`src/notes.test.ts` are what would catch it — in particular the one asserting
that NBSP and friends are **accepted**, which fails the moment someone widens
the character sets.
