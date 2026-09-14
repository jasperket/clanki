import type { MediaItem } from "./media.js";

// Anki's built-in Note Types have exact, case-sensitive Field names, and
// AnkiConnect silently discards a value written to a Field that does not exist
// — no error, the Note is created, and the content is simply gone. That failure
// mode has already cost real user data once (see the Known Issue in README.md),
// because the name was spelled inline at each call site and one of them was
// wrong.
//
// These constants exist so the names are written down once. Do not inline the
// strings back into callers: a typo there is invisible to TypeScript, because
// AnkiConnect's `fields` is an open Record<string, string> and every key type-
// checks.
export const BASIC_FIELD_FRONT = "Front";
export const BASIC_FIELD_BACK = "Back";
export const CLOZE_FIELD_TEXT = "Text";
export const CLOZE_FIELD_BACK_EXTRA = "Back Extra";

// A Cloze Deletion is `{{c<number>::...}}` (CONTEXT.md). Both halves of this
// pattern are load-bearing:
//
//   `c\d+::`  the number and separator. Without them "{{cat}}" matches, which
//             is text containing no deletion at all.
//   `\}\}`    the closing braces. Without them "{{c1::unclosed" matches, and
//             Anki renders it as literal text.
//
// Either way Anki generates zero Cards from the Note, so it is created,
// reported as a success, and can never be reviewed. `.*?` is lazy so two
// deletions on one line do not merge into one match, and the `s` flag lets a
// deletion span newlines, since the Field holds HTML.
//
// Deliberately not a full parse: Anki itself tolerates gaps in the numbering
// (c1 and c3 with no c2), so validating that would reject Notes the engine
// accepts.
const CLOZE_DELETION_PATTERN = /\{\{c\d+::.*?\}\}/s;

// The AnkiConnect wire shape for a Note being created. Distinct from the
// `AnkiNote` in index.ts, which is a Note read back from a query and carries a
// noteId. `modelName` is AnkiConnect's word for Note Type; it is forced on us by
// the API and should not spread further (ADR 0002).
export interface NewNote {
  deckName: string;
  modelName: string;
  fields: Record<string, string>;
  tags: string[];
  picture?: MediaItem[];
  audio?: MediaItem[];
}

interface NoteMedia {
  picture?: MediaItem[];
  audio?: MediaItem[];
}

// An empty `picture`/`audio` array is not the same as an absent key to
// AnkiConnect, so the arrays are attached only when they hold something.
// Keeping that here means no call site has to remember it.
function withMedia(note: NewNote, media: NoteMedia): NewNote {
  if (media.picture && media.picture.length > 0) note.picture = media.picture;
  if (media.audio && media.audio.length > 0) note.audio = media.audio;
  return note;
}

export function buildBasicNote(
  params: {
    deckName: string;
    front: string;
    back: string;
    tags?: string[];
  } & NoteMedia
): NewNote {
  const note: NewNote = {
    deckName: params.deckName,
    modelName: "Basic",
    fields: {
      [BASIC_FIELD_FRONT]: params.front,
      [BASIC_FIELD_BACK]: params.back,
    },
    tags: params.tags ?? [],
  };
  return withMedia(note, params);
}

export function buildClozeNote(
  params: {
    deckName: string;
    text: string;
    backExtra?: string;
    tags?: string[];
  } & NoteMedia
): NewNote {
  const note: NewNote = {
    deckName: params.deckName,
    modelName: "Cloze",
    fields: {
      [CLOZE_FIELD_TEXT]: params.text,
      // Written even when empty, matching the single-card handler: the Field
      // exists on the Note Type, so sending "" is meaningful rather than a
      // discarded key.
      [CLOZE_FIELD_BACK_EXTRA]: params.backExtra ?? "",
    },
    tags: params.tags ?? [],
  };
  return withMedia(note, params);
}

// Throws when `text` contains no Cloze Deletion.
//
// `position` names which entry failed in a batch, 1-based to match how the
// caller counted them out. The offending text is deliberately NOT interpolated
// into the message: this string is returned as tool output, which the model
// reads as trusted, and Note text routinely originates from an LLM reading an
// untrusted page — the same injection vector docs/adr/0001 covers for media
// URLs. An index is actionable and carries no attacker-controlled bytes.
export function validateClozeText(text: string, position?: number): void {
  if (CLOZE_DELETION_PATTERN.test(text)) return;

  const subject = position === undefined ? "Text" : `Card ${position} text`;
  throw new Error(
    `${subject} must contain at least one cloze deletion using {{c1::text}} syntax`
  );
}

