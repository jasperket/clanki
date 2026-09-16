import { describe, it, expect, beforeEach } from "vitest";
import {
  getNoteTypes,
  invalidateNoteTypes,
  isStaleNoteTypeError,
} from "./noteTypeCache.js";
import type { AnkiNoteType } from "./noteTypes.js";

const COLLECTION: AnkiNoteType[] = [
  {
    name: "Einfach",
    type: 0,
    flds: [
      { name: "Vorderseite", ord: 0 },
      { name: "Rückseite", ord: 1 },
    ],
    tmpls: [{ name: "Karte 1", qfmt: "{{Vorderseite}}" }],
  },
  {
    name: "Lückentext",
    type: 1,
    flds: [
      { name: "Text", ord: 0 },
      { name: "Extra", ord: 1 },
    ],
    tmpls: [{ name: "Lückentext", qfmt: "{{cloze:Text}}" }],
  },
];

// A fake AnkiConnect that counts calls, so single-flight is observable.
function fakeRequest(collection: AnkiNoteType[] = COLLECTION) {
  let calls = 0;
  const request = async <T,>(action: string): Promise<T> => {
    calls++;
    if (action === "modelNames") {
      return collection.map((n) => n.name) as T;
    }
    return collection as T;
  };
  return { request, calls: () => calls };
}

function failingRequest(error: Error) {
  let calls = 0;
  const request = async <T,>(): Promise<T> => {
    calls++;
    throw error;
  };
  return { request, calls: () => calls };
}

describe("getNoteTypes", () => {
  beforeEach(() => {
    // The cache is module state that outlives a single test.
    invalidateNoteTypes();
  });

  it("resolves the collection", async () => {
    const { request } = fakeRequest();
    const resolved = await getNoteTypes({}, request);
    expect(resolved.basic.noteTypeName).toBe("Einfach");
    expect(resolved.basic.frontField).toBe("Vorderseite");
    expect(resolved.cloze.noteTypeName).toBe("Lückentext");
  });

  it("hits AnkiConnect once across repeated calls", async () => {
    const { request, calls } = fakeRequest();
    await getNoteTypes({}, request);
    await getNoteTypes({}, request);
    await getNoteTypes({}, request);
    // Two per resolution (modelNames + findModelsByName), not six.
    expect(calls()).toBe(2);
  });

  it("resolves once when callers race", async () => {
    const { request, calls } = fakeRequest();
    // The bulk-create case: many notes, all needing the resolution at once.
    await Promise.all([
      getNoteTypes({}, request),
      getNoteTypes({}, request),
      getNoteTypes({}, request),
    ]);
    // Caching the promise rather than the value is what makes this 2 and not 6.
    expect(calls()).toBe(2);
  });

  it("does not cache a failure", async () => {
    // The Anki-not-running case. A cached rejection would leave the server
    // permanently broken even after the user opens Anki.
    const failing = failingRequest(new Error("connect ECONNREFUSED"));
    await expect(getNoteTypes({}, failing.request)).rejects.toThrow(
      "ECONNREFUSED"
    );

    const ok = fakeRequest();
    const resolved = await getNoteTypes({}, ok.request);
    expect(resolved.basic.noteTypeName).toBe("Einfach");
  });

  it("re-reads the collection after invalidation", async () => {
    const first = fakeRequest();
    await getNoteTypes({}, first.request);

    invalidateNoteTypes();

    const renamed: AnkiNoteType[] = [
      { ...COLLECTION[0], name: "Meine Karten" },
      COLLECTION[1],
    ];
    const second = fakeRequest(renamed);
    const resolved = await getNoteTypes({}, second.request);
    expect(resolved.basic.noteTypeName).toBe("Meine Karten");
  });

  it("passes overrides through to resolution", async () => {
    const { request } = fakeRequest();
    const resolved = await getNoteTypes(
      { basicNoteType: "Lückentext" },
      request
    );
    expect(resolved.basic.noteTypeName).toBe("Lückentext");
  });
});

describe("isStaleNoteTypeError", () => {
  it("recognises a renamed note type", () => {
    expect(
      isStaleNoteTypeError(new Error("AnkiConnect error: model was not found: Einfach"))
    ).toBe(true);
  });

  it("recognises a renamed field", () => {
    expect(
      isStaleNoteTypeError(new Error("AnkiConnect error: field Vorderseite not found"))
    ).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isStaleNoteTypeError(new Error("connect ECONNREFUSED"))).toBe(false);
    expect(isStaleNoteTypeError(new Error("deck was not found: X"))).toBe(false);
  });
});
