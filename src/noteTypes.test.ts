import { describe, it, expect } from "vitest";
import {
  AnkiNoteType,
  ENGLISH_DEFAULTS,
  NoteTypeResolutionError,
  fieldsByOrd,
  resolveNoteTypes,
  selectBasicNoteType,
  selectClozeNoteType,
} from "./noteTypes.js";

// Fixture helper. Field order is given by position; `ord` is filled in to match,
// except where a test overrides it to prove the sort is real.
function noteType(
  name: string,
  type: number,
  fields: string[],
  templates: string[] = ["{{Front}}"]
): AnkiNoteType {
  return {
    name,
    type,
    flds: fields.map((f, i) => ({ name: f, ord: i })),
    tmpls: templates.map((qfmt, i) => ({ name: `Card ${i + 1}`, qfmt })),
  };
}

// A stock English collection, transcribed from a live AnkiConnect v6 response.
// The shape of this fixture is the evidence the heuristics are built on, so it
// should be corrected only against a real collection.
const ENGLISH: AnkiNoteType[] = [
  noteType("Basic", 0, ["Front", "Back"], ["{{Front}}"]),
  noteType("Basic (and reversed card)", 0, ["Front", "Back"], [
    "{{Front}}",
    "{{Back}}",
  ]),
  noteType("Basic (optional reversed card)", 0, [
    "Front",
    "Back",
    "Add Reverse",
  ], ["{{Front}}", "{{#Add Reverse}}{{Back}}{{/Add Reverse}}"]),
  noteType("Basic (type in the answer)", 0, ["Front", "Back"], [
    "{{Front}}\n\n{{type:Back}}",
  ]),
  noteType("Cloze", 1, ["Text", "Back Extra"], ["{{cloze:Text}}"]),
  noteType("Image Occlusion", 1, [
    "Occlusion",
    "Image",
    "Header",
    "Back Extra",
    "Comments",
  ], ["{{#Header}}<div>{{Header}}</div>{{/Header}}"]),
];

// A stock German collection, transcribed from a live AnkiConnect v6 response
// against a real Anki profile created with the language set to Deutsch. Names
// translated; structure identical to the English one, which is the entire
// premise of resolving by structure.
//
// Two details here were guessed wrong before checking against real Anki, and
// both matter: the cloze note type's second field is "Rückseite Extra" (not
// "Extra"), and image occlusion is called "Bildverdeckung" and carries five
// fields, so the field-count filter is what keeps it out of the cloze role.
const GERMAN: AnkiNoteType[] = [
  noteType("Einfach", 0, ["Vorderseite", "Rückseite"], ["{{Vorderseite}}"]),
  noteType("Einfach (Antwort eintippen)", 0, ["Vorderseite", "Rückseite"], [
    "{{Vorderseite}}\n\n{{type:Rückseite}}",
  ]),
  noteType(
    "Einfach (und die umgekehrte Richtung)",
    0,
    ["Vorderseite", "Rückseite"],
    ["{{Vorderseite}}", "{{Rückseite}}"]
  ),
  noteType(
    "Einfach (und wahlweise die umgekehrte Richtung)",
    0,
    ["Vorderseite", "Rückseite", "Umgekehrte Richtung hinzufügen"],
    ["{{Vorderseite}}", "{{Rückseite}}"]
  ),
  noteType("Lückentext", 1, ["Text", "Rückseite Extra"], ["{{cloze:Text}}"]),
  noteType(
    "Bildverdeckung",
    1,
    ["Bildverdeckung", "Bild", "Kopfzeile", "Rückseite Extra", "Kommentare"],
    ["{{#Kopfzeile}}<div>{{Kopfzeile}}</div>{{/Kopfzeile}}"]
  ),
];

describe("fieldsByOrd", () => {
  it("returns field names in ord order", () => {
    expect(fieldsByOrd(noteType("X", 0, ["Front", "Back"]))).toEqual([
      "Front",
      "Back",
    ]);
  });

  it("sorts by ord rather than trusting arrival order", () => {
    const scrambled: AnkiNoteType = {
      name: "X",
      type: 0,
      flds: [
        { name: "Back", ord: 1 },
        { name: "Front", ord: 0 },
      ],
      tmpls: [{ name: "Card 1", qfmt: "{{Front}}" }],
    };
    expect(fieldsByOrd(scrambled)).toEqual(["Front", "Back"]);
  });
});