// One entry of a `canAddNotesWithErrorDetail` result.
export interface AddabilityReport {
  canAdd: boolean;
  error?: string;
}

// A Note the collection will not accept, with its 1-based position in the
// caller's input (CONTEXT.md: Rejected Note).
export interface RejectedNote {
  position: number;
  reason: string;
}

// Split a batch into the Notes worth sending and the ones Anki already said it
// will refuse.
//
// This exists because `addNotes` is all-or-nothing: a single duplicate makes
// the whole call fail with a top-level error, and the valid Notes alongside it
// are not added either. Asking `canAddNotesWithErrorDetail` first is what lets
// a batch of 100 with one duplicate still add the other 99.
//
// The check is advisory, not a guarantee — the collection can change between
// the two calls, and `addNotes` remains the authority. It converts the common
// case (a repeat of something already in the deck) from a failed batch into a
// reported skip.
export function partitionAddable<T>(
  notes: T[],
  reports: AddabilityReport[]
): { addable: T[]; rejected: RejectedNote[] } {
  const addable: T[] = [];
  const rejected: RejectedNote[] = [];

  notes.forEach((note, index) => {
    // A report missing for this position means Anki said nothing about it.
    // Send it and let addNotes decide, rather than dropping it silently.
    const report = reports[index];
    if (!report || report.canAdd) {
      addable.push(note);
      return;
    }
    rejected.push({
      position: index + 1,
      reason: report.error ?? "Anki gave no reason",
    });
  });

  return { addable, rejected };
}

// Build the outcome message for a bulk creation.
//
// Naming the positions rather than only counting them is the point. A caller
// whose 47th Note failed otherwise has no way to find it, which is how failures
// get lost — the same reasoning as buildSkippedMessage in media.ts. The reason
// comes from Anki itself, so this never has to guess at a cause.
//
// Says Note, not Card: counts follow ADR 0002, and the distinction is load-
// bearing here, because one Cloze Note produces one Card per deletion and so a
// count of Notes is never a count of Cards.
export function buildBulkSummary(params: {
  added: number;
  rejected: RejectedNote[];
  deckName: string;
}): string {
  const { added, rejected, deckName } = params;

  const addedText = `${added} note${added !== 1 ? "s" : ""}`;

  if (rejected.length === 0) {
    return `Successfully added ${addedText} to deck "${deckName}".`;
  }

  const rejectedText = `${rejected.length} note${
    rejected.length !== 1 ? "s" : ""
  }`;
  const verb = rejected.length !== 1 ? "were" : "was";
  // Anki's reasons are its own strings, not caller text, so they are safe to
  // repeat verbatim — unlike the Note content, which is never echoed.
  const detail = rejected
    .map((note) => `[${note.position}] ${note.reason}`)
    .join("; ");

  return (
    `Added ${addedText} to deck "${deckName}". ` +
    `${rejectedText} ${verb} skipped: ${detail}.`
  );
}

// The payload AnkiConnect's `updateNote` takes: a Note id plus whichever of
// Fields and Tags are actually changing.
export interface NoteUpdate {
  id: number;
  fields?: Record<string, string>;
  tags?: string[];
}

