import { describe, it, expect, afterEach, vi } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import { isNonIdempotent, UnconfirmedWriteError } from "./ankiConnect.js";

// Issue #23. `ankiRequest` retries a transport failure three times, but a lost
// response is a transport failure: if Anki committed the write and only the
// reply went missing, the retry adds the whole batch again. These tests cover
// which actions are exempt from that retry, and that the exemption is wired up.
//
// The classification is asserted through the exported predicate rather than the
// Set, so the Set itself stays closed.

describe("action idempotence", () => {
  // The reported bug. `addNotes` mints new Note ids on every call, so a resend
  // is a second batch rather than a repeat of the first.
  it("treats addNote and addNotes as non-idempotent", () => {
    expect(isNonIdempotent("addNotes")).toBe(true);
    expect(isNonIdempotent("addNote")).toBe(true);
  });

  // createDeck returns the existing Deck's id for a name already present, so
  // sending it twice leaves the collection exactly as sending it once did.
  it("treats createDeck as idempotent because it returns the existing deck", () => {
    expect(isNonIdempotent("createDeck")).toBe(false);
  });

  // THE tripwire. deleteNotes is the most destructive action this server sends,
  // and it does not belong in the set -- it succeeds silently on an id that is
  // already gone, so deleting twice reaches the same state as deleting once.
  // Idempotence is the criterion, not danger. Someone will eventually try to add
  // this "to be safe"; that would turn a recoverable blip into a failed deletion
  // and fix nothing.
  it("treats deleteNotes as idempotent even though it is destructive", () => {
    expect(isNonIdempotent("deleteNotes")).toBe(false);
  });

  // Writing the same field values or the same tag rename twice leaves the same
  // state, so a retry is free.
  it("treats the update actions as idempotent", () => {
    expect(isNonIdempotent("updateNoteFields")).toBe(false);
    expect(isNonIdempotent("updateNote")).toBe(false);
    expect(isNonIdempotent("replaceTags")).toBe(false);
  });

  it("treats reads as idempotent", () => {
    for (const action of [
      "findNotes",
      "notesInfo",
      "deckNames",
      "canAddNotesWithErrorDetail",
      "version",
    ]) {
      expect(isNonIdempotent(action)).toBe(false);
    }
  });
});

// The classification above asserts the table. This asserts the fix: that the
// table is actually consulted by the retry loop.
//
// A real server on an ephemeral port is used rather than a mock, because the
// behaviour under test is how many times the request reaches the wire. The
// dynamic import is unavoidable: ANKI_CONNECT_URL is read at module load, so
// the env var must be set before the module is first evaluated.
describe("retrying", () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    vi.unstubAllEnvs();
  });

  // Destroys every connection without replying, which is exactly the lost
  // response the issue describes: the request arrived, the answer never came.
  async function startSilentServer(onRequest: () => void): Promise<number> {
    server = http.createServer((req, res) => {
      onRequest();
      req.socket.destroy();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return (server!.address() as AddressInfo).port;
  }

  async function loadFreshModule(port: number) {
    vi.stubEnv("CLANKI_ANKI_CONNECT_URL", `http://127.0.0.1:${port}`);
    vi.resetModules();
    return import("./ankiConnect.js");
  }

  it("sends a non-idempotent action exactly once when the connection fails", async () => {
    let hits = 0;
    const port = await startSilentServer(() => hits++);
    const { ankiRequest, UnconfirmedWriteError: Unconfirmed } =
      await loadFreshModule(port);

    await expect(ankiRequest("addNotes", { notes: [] })).rejects.toBeInstanceOf(
      Unconfirmed
    );

    // The whole point: one attempt, no resend. A second hit here means a batch
    // that Anki may have committed was sent again.
    expect(hits).toBe(1);
  });

  // The contrast case. An idempotent action keeps its retries, so leaving an
  // action out of the set is a real decision with a visible effect.
  it("still retries an idempotent action", async () => {
    let hits = 0;
    const port = await startSilentServer(() => hits++);
    const { ankiRequest } = await loadFreshModule(port);

    // Backoff shortened so the test does not sit through 1s + 2s.
    await expect(
      ankiRequest("deckNames", {}, 3, 1)
    ).rejects.toBeTruthy();

    expect(hits).toBe(3);
  });

  // The message must say the outcome is UNKNOWN. A caller -- usually an
  // assistant -- that reads "failed" resends the batch, which is the duplicate
  // this change exists to prevent.
  it("reports an unconfirmed write as unknown rather than failed", async () => {
    const port = await startSilentServer(() => {});
    const { ankiRequest } = await loadFreshModule(port);

    try {
      await ankiRequest("addNotes", { notes: [] });
      expect.unreachable("expected a throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/not known whether/);
      expect(message).not.toMatch(/^addNotes failed/);
      // Says Note, never Card (ADR 0002).
      expect(message).not.toMatch(/Card/);
    }
  });
});

// Guards the export itself: addNoteBatch in index.ts recognises this case with
// `instanceof`, so renaming or removing the class breaks the caller-facing
// wording silently.
describe("UnconfirmedWriteError", () => {
  it("carries the action and the underlying cause", () => {
    const error = new UnconfirmedWriteError("addNotes", "socket hang up");

    expect(error.action).toBe("addNotes");
    expect(error.message).toContain("socket hang up");
    expect(error).toBeInstanceOf(Error);
  });
});