describe("resolveNoteTypes: English collection", () => {
  // This replaces the old constant-spelling test in notes.test.ts. It asserts
  // the same names, but through the whole resolution path rather than by
  // reading a literal back — so it guards the behaviour, not the spelling.
  it("resolves to the built-in English names and fields", () => {
    expect(resolveNoteTypes(ENGLISH)).toEqual({
      basic: {
        noteTypeName: "Basic",
        frontField: ENGLISH_DEFAULTS.frontField,
        backField: ENGLISH_DEFAULTS.backField,
      },
      cloze: {
        noteTypeName: "Cloze",
        textField: ENGLISH_DEFAULTS.textField,
        backExtraField: ENGLISH_DEFAULTS.backExtraField,
      },
    });
  });
});

describe("resolveNoteTypes: German collection (issue #4)", () => {
  it("finds the translated note types and their translated fields", () => {
    expect(resolveNoteTypes(GERMAN)).toEqual({
      basic: {
        noteTypeName: "Einfach",
        frontField: "Vorderseite",
        backField: "Rückseite",
      },
      cloze: {
        noteTypeName: "Lückentext",
        textField: "Text",
        backExtraField: "Rückseite Extra",
      },
    });
  });

  it("excludes the type-in-the-answer variant", () => {
    expect(selectBasicNoteType(GERMAN).name).toBe("Einfach");
  });

  it("excludes image occlusion from the cloze role", () => {
    // Bild-Okklusion is type 1 like Lückentext; only the field count separates
    // them. Without that filter this collection would be ambiguous.
    expect(selectClozeNoteType(GERMAN).name).toBe("Lückentext");
  });
});

describe("selectBasicNoteType", () => {
  it("excludes a two-template note type", () => {
    const types = [
      noteType("Reversed", 0, ["A", "B"], ["{{A}}", "{{B}}"]),
      noteType("Plain", 0, ["A", "B"], ["{{A}}"]),
    ];
    expect(selectBasicNoteType(types).name).toBe("Plain");
  });

  it("excludes a type-in-the-answer note type", () => {
    const types = [
      noteType("Typed", 0, ["A", "B"], ["{{A}}{{type:B}}"]),
      noteType("Plain", 0, ["A", "B"], ["{{A}}"]),
    ];
    expect(selectBasicNoteType(types).name).toBe("Plain");
  });

  it("excludes a three-field note type", () => {
    const types = [
      noteType("Three", 0, ["A", "B", "C"], ["{{A}}"]),
      noteType("Plain", 0, ["A", "B"], ["{{A}}"]),
    ];
    expect(selectBasicNoteType(types).name).toBe("Plain");
  });

  it("throws when several note types qualify", () => {
    const types = [
      noteType("Einfach", 0, ["A", "B"], ["{{A}}"]),
      noteType("Meine Karten", 0, ["A", "B"], ["{{A}}"]),
    ];
    expect(() => selectBasicNoteType(types)).toThrow(NoteTypeResolutionError);
  });

  it("names every candidate and the env var in the message", () => {
    const types = [
      noteType("Einfach", 0, ["A", "B"], ["{{A}}"]),
      noteType("Meine Karten", 0, ["A", "B"], ["{{A}}"]),
    ];
    try {
      selectBasicNoteType(types);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as NoteTypeResolutionError;
      expect(err.candidates).toEqual(["Einfach", "Meine Karten"]);
      // The message is acted on by a model, so it must carry the fix.
      expect(err.message).toContain("CLANKI_BASIC_NOTE_TYPE");
      expect(err.message).toContain("Einfach");
      expect(err.message).toContain("Meine Karten");
    }
  });

  it("lists the collection's note types when nothing qualifies", () => {
    const types = [noteType("Odd", 0, ["A", "B", "C"], ["{{A}}"])];
    try {
      selectBasicNoteType(types);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as NoteTypeResolutionError;
      expect(err.candidates).toEqual(["Odd"]);
      expect(err.message).toContain("none");
    }
  });

  it("does not short-circuit on the name Basic when its fields were renamed", () => {
    // A user who renamed Basic's fields but kept its name must go through
    // detection, or we would write to Front/Back and lose the content.
    const types = [
      noteType("Basic", 0, ["Question", "Answer"], ["{{Question}}"]),
      noteType("Cloze", 1, ["Text", "Back Extra"], ["{{cloze:Text}}"]),
    ];
    expect(resolveNoteTypes(types).basic).toEqual({
      noteTypeName: "Basic",
      frontField: "Question",
      backField: "Answer",
    });
  });
});

