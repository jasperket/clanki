import { ankiRequest, type AnkiRequestFn } from "./ankiConnect.js";
import {
  resolveNoteTypes,
  type AnkiNoteType,
  type NoteTypeOverrides,
  type NoteTypeResolution,
} from "./noteTypes.js";

// Which Note Type fills each Role, remembered for the life of the process.
//
// Resolution costs two AnkiConnect round trips, and a collection's Note Types
// change about as often as a user reorganises their whole setup — so caching is
// the difference between two requests per session and two per Card.
//
// The cached value is the PROMISE, not the result. A bulk call resolves once and
// every concurrent caller waits on the same request; caching the result instead
// would let two simultaneous calls both miss and both go to Anki.
let cached: Promise<NoteTypeResolution> | null = null;

async function fetchNoteTypes(
  request: AnkiRequestFn,
  overrides: NoteTypeOverrides
): Promise<NoteTypeResolution> {
  // `modelNames` gives the names; `findModelsByName` gives the structure we
  // actually select on. Two calls because AnkiConnect has no "give me every
  // note type in full" action. (These are wire action names, so they keep
  // AnkiConnect's "model" spelling — see CONTEXT.md on Note Type.)
  const names = await request<string[]>("modelNames");
  const noteTypes = await request<AnkiNoteType[]>("findModelsByName", {
    modelNames: names,
  });
  return resolveNoteTypes(noteTypes, overrides);
}

// Resolution is lazy — on the first call that needs it, not at startup. An MCP
// server starts before Anki is necessarily running, so resolving eagerly would
// turn "the user opens Anki a minute later" into a dead server.
export async function getNoteTypes(
  overrides: NoteTypeOverrides = {},
  request: AnkiRequestFn = ankiRequest
): Promise<NoteTypeResolution> {
  if (!cached) {
    cached = fetchNoteTypes(request, overrides).catch((error) => {
      // Clear on failure, or one attempt made while Anki was still starting
      // would poison a long-lived server for the rest of its life.
      cached = null;
      throw error;
    });
  }
  return cached;
}

// Drops the cached Resolution so the next call re-reads the collection.
//
// Used when a write fails in a way that suggests the Note Types moved under us
// — the user renamed one mid-session. No TTL: a timer would make failures
// nondeterministic, and collections rarely change.
export function invalidateNoteTypes(): void {
  cached = null;
}

// True when an error means our cached Resolution no longer matches the
// collection, so it is worth re-reading and trying once more.
//
// Both spellings come from AnkiConnect itself. "model was not found" is what it
// returns for a renamed or deleted Note Type; the field variant covers a Field
// renamed within one.
export function isStaleNoteTypeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /model was not found/i.test(message) || /field.*not found/i.test(message);
}
