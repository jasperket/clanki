// Anki translates the built-in Note Types and their Fields when a collection is
// first created. A German collection has no Note Type named "Basic" — it has
// "Einfach", whose Fields are "Vorderseite" and "Rückseite". Hardcoding the
// English names is what made this server unusable in any other language
// (issue #4).
//
// So this module does not look for names. It looks for *structure*, and reports
// which Note Type in the user's collection fills each of the two Roles this
// server needs. The Field names come back with it, because AnkiConnect returns a
// Note Type's Fields alongside it — which means resolving the Note Type resolves
// the Fields too.
//
// Everything here is a pure function of the Note Type list, so the heuristics can
// be tested against fixtures for collections we do not have.

// One of exactly two jobs this server needs done. Roles are ours and never
// translated; the Note Type that fills a Role is the user's and always might be.
// Keeping these apart is the whole point of this module — conflating them is what
// the bug was.
export type NoteTypeRole = "basic" | "cloze";

// The parts of an AnkiConnect `findModelsByName` entry that we read.
// `type` is Anki's own discriminator: 1 for cloze-style, 0 for standard.
export interface AnkiNoteType {
  name: string;
  type: number;
  flds: { name: string; ord: number }[];
  tmpls: { name: string; qfmt: string }[];
}

export interface BasicFill {
  noteTypeName: string;
  frontField: string;
  backField: string;
}

export interface ClozeFill {
  noteTypeName: string;
  textField: string;
  backExtraField: string;
}

export interface NoteTypeResolution {
  basic: BasicFill;
  cloze: ClozeFill;
}

// User-supplied names, from env vars read at the edge of the program.
// `fields` is only needed for a Note Type whose Fields are not in the usual
// front-then-back order; naming the Note Type alone is the common case.
export interface NoteTypeOverrides {
  basicNoteType?: string;
  clozeNoteType?: string;
  basicFields?: string[];
  clozeFields?: string[];
}

// The English built-ins. Used ONLY to short-circuit resolution in an English
// collection — never as a fallback when detection fails, because a wrong guess
// writes to a Field that does not exist and AnkiConnect discards the value
// silently.
export const ENGLISH_DEFAULTS = {
  basicNoteType: "Basic",
  clozeNoteType: "Cloze",
  frontField: "Front",
  backField: "Back",
  textField: "Text",
  backExtraField: "Back Extra",
} as const;

// Thrown when the collection offers no single answer for a Role.
//
// This is deliberately a hard stop rather than a best guess. Picking the wrong
// Note Type means writing to Fields it does not have, and AnkiConnect reports
// that as a success while discarding the content — the failure mode that has
// already cost this repo real user data. A blocked user reads an error; a user
// who gets a wrong guess gets empty Notes and no signal at all.
export class NoteTypeResolutionError extends Error {
  constructor(
    readonly role: NoteTypeRole,
    readonly candidates: string[],
    message: string
  ) {
    super(message);
    this.name = "NoteTypeResolutionError";
  }
}

// Field names in Anki's own order. `ord` is authoritative: `flds` has arrived
// sorted in every collection observed, but the order is what decides which Field
// is the front and which is the back, so it is worth sorting explicitly rather
// than trusting arrival order.
export function fieldsByOrd(noteType: AnkiNoteType): string[] {
  return [...noteType.flds].sort((a, b) => a.ord - b.ord).map((f) => f.name);
}

// A Note Type fills the cloze Role when Anki marks it cloze-style AND it has
// exactly two Fields.
//
// The Field count is load-bearing, not cosmetic: Image Occlusion is also
// `type: 1` in current Anki, and it has five Fields. Without this check it is a
// rival candidate in every stock collection.
function clozeCandidates(noteTypes: AnkiNoteType[]): AnkiNoteType[] {
  return noteTypes.filter((n) => n.type === 1 && n.flds.length === 2);
}