describe("selectClozeNoteType", () => {
  it("throws when two cloze note types have two fields each", () => {
    const types = [
      noteType("Cloze A", 1, ["Text", "Extra"], ["{{cloze:Text}}"]),
      noteType("Cloze B", 1, ["Text", "Extra"], ["{{cloze:Text}}"]),
    ];
    expect(() => selectClozeNoteType(types)).toThrow(NoteTypeResolutionError);
  });

  it("throws when the collection has no cloze note type", () => {
    const types = [noteType("Plain", 0, ["A", "B"], ["{{A}}"])];
    expect(() => selectClozeNoteType(types)).toThrow(/CLANKI_CLOZE_NOTE_TYPE/);
  });
});

describe("overrides", () => {
  it("selects the named note type and reads its fields", () => {
    const resolved = resolveNoteTypes(GERMAN, {
      basicNoteType: "Einfach (Antwort eintippen)",
    });
    expect(resolved.basic).toEqual({
      noteTypeName: "Einfach (Antwort eintippen)",
      frontField: "Vorderseite",
      backField: "Rückseite",
    });
  });

  it("resolves an otherwise ambiguous collection", () => {
    const types = [
      noteType("Einfach", 0, ["A", "B"], ["{{A}}"]),
      noteType("Meine Karten", 0, ["A", "B"], ["{{A}}"]),
      noteType("Lückentext", 1, ["Text", "Extra"], ["{{cloze:Text}}"]),
    ];
    expect(() => resolveNoteTypes(types)).toThrow(NoteTypeResolutionError);
    expect(
      resolveNoteTypes(types, { basicNoteType: "Meine Karten" }).basic
        .noteTypeName
    ).toBe("Meine Karten");
  });

  it("rejects a note type name the collection does not have", () => {
    expect(() =>
      resolveNoteTypes(GERMAN, { basicNoteType: "Nonexistent" })
    ).toThrow(/no note type with that name/);
  });

  it("accepts explicit field names that exist", () => {
    const resolved = resolveNoteTypes(GERMAN, {
      basicNoteType: "Einfach",
      basicFields: ["Rückseite", "Vorderseite"],
    });
    // Order is the caller's: this is how a user flips an unusual field order.
    expect(resolved.basic.frontField).toBe("Rückseite");
    expect(resolved.basic.backField).toBe("Vorderseite");
  });

  it("rejects a field name the note type does not have", () => {
    // The load-bearing case: an unvalidated typo here would be accepted by
    // AnkiConnect and the content silently discarded.
    expect(() =>
      resolveNoteTypes(GERMAN, {
        basicNoteType: "Einfach",
        basicFields: ["Vorderseite", "Ruckseite"],
      })
    ).toThrow(/"Ruckseite" do not exist/);
  });

  it("rejects a single field name", () => {
    expect(() =>
      resolveNoteTypes(GERMAN, {
        basicNoteType: "Einfach",
        basicFields: ["Vorderseite"],
      })
    ).toThrow(/got 1/);
  });

  it("rejects a note type with fewer than two fields", () => {
    const types = [
      ...GERMAN,
      noteType("Einzeln", 0, ["Nur eins"], ["{{Nur eins}}"]),
    ];
    expect(() =>
      resolveNoteTypes(types, { basicNoteType: "Einzeln" })
    ).toThrow(/Clanki needs at least 2/);
  });
});
