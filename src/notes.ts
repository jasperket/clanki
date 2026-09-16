import type { MediaItem } from "./media.js";
import type { BasicFill, ClozeFill } from "./noteTypes.js";

// AnkiConnect silently discards a value written to a Field that does not exist
// — no error, the Note is created, and the content is simply gone. That failure
// mode has already cost real user data once (see the Known Issue in README.md),
// because the name was spelled inline at each call site and one of them was
// wrong.
//
// Field names used to be constants here. They no longer can be: Anki translates
// them per collection, so "Front" exists only in an English one (issue #4). They
// are now runtime data, resolved from the user's collection by noteTypes.ts.
//
// That makes the old rule stronger, not weaker. Never build a key of `fields`
// from anything but a BasicFill or ClozeFill. A literal is invisible to
// TypeScript — AnkiConnect's `fields` is an open Record<string, string>, so
// every key type-checks — and in a non-English collection it is silently wrong.

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
    // Required, never defaulted. A default here is exactly how the English-only
    // assumption would survive this change.
    noteType: BasicFill;
  } & NoteMedia
): NewNote {
  const note: NewNote = {
    deckName: params.deckName,
    modelName: params.noteType.noteTypeName,
    fields: {
      [params.noteType.frontField]: params.front,
      [params.noteType.backField]: params.back,
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
    noteType: ClozeFill;
  } & NoteMedia
): NewNote {
  const note: NewNote = {
    deckName: params.deckName,
    modelName: params.noteType.noteTypeName,
    fields: {
      [params.noteType.textField]: params.text,
      // Written even when empty, matching the single-card handler: the Field
      // exists on the Note Type, so sending "" is meaningful rather than a
      // discarded key.
      [params.noteType.backExtraField]: params.backExtra ?? "",
    },
    tags: params.tags ?? [],
  };
  return withMedia(note, params);
}

// Throws when `text` contains no Cloze Deletion.
//
// `position` names which Note failed in a batch, 1-based to match how the
// caller counted them out. It says Note rather than Card because it indexes
// the caller's input list, and one Cloze Note generates a Card per deletion.
//
// The offending text is deliberately NOT interpolated into the message: this
// string is returned as tool output, which the model reads as trusted, and
// Note text routinely originates from an LLM reading an untrusted page — the
// same injection vector docs/adr/0001 covers for media URLs. An index is
// actionable and carries no attacker-controlled bytes.
export function validateClozeText(text: string, position?: number): void {
  if (CLOZE_DELETION_PATTERN.test(text)) return;

  const subject = position === undefined ? "Text" : `Note ${position} text`;
  throw new Error(
    `${subject} must contain at least one cloze deletion using {{c1::text}} syntax`
  );
}

// Anki mangles a Tag containing certain whitespace, silently and in two
// different ways. Probed against a live collection (see docs/adr/0005) across
// every codepoint JS `\s` matches:
//
//   U+0020 and U+3000 SPLIT one Tag into two.
//   U+0009 U+000A U+000B U+000C U+000D are DELETED, welding the Tag into one
//     word: "aa\tbb" is stored as "aabb".
//
// Everything else `\s` matches — U+00A0, U+2028, U+202F and 17 more — is stored
// unchanged, which is why these are explicit sets and NOT /\s/. A regex class
// here would reject 20 kinds of Tag that Anki accepts perfectly well.
//
// Written as \uXXXX escapes because a literal tab or ideographic space in
// source is invisible to a reader and does not survive a copy-paste.
const TAG_SPLITTING_CHARS = new Set(["\u0020", "\u3000"]);
const TAG_STRIPPED_CHARS = new Set([
  "\u0009",
  "\u000a",
  "\u000b",
  "\u000c",
  "\u000d",
]);

// Short: a Tag is a word or two, not a URL. Long enough to recognise which Tag
// was rejected, short enough that a crafted value cannot bury the real message.
const MAX_TAG_DISPLAY_LENGTH = 40;

// Same bound-and-sanitise intent as media.ts's excerptForDisplay, for the same
// reason: this string is tool output, which the model reads as trusted, and a
// Tag can originate from an LLM reading an untrusted page.
//
// It differs in one way that matters. media.ts drops disallowed characters, but
// here the disallowed character is the entire point of the message — dropping a
// space would render "organic chemistry" as "organicchemistry", showing the
// caller a Tag they never sent and hiding the very byte being complained about.
// So the mangling characters are made VISIBLE as \uXXXX escapes, and only
// everything else outside the allowlist is dropped. A newline therefore appears
// as the six literal characters \u000a and cannot forge a line of tool output.
function tagForDisplay(tag: string): string {
  const shown = [...tag]
    .map((c) => {
      if (TAG_SPLITTING_CHARS.has(c) || TAG_STRIPPED_CHARS.has(c)) {
        return c === "\u0020"
          ? c
          : `\\u${c.codePointAt(0)!.toString(16).padStart(4, "0")}`;
      }
      return /[A-Za-z0-9_:.\-]/.test(c) ? c : "";
    })
    .join("");
  const truncated = shown.slice(0, MAX_TAG_DISPLAY_LENGTH);
  const suffix = shown.length > truncated.length ? "..." : "";
  return truncated.length > 0 ? `"${truncated}${suffix}"` : "(unprintable)";
}

// Throws when a Tag contains whitespace Anki would mangle.
//
// Unlike validateClozeText this DOES name the offending value, a deliberate
// narrowing of docs/adr/0003 argued in docs/adr/0005: a position tells the
// caller which Tag failed but not what to write instead, and the fix depends on
// the value. The echo is bounded by tagForDisplay above.
//
// The message must contain no comma. src/index.ts joins multiple validation
// failures with ", ", so a comma inside one message is indistinguishable from
// the boundary between two.
//
// Only genuinely mangling input is rejected. An empty Tag, an all-whitespace
// Tag, a duplicate, and leading or trailing whitespace are all handled cleanly
// by Anki (dropped, stripped, deduped), so refusing them would fail a call that
// does no harm.
export function validateTags(
  tags: string[] | undefined,
  position?: number
): void {
  if (tags === undefined) return;

  const subject = position === undefined ? "Tag" : `Note ${position} tag`;

  for (const tag of tags) {
    // Anki strips leading and trailing whitespace and drops an all-whitespace
    // Tag entirely, so only INTERIOR whitespace actually mangles anything.
    // Scanning the raw value would reject "  padded  ", which Anki stores
    // cleanly as "padded" — a call that does no harm.
    const interior = tag.trim();

    for (const char of interior) {
      const splits = TAG_SPLITTING_CHARS.has(char);
      const stripped = TAG_STRIPPED_CHARS.has(char);
      if (!splits && !stripped) continue;

      // Naming the replacement makes the retry deterministic. Without it the
      // caller has to guess between organic_chemistry, organic::chemistry and
      // OrganicChemistry, and different sessions guess differently — which
      // fragments a Tag hierarchy, a milder form of the bug being prevented.
      const suggestion = [...interior]
        .map((c) =>
          TAG_SPLITTING_CHARS.has(c) || TAG_STRIPPED_CHARS.has(c) ? "_" : c
        )
        .join("");
      const effect = splits
        ? "contains a space that Anki would split into two separate tags"
        : "contains a tab or newline that Anki would remove from the tag";

      // A truncated suggestion is worse than none: "aaaa..." is not a Tag the
      // caller can actually send. When it does not fit, describe the fix
      // instead of printing an unusable value.
      const shownSuggestion = tagForDisplay(suggestion);
      const advice = shownSuggestion.includes("...")
        ? "replace it with an underscore"
        : `use ${shownSuggestion} instead`;

      throw new Error(
        `${subject} ${tagForDisplay(interior)} ${effect} - ${advice}`
      );
    }
  }
}

// Throws when a Deck name is empty or would become empty once Anki trims it.
//
// Anki does not reject an empty Deck name. `createDeck` with "" returns
// error: null and creates a Deck literally named `blank`, and "   " produces
// the same Deck -- observed, and re-checkable with `npm run probe:decks`. So
// without this the caller gets a success message for Notes that were filed
// somewhere it never asked for, which is worse than a failure.
//
// This is meaning rather than shape, hence notes.ts and not a Zod .refine()
// (docs/adr/0005): it took an experiment to learn that Anki substitutes
// `blank`, and the schemas' .min(1) cannot see that "   " is empty.
//
// Naming `blank` in the message is the point. A caller told only "must not be
// empty" does not know a Deck was about to be invented on its behalf.
//
// No `position` parameter: deckName is per-call, never per-Note, so there is no
// batch entry to name the way validateTags and validateClozeText do.
//
// Only emptiness is rejected. A Deck name may contain a space, a quote or a
// colon -- all probed and stored unchanged -- so the Tag rules deliberately do
// NOT apply here. `::` expresses nesting and is a documented feature, not input
// to constrain.
//
// The message contains no comma, for the reason given on validateTags.
export function validateDeckName(deckName: string): void {
  if (deckName.trim().length > 0) return;

  throw new Error(
    "Deck name must not be empty - Anki would file this into a deck named blank"
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
// Deliberately does NOT use Resolution, unlike the write path. Two reasons:
//
//   1. It already has the truth. The write path must know Field names *before*
//      it sends them; here `notesInfo` returns each Note's own Fields, with
//      their real names and values, whatever language they are in.
//   2. Depending on Resolution would make an ambiguous collection break
//      `find-cards` too — so a user could not list their Notes to discover
//      which Note Type name to put in CLANKI_BASIC_NOTE_TYPE. The tool for
//      diagnosing the problem would fail for the same reason as the problem.
//
// This is also why the function stays pure and synchronous.
//
// Every read is optional-chained on purpose, the Note itself included:
// AnkiConnect returns a null entry for a note id it cannot resolve — one
// deleted between findNotes and notesInfo. Without the guards one bad entry
// throws inside the caller's .map() and fails the entire read rather than the
// single Note.
export function summarizeNote(note: any): NoteSummary {
  const base = {
    noteId: note?.noteId,
    noteType: note?.modelName,
    tags: note?.tags ?? [],
  };

  // Fields in Anki's own order. `notesInfo` gives each Field an `order`, which
  // is what makes "the first Field" meaningful without knowing its name — and
  // the first Field is the front of a Basic Note in any language.
  const entries = Object.entries(note?.fields ?? {}) as [
    string,
    { value?: string; order?: number }
  ][];
  if (entries.length === 0) {
    // No Fields at all: an unresolvable Note. It keeps its id and Tags, so a
    // caller can still find it to edit or delete it. Logged because a Note
    // rendering as a placeholder is otherwise hard to explain; stderr is the
    // server's log channel, never tool output.
    console.error(`Unknown note type: ${note?.modelName}`);
    return { ...base, front: UNKNOWN_NOTE_TYPE, back: UNKNOWN_NOTE_TYPE };
  }
  const ordered = [...entries].sort(
    (a, b) => (a[1]?.order ?? 0) - (b[1]?.order ?? 0)
  );

  // A Cloze Note is identified by its content, not its Note Type name, which is
  // translated. Weaker than the old name check, but display-only: a wrong guess
  // formats a summary oddly and loses nothing.
  const isCloze = ordered.some(([, f]) =>
    CLOZE_DELETION_PATTERN.test(f?.value ?? "")
  );

  const front = ordered[0]?.[1]?.value ?? MISSING_FIELD;
  const back = ordered[1]?.[1]?.value;

  if (isCloze) {
    return {
      ...base,
      front,
      // `||`, not `??`: a Cloze Note with an empty Back Extra is the normal
      // case, not a missing Field, and reads better as "[Cloze deletion]".
      back: back || CLOZE_NO_EXTRA,
    };
  }

  return { ...base, front, back: back ?? MISSING_FIELD };
}

// How much of a Field `find-cards` shows per Note. Long enough to tell two
// Notes apart, short enough that a wide search cannot flood the caller.
export const SEARCH_FIELD_EXCERPT_LENGTH = 100;

// Field values hold HTML, which is noise in a search result and can carry
// enough markup to bury the text. Tags go, entities that matter come back.
//
// The tag pattern requires a letter or `/` after the `<`, so it matches real
// markup but leaves plain text alone: a Field reading "if a < b then c > d"
// is content, not a tag, and `<[^>]*>` would delete everything between the
// two comparison operators.
//
// Order is load-bearing. Tags are stripped BEFORE entities are decoded, and
// nothing re-strips afterwards: a Field holding `&lt;b&gt;` was escaped by
// Anki because the user wanted to see the literal text `<b>`, so decoding it
// into markup and then removing it would delete content the user typed.
function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
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

// Cuts to `limit` characters, not UTF-16 code units. A plain `slice` splits a
// surrogate pair — the two code units JavaScript uses to store one emoji or
// less common CJK character — leaving a lone half that renders as `<?>`. The
// spread walks code points, so a cut never lands inside one.
function excerpt(value: string, limit: number): string {
  const flat = stripHtml(value);
  const codePoints = [...flat];
  if (codePoints.length <= limit) return flat;
  return `${codePoints.slice(0, limit).join("")}…`;
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
//
// `capped` is passed in rather than inferred from `shown.length < matched`:
// those two differ for a second reason that is not a cap. A Note deleted
// between findNotes and notesInfo, or any id AnkiConnect cannot resolve, is
// counted in `matched` but produces no entry in `shown`. Inferring the cap
// there tells the caller to narrow a search that already returned everything
// that exists. Only the caller knows whether SEARCH_RESULT_LIMIT truncated
// the id list.
export function buildSearchSummary(params: {
  matched: number;
  shown: NoteSummary[];
  capped?: boolean;
}): string {
  const { matched, shown, capped = false } = params;

  if (matched === 0) return "No notes matched that search.";

  const noteWord = matched === 1 ? "note" : "notes";
  const header = capped
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
//
// Repeated ids collapse to one. `deleteNotes` removes a Note once however many
// times its id appears, so keeping the duplicates would report more deletions
// than happened — the same lie this partitioning exists to prevent — and would
// spend DELETE_BATCH_LIMIT slots on Notes that are not distinct.
export function partitionExistingNotes(params: {
  requested: number[];
  found: any[];
}): { existing: number[]; missing: number[] } {
  const { found } = params;
  const requested = [...new Set(params.requested)];

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
