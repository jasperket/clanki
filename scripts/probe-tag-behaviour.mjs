#!/usr/bin/env node
//
// Re-runs the probe that established the Tag rules in
// docs/adr/0005-domain-invariants-live-in-the-domain-layer.md.
//
// Anki does not document a Tag grammar, so `validateTags` in src/notes.ts is
// built from observed behaviour on one Anki version. That makes it a snapshot,
// not a specification: if Anki changes how it normalises Tags, the sets in
// notes.ts become wrong and the unit tests keep passing, because they assert
// our rules rather than Anki's. This script is how you find out.
//
// Run it when upgrading Anki, or when a Tag behaves unexpectedly:
//
//   npm run probe:tags
//
// It needs Anki running with AnkiConnect on 127.0.0.1:8765. It writes ~45
// throwaway Notes to a deck named below and deletes them again, including a
// collection-wide `clearUnusedTags` at the end -- which also sweeps unused Tags
// that were already in the collection. It never touches an existing deck.
//
// Expected output is "MATCHES ADR 0005" for every row. Any DIFFERS row means
// Anki changed and src/notes.ts needs revisiting.

const ANKI_CONNECT = "http://127.0.0.1:8765";
const PROBE_DECK = "clanki-tag-probe";

async function call(action, params) {
  const response = await fetch(ANKI_CONNECT, {
    method: "POST",
    body: JSON.stringify({ action, version: 6, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${action}: ${body.error}`);
  return body.result;
}

// What ADR 0005 recorded. Anything not listed here is expected to survive
// unchanged. Keep this table in sync with the ADR, not with notes.ts: the point
// is to compare Anki against what we observed, not against what we implemented.
const EXPECTED = new Map([
  [0x0020, "split"],
  [0x3000, "split"],
  [0x0009, "deleted"],
  [0x000a, "deleted"],
  [0x000b, "deleted"],
  [0x000c, "deleted"],
  [0x000d, "deleted"],
  [0x2000, "normalised:2002"],
  [0x2001, "normalised:2003"],
]);

// Every codepoint JS /\s/ matches, plus adjacent controls and zero-width
// characters that a pasted Tag can plausibly carry.
const CODEPOINTS = [
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x0085, 0x00a0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008,
  0x2009, 0x200a, 0x200b, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
];

const hex = (cp) => "U+" + cp.toString(16).toUpperCase().padStart(4, "0");

// Classify what Anki did to "aa<char>bb".
function classify(sentCodepoint, storedTags) {
  if (storedTags.length > 1) return "split";
  if (storedTags.length === 0) return "dropped";

  const middle = [...storedTags[0]].slice(2, -2).map((c) => c.codePointAt(0));
  if (middle.length === 0) return "deleted";
  if (middle.length === 1 && middle[0] === sentCodepoint) return "survives";
  return "normalised:" + middle.map((c) => c.toString(16)).join("+");
}

async function main() {
  await call("version");
  await call("createDeck", { deck: PROBE_DECK });

  const added = [];
  for (const cp of CODEPOINTS) {
    const noteId = await call("addNote", {
      note: {
        deckName: PROBE_DECK,
        modelName: "Basic",
        fields: { Front: `cp-${cp.toString(16)}`, Back: "probe" },
        tags: [`aa${String.fromCodePoint(cp)}bb`],
      },
    });
    added.push({ cp, noteId });
  }

  const info = await call("notesInfo", { notes: added.map((a) => a.noteId) });
  const tagsByNote = new Map(info.map((n) => [n.noteId, n.tags]));

  let differences = 0;
  console.log("codepoint  observed          expected          verdict");
  for (const { cp, noteId } of added) {
    const observed = classify(cp, tagsByNote.get(noteId) ?? []);
    const expected = EXPECTED.get(cp) ?? "survives";
    const matches = observed === expected;
    if (!matches) differences++;
    console.log(
      `${hex(cp).padEnd(10)} ${observed.padEnd(17)} ${expected.padEnd(17)} ` +
        `${matches ? "matches ADR 0005" : "DIFFERS -- revisit src/notes.ts"}`
    );
  }

  // Behaviours that are not per-codepoint but still shape validateTags: the
  // trim() equivalence in particular, which is why leading/trailing whitespace
  // is deliberately accepted.
  console.log("\nother behaviours:");
  const extras = [
    ["leading/trailing ASCII", "  padded  ", "stripped to 'padded'"],
    ["leading/trailing NBSP", "\u00a0padded\u00a0", "stripped (so JS trim() matches Anki)"],
    ["leading/trailing U+3000", "\u3000padded\u3000", "stripped, not split"],
    ["all whitespace", "   ", "dropped entirely"],
    ["empty string", "", "dropped entirely"],
    ["hierarchy", "parent::child", "survives as one Tag"],
    ["double quote", 'say"what', "survives"],
    ["non-ASCII letters", "Pr\u00fcfung\u6f22\u5b57", "survives"],
  ];
  for (const [label, tag, expectation] of extras) {
    const noteId = await call("addNote", {
      note: {
        deckName: PROBE_DECK,
        modelName: "Basic",
        fields: { Front: `extra-${label}`, Back: "probe" },
        tags: [tag],
      },
    });
    const [note] = await call("notesInfo", { notes: [noteId] });
    console.log(`  ${label.padEnd(24)} -> ${JSON.stringify(note.tags).padEnd(24)} expected: ${expectation}`);
  }

  // Case folding needs two separate Notes: dedupe on one Note is a different
  // mechanism from the collection folding a new Tag to an existing casing.
  for (const tag of ["Biology", "biology"]) {
    await call("addNote", {
      note: {
        deckName: PROBE_DECK,
        modelName: "Basic",
        fields: { Front: `case-${tag}`, Back: "probe" },
        tags: [tag],
      },
    });
  }
  const caseNotes = await call("notesInfo", {
    notes: await call("findNotes", { query: `deck:${PROBE_DECK} Front:case-*` }),
  });
  console.log(
    `  ${"case folding".padEnd(24)} -> ${JSON.stringify(caseNotes.map((n) => n.tags).flat())}` +
      "  expected: both 'Biology' (first casing wins)"
  );

  const noteIds = await call("findNotes", { query: `deck:${PROBE_DECK}` });
  await call("deleteNotes", { notes: noteIds });
  await call("deleteDecks", { decks: [PROBE_DECK], cardsToo: true });
  await call("clearUnusedTags");
  console.log(`\ncleaned up ${noteIds.length} notes and the ${PROBE_DECK} deck`);

  if (differences > 0) {
    console.error(
      `\n${differences} codepoint(s) differ from ADR 0005. Anki's Tag handling ` +
        "has changed: update TAG_SPLITTING_CHARS / TAG_STRIPPED_CHARS in " +
        "src/notes.ts, the table in the ADR, and the tests."
    );
    process.exit(1);
  }
  console.log("all codepoints match ADR 0005");
}

main().catch((error) => {
  console.error(`\nprobe failed: ${error.message}`);
  console.error(
    "Anki must be running with AnkiConnect on 127.0.0.1:8765. If the probe " +
      `died midway, delete the '${PROBE_DECK}' deck by hand.`
  );
  process.exit(1);
});
