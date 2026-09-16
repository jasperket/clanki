#!/usr/bin/env node
//
// Re-runs the probe that established the Deck name rules in the Deck entry of
// CONTEXT.md.
//
// Anki does not document a Deck name grammar, so `validateDeckName` in
// src/notes.ts is built from observed behaviour on one Anki version. That makes
// it a snapshot, not a specification: if Anki changes how it handles an empty
// name, the rule in notes.ts becomes wrong and the unit tests keep passing,
// because they assert our rules rather than Anki's. This script is how you find
// out.
//
// Run it when upgrading Anki, or when a Deck name does something surprising:
//
//   npm run probe:decks
//
// It needs Anki running with AnkiConnect on 127.0.0.1:8765. It creates ~14
// throwaway decks named below and deletes them again. It never touches an
// existing deck -- but note that an empty name is one of the cases, and Anki
// files that under a deck named `blank`, which is created and then deleted with
// the rest. If you already have a deck named `blank`, this script will delete
// it, so rename yours first.
//
// Expected output is "matches" for every row. Any DIFFERS row means Anki changed
// and src/notes.ts plus the CONTEXT.md Deck entry need revisiting.

const ANKI_CONNECT = "http://127.0.0.1:8765";
const PROBE = "clanki-deck-probe";

async function call(action, params) {
  const response = await fetch(ANKI_CONNECT, {
    method: "POST",
    body: JSON.stringify({ action, version: 6, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${action}: ${body.error}`);
  return body.result;
}

// What CONTEXT.md records. Each case sends a name to createDeck and lists the
// deck names that must exist afterwards. Keep this table in sync with the
// CONTEXT.md Deck entry, not with notes.ts: the point is to compare Anki
// against what we observed, not against what we implemented.
//
// `blank` is Anki's own substitution for an empty path segment, which is the
// single most surprising finding here and the reason validateDeckName exists.
const CASES = [
  {
    label: "nested",
    sent: `${PROBE}::child`,
    expect: [PROBE, `${PROBE}::child`],
    why: ":: nests, and the parent is auto-created",
  },
  {
    label: "empty name",
    sent: "",
    expect: ["blank"],
    why: "NOT refused -- Anki invents a deck named blank",
  },
  {
    label: "all whitespace",
    sent: "   ",
    expect: ["blank"],
    why: "same as empty, which .min(1) cannot see",
  },
  {
    label: "leading separator",
    sent: `::${PROBE}lead`,
    expect: [`blank::${PROBE}lead`],
    why: "empty leading segment becomes blank",
  },
  {
    label: "trailing separator",
    sent: `${PROBE}trail::`,
    expect: [`${PROBE}trail`, `${PROBE}trail::blank`],
    why: "empty trailing segment becomes blank",
  },
  {
    label: "empty interior segment",
    sent: `${PROBE}empty::::b`,
    expect: [
      `${PROBE}empty`,
      `${PROBE}empty::blank`,
      `${PROBE}empty::blank::b`,
    ],
    why: "empty interior segment becomes blank",
  },
  {
    label: "space around separator",
    sent: `${PROBE}sp :: b`,
    expect: [`${PROBE}sp`, `${PROBE}sp::b`],
    why: "whitespace around :: is trimmed",
  },
  {
    label: "space in name",
    sent: `${PROBE} with space`,
    expect: [`${PROBE} with space`],
    why: "a Deck name may contain a space -- a Tag may not",
  },
  {
    label: "double quote",
    sent: `${PROBE}dq"x`,
    expect: [`${PROBE}dq"x`],
    why: "survives unchanged",
  },
  {
    label: "single quote",
    sent: `${PROBE}sq'x`,
    expect: [`${PROBE}sq'x`],
    why: "survives unchanged",
  },
  {
    label: "star",
    sent: `${PROBE}st*x`,
    expect: [`${PROBE}st*x`],
    why: "survives unchanged",
  },
  {
    label: "single colon",
    sent: `${PROBE}cs:x`,
    expect: [`${PROBE}cs:x`],
    why: "a lone colon is not a separator",
  },
];

async function main() {
  await call("version");

  const before = new Set(await call("deckNames"));
  if (before.has("blank")) {
    console.error(
      "A deck named 'blank' already exists. This probe creates and deletes " +
        "that name, so rename yours before running it."
    );
    process.exit(1);
  }

  for (const { sent } of CASES) {
    await call("createDeck", { deck: sent });
  }

  const after = await call("deckNames");
  const created = new Set(after.filter((d) => !before.has(d)));

  let differences = 0;
  console.log("case                    verdict");
  for (const { label, sent, expect, why } of CASES) {
    const missing = expect.filter((d) => !created.has(d));
    const matches = missing.length === 0;
    if (!matches) differences++;
    console.log(
      `${label.padEnd(23)} ${matches ? "matches" : "DIFFERS"}  sent ${JSON.stringify(sent)} -> ` +
        `expected ${JSON.stringify(expect)}${matches ? "" : ` MISSING ${JSON.stringify(missing)}`}`
    );
    console.log(`${" ".repeat(23)} ${why}`);
  }

  // Not a creation rule, but the reason deck names cannot be pasted into a
  // search query unquoted. Tracked as its own issue; probed here because this
  // is where the deck with a space already exists.
  const spaced = `${PROBE} with space`;
  const model = (await call("modelNames")).find((m) => /^basic$/i.test(m));
  if (model) {
    await call("addNote", {
      note: {
        deckName: spaced,
        modelName: model,
        fields: { Front: "query-probe", Back: "probe" },
        options: { allowDuplicate: true },
      },
    });
    const unquoted = await call("findNotes", { query: `deck:${spaced}` });
    const quoted = await call("findNotes", { query: `deck:"${spaced}"` });
    console.log(
      `\nquery round-trip for a deck name with a space:\n` +
        `  deck:${spaced}   -> ${unquoted.length} notes\n` +
        `  deck:"${spaced}" -> ${quoted.length} notes\n` +
        `  expected 0 then 1: an unquoted space splits the query term`
    );
  }

  const noteIds = await call("findNotes", {
    query: created.size
      ? [...created].map((d) => `"deck:${d.replace(/"/g, '\\"')}"`).join(" OR ")
      : "deck:__none__",
  });
  if (noteIds.length) await call("deleteNotes", { notes: noteIds });
  if (created.size) await call("deleteDecks", { decks: [...created], cardsToo: true });

  const remaining = (await call("deckNames")).filter((d) => !before.has(d));
  console.log(
    `\ncleaned up ${noteIds.length} notes and ${created.size} decks` +
      (remaining.length ? ` -- LEFTOVER: ${JSON.stringify(remaining)}` : "")
  );

  if (differences > 0) {
    console.error(
      `\n${differences} case(s) differ from CONTEXT.md. Anki's Deck name ` +
        "handling has changed: update validateDeckName in src/notes.ts, the " +
        "Deck entry in CONTEXT.md, and the tests."
    );
    process.exit(1);
  }
  if (remaining.length) {
    console.error("\nCleanup left decks behind. Delete them by hand.");
    process.exit(1);
  }
  console.log("all cases match CONTEXT.md");
}

main().catch((error) => {
  console.error(`\nprobe failed: ${error.message}`);
  console.error(
    "Anki must be running with AnkiConnect on 127.0.0.1:8765. If the probe " +
      `died midway, delete the '${PROBE}*' and 'blank' decks by hand.`
  );
  process.exit(1);
});