// A Note Type fills the basic Role when it is standard, has exactly two Fields,
// and generates exactly one Card from them without asking the user to type.
//
// Every clause is needed, because three of Anki's built-ins have two Fields:
//
//   Basic                       2 fields, 1 template   <- the one we want
//   Basic (and reversed card)   2 fields, 2 templates  <- excluded by tmpls
//   Basic (type in the answer)  2 fields, 1 template   <- excluded by {{type:
//
// The `{{type:` test is the weakest link, since it matches a template's
// internals and Anki could restyle those. It is kept because dropping it would
// make every stock non-English collection ambiguous — they all ship the local
// equivalent of "Basic (type in the answer)". It also fails safely: if Anki
// changes the template, an extra candidate survives, resolution stops, and the
// user names the Note Type explicitly. It cannot silently pick the wrong one.
function basicCandidates(noteTypes: AnkiNoteType[]): AnkiNoteType[] {
  return noteTypes.filter(
    (n) =>
      n.type === 0 &&
      n.flds.length === 2 &&
      n.tmpls.length === 1 &&
      !n.tmpls[0].qfmt.includes("{{type:")
  );
}

// Two distinct situations, and conflating them misleads the reader.
//
// With several candidates, the names ARE the matches and the user picks one.
// With none, the names are merely what the collection contains — none of them
// matched — so the message must not call them candidates. Saying "1 that match"
// about a Note Type the criteria just rejected would send the user to fix the
// wrong thing.
function describeCandidates(names: string[], matched: boolean): string {
  if (!matched) {
    if (names.length === 0) return "your collection has no note types at all";
    const quoted = names.map((c) => `"${c}"`).join(", ");
    return `your collection has none. Its note types are: ${quoted}`;
  }
  const quoted = names.map((c) => `"${c}"`).join(", ");
  return `your collection has ${names.length} that match: ${quoted}`;
}

// The message is returned as tool output, which the model reads as trusted and
// will try to act on, so it names the problem, lists what was found, and gives
// the exact variable to set. Note Type names are the user's own collection
// strings, so echoing them is safe; Field values are not echoed.
//
// It deliberately says "which note type to use for basic cards" rather than
// "the Basic note type" — the latter implies a Note Type named Basic exists,
// which for the affected user is precisely what is not true.
function resolutionError(
  role: NoteTypeRole,
  names: string[],
  matched: boolean,
  criteria: string,
  envVar: string
): NoteTypeResolutionError {
  const example = names[0] ?? "Your Note Type";
  return new NoteTypeResolutionError(
    role,
    names,
    `Could not identify which note type to use for ${role} cards in your Anki ` +
      `collection. Clanki looks for ${criteria}; ${describeCandidates(names, matched)}.\n\n` +
      `Set ${envVar} to the one you want, e.g.\n` +
      `  ${envVar}="${example}"\n` +
      `in your MCP server config, then restart the server.`
  );
}

// Picks the single candidate, or explains why it cannot.
//
// `allNames` is used only when nothing matched: the user needs to see what the
// collection actually contains in order to pick one, and the filtered list is
// empty by definition.
function selectSole(
  candidates: AnkiNoteType[],
  role: NoteTypeRole,
  criteria: string,
  envVar: string,
  allNames: string[]
): AnkiNoteType {
  if (candidates.length === 1) return candidates[0];
  const matched = candidates.length > 0;
  const names = matched ? candidates.map((c) => c.name) : allNames;
  throw resolutionError(role, names, matched, criteria, envVar);
}

const BASIC_CRITERIA = "a note type with 2 fields and 1 card template";
const CLOZE_CRITERIA = "a cloze-style note type with 2 fields";

export function selectBasicNoteType(noteTypes: AnkiNoteType[]): AnkiNoteType {
  // An English collection is the common case and has an exact answer, so take it
  // before running heuristics that could be confused by the user's own Note
  // Types. Matched on Field names too, so a user who renamed their Fields but
  // kept the name "Basic" still goes through detection.
  const exact = noteTypes.find(
    (n) =>
      n.name === ENGLISH_DEFAULTS.basicNoteType &&
      n.flds.length === 2 &&
      fieldsByOrd(n)[0] === ENGLISH_DEFAULTS.frontField &&
      fieldsByOrd(n)[1] === ENGLISH_DEFAULTS.backField
  );
  if (exact) return exact;

  return selectSole(
    basicCandidates(noteTypes),
    "basic",
    BASIC_CRITERIA,
    "CLANKI_BASIC_NOTE_TYPE",
    noteTypes.map((n) => n.name)
  );
}

