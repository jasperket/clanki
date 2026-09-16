# Note Types are resolved by role, and ambiguity stops the request

Anki translates the names of its built-in Note Types, and their Fields, when a
collection is first created. A German collection has no `Basic` — it has
`Einfach`, whose Fields are `Vorderseite` and `Rückseite`. This server used to
write the English names into every request, so card creation failed for every
user whose Anki was not in English ([issue #4]); the reporter's workaround was to
switch Anki's language and start again.

We resolve the two Note Types we need from the user's own collection, by
structure, at runtime. `type: 1` marks a cloze-style Note Type; a Field count and
a template count separate the basic one from Anki's other two-Field built-ins.
Because AnkiConnect returns a Note Type's Fields alongside it, resolving the Note
Type resolves the Field names too — the localized-Field problem collapses into
the Note Type problem, and we solve it once.

**Not a translation table.** Mapping `Basic`→`Einfach`→`Basique` would need
around thirty locales kept in step with Anki upstream, would break whenever Anki
reworded a name, and would still fail for a user who renamed a Note Type
themselves. Structure survives translation; names do not.

**Ambiguity stops the request rather than guessing.** When a collection offers
more than one candidate for a Role, Resolution throws, names the candidates, and
tells the user which environment variable to set. Guessing is the more dangerous
option, and not symmetrically so: the wrong Note Type means writing to Fields it
does not have, and AnkiConnect discards those values while reporting success.
That is the failure mode that already cost this repo real user data (see the
Known Issue in README.md). A blocked user reads an error and sets a variable; a
user who gets a wrong guess gets empty Notes and no signal at all. So the
comparison is not "works sometimes" against "always works" — it is "blocked, with
instructions" against "silently empty".

For the same reason there is no ordering tiebreak. Picking the first candidate
would look like a heuristic and behave like a guess.

**The detection is deliberately fragile in one place.** Anki's `Basic`,
`Basic (and reversed card)` and `Basic (type in the answer)` all have two Fields,
so the basic Role is identified partly by a template not containing `{{type:` —
a test against a template's internals, which Anki could restyle. It is kept
because dropping it would make every stock non-English collection ambiguous, and
because it fails in the safe direction: a restyled template leaves an extra
candidate, Resolution stops, and the user names the Note Type. It cannot silently
select the wrong one.

**The read path does not use Resolution.** `find-cards` formats Notes from the
Fields `notesInfo` already returns, so it works in any language and keeps working
in an Ambiguous Collection. Depending on Resolution there would mean a user could
not list their Notes to discover which name to configure — the tool for
diagnosing the problem would fail for the same reason as the problem.

Resolution is lazy and cached for the life of the process, and the cache is
cleared on failure: an MCP server starts before Anki is necessarily running, so
resolving eagerly would turn "the user opens Anki a minute later" into a dead
server.

See [CONTEXT.md](../../CONTEXT.md) for Note Type Role, Fills, Resolution and
Ambiguous Collection.

[issue #4]: https://github.com/jasperket/clanki/issues/4
