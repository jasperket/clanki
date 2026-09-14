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

// The AnkiConnect wire shape for one Note. `modelName` is their word for Note
// Type; it is forced on us by the API and should not spread further (ADR 0002).
export interface AnkiNote {
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
function withMedia(note: AnkiNote, media: NoteMedia): AnkiNote {
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
): AnkiNote {
  const note: AnkiNote = {
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
): AnkiNote {
  const note: AnkiNote = {
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

// Build the outcome message for an `addNotes` batch.
//
// `addNotes` returns an array positionally aligned with the input, holding
// `null` at each index Anki refused — a Rejected Note (CONTEXT.md). It does not
// say why, so this message must not assert a cause: a duplicate first Field is
// the common one, but an empty first Field or another per-Note problem looks
// identical from here.
//
// Naming the positions rather than only counting them is the point. A caller
// whose 47th Note failed otherwise has no way to find it, which is how failures
// get lost — the same reasoning as buildSkippedMessage in media.ts.
//
// Says Note, not Card: counts follow ADR 0002, and the distinction is load-
// bearing here, because one Cloze Note produces one Card per deletion and so a
// count of Notes is never a count of Cards.
export function buildBulkSummary(params: {
  results: (number | null)[];
  deckName: string;
}): string {
  const { results, deckName } = params;

  const rejected = results
    .map((id, index) => (id === null ? index + 1 : null))
    .filter((position): position is number => position !== null);
  const added = results.length - rejected.length;

  const addedText = `${added} note${added !== 1 ? "s" : ""}`;

  if (rejected.length === 0) {
    return `Successfully added ${addedText} to deck "${deckName}".`;
  }

  const rejectedText = `${rejected.length} note${
    rejected.length !== 1 ? "s" : ""
  }`;
  const verb = rejected.length !== 1 ? "were" : "was";

  return (
    `Added ${addedText} to deck "${deckName}". ` +
    `${rejectedText} ${verb} not added (Anki does not report which reason ` +
    `applied; a duplicate first field is the usual cause). ` +
    `Positions in the input: ${rejected.join(", ")}.`
  );
}
