# Non-idempotent actions are not retried

`ankiRequest` retries a transport failure three times with backoff. `addNote` and
`addNotes` are exempt: they get one attempt, and a failure becomes an
`UnconfirmedWriteError` rather than a resend.

A lost response is a transport failure. If Anki commits an `addNotes` batch and
the reply never arrives — socket reset, timeout, Anki busy — the retry sends the
same batch again and every Note is added a second time, silently. AnkiConnect has
no idempotency key and no request id, so neither side can tell a retry from a new
call. The bulk paths send a whole batch in one `addNotes`, so the damage is a
duplicated batch of arbitrary size rather than one stray Note.

## What the rule actually is

An action is exempt from retries when **sending it twice produces a different
collection than sending it once**. That is a property of the action — not of how
likely a retry is, and not of how destructive the action is.

| Action | Retried? | Why |
|---|---|---|
| `addNotes` | no | mints new Note ids each call; a resend is a second batch |
| `addNote` | no | the same property at N=1 |
| `createDeck` | yes | returns the existing Deck's id for a name already present |
| `deleteNotes` | yes | succeeds silently on an id already gone, so twice equals once |
| `updateNoteFields`, `updateNote`, `replaceTags` | yes | the same write twice leaves the same state |
| `findNotes`, `notesInfo`, `deckNames`, `canAddNotesWithErrorDetail`, `version` | yes | reads |

`deleteNotes` is the entry to read twice. It is the most destructive action this
server sends and it is still retried, because **idempotence is the criterion, not
danger**. Adding it to the exempt set would convert a recoverable network blip
into a failed deletion and prevent nothing. `src/ankiConnect.test.ts` asserts this
specifically, so the decision fails loudly rather than drifting.

## Why the error wording carries the fix

Not retrying does not remove the ambiguity. It moves it: the code no longer
resolves it wrongly and silently, and the caller now sees it and must decide.

That makes the message the deliverable rather than a detail. The caller here is
usually an AI assistant, and an assistant that reads "failed" resends the batch —
which is exactly the duplicate this change exists to prevent. So the message from
`addNoteBatch`:

- says the outcome is **not known**, never "failed";
- says the Notes **may already be in the deck**;
- names the check to run — `find-cards` with the actual Deck, quoted — so the
  caller does not have to work out how;
- keeps the underlying transport error so the cause is not lost.

`ankiConnect.ts` throws `UnconfirmedWriteError` with a transport-level message and
names no MCP tool; `addNoteBatch` in `index.ts` catches it and writes the
caller-facing wording, because that is where tool names belong. The class exists
so the caller can recognise the case with `instanceof` rather than by matching
message text — the same reason `AnkiConnectError` is a class. The two are
opposites and must not be merged: `AnkiConnectError` means Anki answered and
refused, so nothing was written; `UnconfirmedWriteError` means Anki did not
answer at all. The `instanceof AnkiConnectError` check therefore has to stay
ahead of the `UnconfirmedWriteError` throw in the retry loop, or a plain verdict
would be reported as a possible duplicate.

## Rejected alternatives

**A real idempotency key.** AnkiConnect exposes no request id and no "apply this
batch once" parameter. The nearest approximations — a marker Tag, or a convention
in the first Field — would leak into the user's collection to solve a problem the
user never asked about.

**Always pre-check with `canAddNotesWithErrorDetail`.** `addNoteBatch` already
does this, and it partially covers the duplicate case. It is not a guarantee: the
collection can change between the check and the send, and it does nothing for a
Note Type whose duplicate detection does not apply to the first Field. It is a
side effect of duplicate handling, not a safety property.

**Retry, then reconcile.** Query what actually landed and delete the extras. Far
more machinery, it would issue deletions the user never asked for, and it fires
on precisely the path where Anki is least likely to answer a follow-up query.

**Make each call site pass `retries: 1`.** Puts the safety property at every call
site, where a single omission reopens the bug. The set keeps one owner. For the
same reason an explicit `retries` argument is *overridden* for a non-idempotent
action rather than respected — a caller must not be able to opt back in.

## Limits

This narrows the window; it does not close it. A response lost on the single
remaining attempt is still ambiguous, and nothing in this API can make it
otherwise. What the change buys is the replacement of a **silent duplicate** with
a **loud unknown**, which is the best available outcome — and the reason the
wording, rather than the retry count, is where the work went.

One behaviour change worth knowing: an HTTP 500 is not an `AnkiConnectError`, so
it used to be retried and often succeeded. It now produces the unconfirmed-write
message on `addNotes`. That is the correct conservative reading — a 500 may well
mean Anki processed the request — but it does change the message for a case that
previously self-healed.