export function selectClozeNoteType(noteTypes: AnkiNoteType[]): AnkiNoteType {
  const exact = noteTypes.find(
    (n) =>
      n.name === ENGLISH_DEFAULTS.clozeNoteType &&
      n.type === 1 &&
      n.flds.length === 2 &&
      fieldsByOrd(n)[0] === ENGLISH_DEFAULTS.textField &&
      fieldsByOrd(n)[1] === ENGLISH_DEFAULTS.backExtraField
  );
  if (exact) return exact;

  return selectSole(
    clozeCandidates(noteTypes),
    "cloze",
    CLOZE_CRITERIA,
    "CLANKI_CLOZE_NOTE_TYPE",
    noteTypes.map((n) => n.name)
  );
}

// Resolves an override to a real Note Type, refusing anything the collection
// does not confirm.
//
// Validation is not optional politeness. An unchecked override reintroduces the
// silent-discard bug with the user's own typo: a misspelled Note Type name fails
// loudly, but a misspelled *Field* name would be accepted by AnkiConnect and the
// content dropped. So both are checked against the collection here.
function applyOverride(
  noteTypes: AnkiNoteType[],
  role: NoteTypeRole,
  name: string,
  fields: string[] | undefined,
  envVar: string
): { noteType: AnkiNoteType; fields: string[] } {
  const found = noteTypes.find((n) => n.name === name);
  if (!found) {
    throw new NoteTypeResolutionError(
      role,
      noteTypes.map((n) => n.name),
      `${envVar} is set to "${name}", but your Anki collection has no note ` +
        `type with that name. Available note types: ` +
        `${noteTypes.map((n) => `"${n.name}"`).join(", ")}.`
    );
  }

  const available = fieldsByOrd(found);
  if (!fields) {
    if (available.length < 2) {
      throw new NoteTypeResolutionError(
        role,
        [found.name],
        `${envVar} is set to "${name}", but that note type has ` +
          `${available.length} field(s). Clanki needs at least 2.`
      );
    }
    return { noteType: found, fields: available.slice(0, 2) };
  }

  const missing = fields.filter((f) => !available.includes(f));
  if (missing.length > 0) {
    throw new NoteTypeResolutionError(
      role,
      [found.name],
      `Field(s) ${missing.map((f) => `"${f}"`).join(", ")} do not exist on ` +
        `note type "${name}". Its fields are: ` +
        `${available.map((f) => `"${f}"`).join(", ")}.`
    );
  }
  if (fields.length < 2) {
    throw new NoteTypeResolutionError(
      role,
      [found.name],
      `Expected 2 comma-separated field names for "${name}", got ${fields.length}.`
    );
  }

  return { noteType: found, fields };
}

function resolveRole(
  noteTypes: AnkiNoteType[],
  role: NoteTypeRole,
  overrideName: string | undefined,
  overrideFields: string[] | undefined,
  envVar: string,
  select: (noteTypes: AnkiNoteType[]) => AnkiNoteType
): { noteType: AnkiNoteType; fields: string[] } {
  if (overrideName) {
    return applyOverride(noteTypes, role, overrideName, overrideFields, envVar);
  }
  const noteType = select(noteTypes);
  return { noteType, fields: fieldsByOrd(noteType) };
}

// Finds which Note Type fills each Role. Throws rather than guessing.
export function resolveNoteTypes(
  noteTypes: AnkiNoteType[],
  overrides: NoteTypeOverrides = {}
): NoteTypeResolution {
  const basic = resolveRole(
    noteTypes,
    "basic",
    overrides.basicNoteType,
    overrides.basicFields,
    "CLANKI_BASIC_NOTE_TYPE",
    selectBasicNoteType
  );
  const cloze = resolveRole(
    noteTypes,
    "cloze",
    overrides.clozeNoteType,
    overrides.clozeFields,
    "CLANKI_CLOZE_NOTE_TYPE",
    selectClozeNoteType
  );

  return {
    basic: {
      noteTypeName: basic.noteType.name,
      frontField: basic.fields[0],
      backField: basic.fields[1],
    },
    cloze: {
      noteTypeName: cloze.noteType.name,
      textField: cloze.fields[0],
      backExtraField: cloze.fields[1],
    },
  };
}