// Builds the `updateNote` payload, or returns null when the caller asked for no
// change at all.
//
// Three things are load-bearing here:
//
//   Fields and Tags go in ONE request. The previous code sent `updateNoteFields`
//   followed by `replaceTags`, but `replaceTags` renames a single Tag
//   (`replaceTags(notes, tag_to_replace, replace_with_tag)`) and rejects a
//   `tags` argument outright, so every Tag update failed while the Field half
//   succeeded.
//
//   Tags stay an array. The old path joined them with spaces, but that is not
//   what caused issue #9: Anki splits a Tag on its own spaces regardless, so
//   ["organic chemistry"] is stored as two Tags even sent as one element. The
//   array is simply what `updateNote` takes.
//
//   An absent key is not an empty value. `tags: []` is a valid instruction to
//   AnkiConnect meaning "remove every Tag from this Note", so a caller who
//   omitted `tags` must produce a payload with no `tags` key at all — the same
//   distinction `withMedia` exists for above.
//
//   Null, not an empty payload. `updateNote` rejects a Note carrying neither
//   Fields nor Tags ('Must provide a "fields" or "tags" property.'), and that
//   wire-level message means nothing to a caller. Returning null lets the
//   handler skip the request instead of forwarding an error.
export function buildNoteUpdate(params: {
  noteId: number;
  fields?: Record<string, string>;
  tags?: string[];
}): NoteUpdate | null {
  const { noteId, fields, tags } = params;

  const hasFields = fields !== undefined && Object.keys(fields).length > 0;
  const hasTags = tags !== undefined;

  if (!hasFields && !hasTags) return null;

  const update: NoteUpdate = { id: noteId };
  if (hasFields) update.fields = fields;
  if (hasTags) update.tags = tags;
  return update;
}
// The display projection of a Note read back from AnkiConnect.
//
// `Cloze` Notes have no Front/Back Field — theirs are Text and Back Extra — so
// the two built-in Note Types are projected onto one shape here and every
// reader renders them the same way.
export interface NoteSummary {
  noteId: number;
  // Not `modelName`: that spelling belongs to the AnkiConnect wire format and
  // stops at this boundary (CONTEXT.md, "Note Type").
  noteType: string;
  front: string;
  back: string;
  tags: string[];
}

// Placeholders for content that cannot be shown. They are returned in place of
// a Field value, so a reader always gets a printable string.
const MISSING_FIELD = "[Missing field]";
const CLOZE_NO_EXTRA = "[Cloze deletion]";
const UNKNOWN_NOTE_TYPE = "[Unknown note type]";

// Projects one raw AnkiConnect note onto a NoteSummary.
//
// Every Field read is optional-chained on purpose: Anki lets users rename a
// Note Type's Fields, so a Note whose Note Type is "Basic" is not guaranteed to
// carry Front/Back. Without the guard one renamed Field throws inside the
// caller's .map() and fails the entire read rather than the single Note.
export function summarizeNote(note: any): NoteSummary {
  const base = {
    noteId: note.noteId,
    noteType: note.modelName,
    tags: note.tags ?? [],
  };

  if (note.modelName === "Cloze") {
    return {
      ...base,
      front: note.fields?.[CLOZE_FIELD_TEXT]?.value ?? MISSING_FIELD,
      // `||`, not `??`: a Cloze Note with an empty Back Extra is the normal
      // case, not a missing Field, and reads better as "[Cloze deletion]".
      back: note.fields?.[CLOZE_FIELD_BACK_EXTRA]?.value || CLOZE_NO_EXTRA,
    };
  }

  if (note.modelName === "Basic") {
    return {
      ...base,
      front: note.fields?.[BASIC_FIELD_FRONT]?.value ?? MISSING_FIELD,
      back: note.fields?.[BASIC_FIELD_BACK]?.value ?? MISSING_FIELD,
    };
  }

  // A custom Note Type. Its Fields are unknown, but the id and Tags still are
  // not, so the Note stays addressable — a caller can still find it to edit or
  // delete it. Logged because a Note rendering as a placeholder is otherwise
  // hard to explain; stderr is the server's log channel, never tool output.
  console.error(`Unknown note type: ${note.modelName}`);
  return { ...base, front: UNKNOWN_NOTE_TYPE, back: UNKNOWN_NOTE_TYPE };
}

// How much of a Field `find-cards` shows per Note. Long enough to tell two
// Notes apart, short enough that a wide search cannot flood the caller.
export const SEARCH_FIELD_EXCERPT_LENGTH = 100;

// Field values hold HTML, which is noise in a search result and can carry
// enough markup to bury the text. Tags go, entities that matter come back.
function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    // Last: an unescaped & in the source must not re-form an entity above.
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function excerpt(value: string, limit: number): string {
  const flat = stripHtml(value);
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit)}…`;
}

// Bounds a NoteSummary for display in search results.
//
// Deliberately separate from summarizeNote: the deck resource returns Note
// content in full and must keep doing so, while a search tool is called
// autonomously and can match an unbounded number of Notes. Only the search
// path truncates. See docs/adr/0003.
//
// Placeholders like "[Missing field]" are produced by summarizeNote rather than
// read from the collection, and are shorter than any sane limit, so they pass
// through untouched.
export function truncateSummary(
  summary: NoteSummary,
  limit: number = SEARCH_FIELD_EXCERPT_LENGTH
): NoteSummary {
  return {
    ...summary,
    front: excerpt(summary.front, limit),
    back: excerpt(summary.back, limit),
  };
}

// notesInfo is a POST body of note ids; chunking keeps a single request from
// growing unbounded on a large deck. The number is empirical, not a documented
// AnkiConnect limit — raise it rather than removing the loop.
export const NOTES_INFO_CHUNK_SIZE = 25;

// How many Notes `find-cards` will show at once. A broad query such as
// `deck:Default` can match an entire collection, and the result is read into a
// model's context, so the list is bounded and the true total is reported
// alongside it.
export const SEARCH_RESULT_LIMIT = 50;

// Renders search results. Says Notes, not Cards: one Cloze Note generates one
// Card per deletion, so a count of matches is never a count of Cards (ADR 0002).
export function buildSearchSummary(params: {
  matched: number;
  shown: NoteSummary[];
}): string {
  const { matched, shown } = params;

  if (matched === 0) return "No notes matched that search.";

  const noteWord = matched === 1 ? "note" : "notes";
  const header =
    shown.length < matched
      ? `Found ${matched} ${noteWord}; showing the first ${shown.length}. Narrow the search to see different ones.`
      : `Found ${matched} ${noteWord}.`;

  // The Note content is truncated by truncateSummary before it reaches here.
  const body = shown
    .map(
      (note) =>
        `Note ID: ${note.noteId}\nNote Type: ${note.noteType}\nFront: ${
          note.front
        }\nBack: ${note.back}\nTags: ${
          note.tags.length > 0 ? note.tags.join(", ") : "(none)"
        }\n---`
    )
    .join("\n");

  return `${header}\n\n${body}`;
}

// How many Notes one `delete-card` call may remove. Deletion is permanent and
// AnkiConnect offers no undo, so a single mistaken call is bounded: a caller
// that built the wrong list of ids cannot empty a collection with it.
export const DELETE_BATCH_LIMIT = 50;

// Which of the requested Notes actually exist.
//
// `deleteNotes` succeeds silently on an id that is not in the collection —
// `{"result": null, "error": null}`, identical to a real deletion — so counting
// the ids we asked about would report deletions that never happened. The only
// way to know is to look first.
//
// `notesInfo` answers positionally and returns a bare `{}` for a Note it cannot
// find, so presence is decided by the id coming back, not by the array length.
export function partitionExistingNotes(params: {
  requested: number[];
  found: any[];
}): { existing: number[]; missing: number[] } {
  const { requested, found } = params;

  const foundIds = new Set(
    found
      .filter((note) => note && typeof note.noteId === "number")
      .map((note) => note.noteId)
  );

  return {
    existing: requested.filter((id) => foundIds.has(id)),
    missing: requested.filter((id) => !foundIds.has(id)),
  };
}

// Reports a deletion. Says Notes, not Cards: deleting one Cloze Note removes one
// Card per deletion, so a count of deleted Notes is never a count of Cards
// (ADR 0002).
//
// Ids are the caller's own numbers, not Note content, so naming the missing
// ones is safe and tells the caller which of its ids were already stale.
export function buildDeleteSummary(params: {
  deleted: number[];
  missing: number[];
}): string {
  const { deleted, missing } = params;

  const noteWord = (n: number) => `${n} note${n === 1 ? "" : "s"}`;

  if (deleted.length === 0) {
    return `Deleted nothing. No notes found with ${
      missing.length === 1 ? "ID" : "IDs"
    }: ${missing.join(", ")}.`;
  }

  const head = `Permanently deleted ${noteWord(deleted.length)}: ${deleted.join(
    ", "
  )}.`;

  if (missing.length === 0) return head;

  return `${head} ${noteWord(
    missing.length
  )} did not exist and ${missing.length === 1 ? "was" : "were"} skipped: ${missing.join(
    ", "
  )}.`;
}
