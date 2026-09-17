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
// It also settles which characters `quoteSearchTerm` must escape inside a
// quoted `deck:"..."` term, which is the other half of what src/notes.ts claims
// about Deck names and was established the same way -- by experiment, for issue
// #24. See QUERY_CASES below.
//
// It needs Anki running with AnkiConnect on 127.0.0.1:8765. It creates ~18
// throwaway decks named below, puts one Note in several of them, and deletes
// them all again. It never touches an existing deck -- but note that an empty
// name is one of the cases, and Anki files that under a deck named `blank`,
// which is created and then deleted with the rest. If you already have a deck
// named `blank`, this script will delete it, so rename yours first.
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
  {
    label: "underscore",
    sent: `${PROBE}un_x`,
    expect: [`${PROBE}un_x`],
    why: "survives unchanged -- but is a wildcard in a search",
  },
  {
    label: "underscore decoy",
    sent: `${PROBE}unZx`,
    expect: [`${PROBE}unZx`],
    why: "differs from the underscore deck only where `_` would match",
  },
  {
    label: "star decoy",
    sent: `${PROBE}stZZx`,
    expect: [`${PROBE}stZZx`],
    why: "differs from the star deck only where `*` would match",
  },
  {
    label: "ampersand",
    sent: `${PROBE}am&x`,
    expect: [`${PROBE}am&x`],
    why: "survives unchanged -- NOT stored as an HTML entity",
  },
];

// The escape set `quoteSearchTerm` in src/notes.ts applies, and the question
// each row answers: once the term is quoted, is this character still special?
//
// The Anki manual lists characters that need a backslash, but not which of them
// still matter INSIDE a quoted term -- and ADR 0005's rule is not to mangle what
// Anki handles fine. So each row is decided by experiment, not by the manual.
//
// `decoy` is what makes a wrong answer visible. It is a deck whose name differs
// from `name` only where the character under test would act as a wildcard, so an
// unescaped special character matches BOTH and the count comes back above 1.
// Without a decoy a wildcard looks identical to a literal.
//
// The decoy must HOLD A NOTE or the experiment silently proves nothing: an
// unescaped wildcard still matches the decoy deck, but `findNotes` counts Notes,
// so an empty decoy returns the same 1 as a correct query. Every deck named here
// gets a Note, decoys included.
//
// `mustEscape` records what we concluded. A row that flips means Anki changed
// and `SEARCH_TERM_ESCAPES` in src/notes.ts needs revisiting.
const QUERY_CASES = [
  {
    label: "space",
    name: `${PROBE} with space`,
    mustEscape: false,
    why: "quoting alone fixes it -- an unquoted space ends the term",
    unquotedMustFail: true,
  },
  {
    label: "star",
    name: `${PROBE}st*x`,
    decoy: `${PROBE}stZZx`,
    mustEscape: true,
    why: "a multi-character wildcard -- unescaped it matches the decoy too",
    unquotedMustFail: true,
  },
  {
    label: "underscore",
    name: `${PROBE}un_x`,
    decoy: `${PROBE}unZx`,
    mustEscape: true,
    why: "a single-character wildcard -- unescaped it matches the decoy too",
  },
  {
    // The one row whose `quoted-only` column cannot show a failure: the query
    // would not parse at all without escaping the quote, so that column escapes
    // it by construction. `unquotedMustFail` carries this row's evidence
    // instead -- Anki rejects the raw query outright.
    label: "double quote",
    name: `${PROBE}dq"x`,
    mustEscape: true,
    selfEvident: true,
    unquotedMustFail: true,
    why: "unescaped it closes the term and Anki rejects the whole query",
  },
  {
    label: "single colon",
    name: `${PROBE}cs:x`,
    mustEscape: false,
    why: "deck:\"...\" consumes the key before the quote opens so `:` is data",
  },
  {
    label: "ampersand",
    name: `${PROBE}am&x`,
    mustEscape: false,
    why: "the HTML entity rule is for Note content not for a Deck name",
  },
  {
    label: "single quote",
    name: `${PROBE}sq'x`,
    mustEscape: false,
    why: "not special to Anki's search syntax at all",
  },
];

// A DELIBERATE DUPLICATE of `quoteSearchTerm` in src/notes.ts.
//
// This is a plain .mjs script run straight by node, so it cannot import the
// TypeScript helper without adding a build step to a probe whose whole value is
// that it runs on its own. The copy is the lesser evil, but it is a copy:
// CHANGE BOTH TOGETHER. The unit tests in src/notes.test.ts are the authority on
// what the real helper does; this exists only so the probe's own queries are
// built the same way as the ones under test.
const SEARCH_TERM_ESCAPES = ["\\", '"', "*", "_"];

function quoteSearchTerm(term) {
  let escaped = term;
  for (const character of SEARCH_TERM_ESCAPES) {
    escaped = escaped.split(character).join(`\\${character}`);
  }
  return `"${escaped}"`;
}

// The same term with ONLY the double quote escaped, which is the minimum that
// keeps a query parseable. Anything this matches beyond the one intended deck is
// a character acting as a wildcard.
function quoteWithoutEscapes(term) {
  return `"${term.split('"').join('\\"')}"`;
}

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

  // Not a creation rule, but the reason a Deck name cannot be pasted into a
  // search query unquoted (issue #24), and the experiment that decided the
  // escape set in `quoteSearchTerm`. Probed here because this is where the decks
  // with the awkward names already exist.
  //
  // Each row puts one Note in its deck and runs the query two ways. A count
  // above 1 means the character matched a decoy deck as well, which is the
  // silent-wrong-answer half of the bug.
  const model = (await call("modelNames")).find((m) => /^basic$/i.test(m));
  if (!model) {
    console.error(
      "\nNo Basic note type found so the query cases were skipped. The escape " +
        "set in src/notes.ts is NOT verified by this run."
    );
    differences++;
  } else {
    // Field names are read from the collection rather than assumed: Anki
    // translates them, so `Front`/`Back` only exist in an English collection
    // (CONTEXT.md: Field).
    const fields = await call("modelFieldNames", { modelName: model });

    // Decoys get a Note too. Without one an unescaped wildcard still matches the
    // decoy deck but finds nothing in it, so the count stays at 1 and the
    // experiment reports "no escape needed" for a character that badly needs it.
    const needNotes = [];
    for (const { name, decoy } of QUERY_CASES) {
      needNotes.push(name);
      if (decoy) needNotes.push(decoy);
    }

    for (const deckName of needNotes) {
      const noteFields = { [fields[0]]: `query-probe ${deckName}` };
      if (fields[1]) noteFields[fields[1]] = "probe";
      await call("addNote", {
        note: {
          deckName,
          modelName: model,
          fields: noteFields,
          options: { allowDuplicate: true },
        },
      });
    }

    console.log("\nquery case              verdict");
    for (const {
      label,
      name,
      mustEscape,
      selfEvident,
      unquotedMustFail,
      why,
    } of QUERY_CASES) {
      // Escaped per our real rule. This must always find exactly the one Note.
      const escaped = await call("findNotes", {
        query: `deck:${quoteSearchTerm(name)}`,
      });

      // Quoted but with the character left alone. Anki rejects an unescaped `"`
      // outright, so a thrown error here is itself the finding.
      let bare;
      try {
        bare = (
          await call("findNotes", { query: `deck:${quoteWithoutEscapes(name)}` })
        ).length;
      } catch {
        bare = "rejected";
      }

      // Fully unquoted, which is what the bug did.
      let raw;
      try {
        raw = (await call("findNotes", { query: `deck:${name}` })).length;
      } catch {
        raw = "rejected";
      }

      // The hard requirement: our escaping finds the one Note and nothing else.
      let ok = escaped.length === 1;
      // And what we concluded about this character still holds. Skipped for a
      // selfEvident row, whose quoted-only column is escaped by construction and
      // so cannot distinguish anything.
      if (!selfEvident) {
        if (mustEscape && bare === 1) ok = false;
        if (!mustEscape && bare !== 1) ok = false;
      }
      // For the two characters where an unquoted query was observed to break,
      // it must still break -- otherwise the bug this probe guards is gone and
      // the reasoning behind the fix needs rechecking.
      if (unquotedMustFail && raw === 1) ok = false;

      if (!ok) differences++;
      console.log(
        `${label.padEnd(23)} ${ok ? "matches" : "DIFFERS"}  escaped ${escaped.length} / ` +
          `quoted-only ${bare} / unquoted ${raw}  ` +
          `(escape ${mustEscape ? "required" : "not needed"})`
      );
      console.log(`${" ".repeat(23)} ${why}`);
    }
  }

  const noteIds = await call("findNotes", {
    query: created.size
      ? [...created].map((d) => `deck:${quoteSearchTerm(d)}`).join(" OR ")
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
      `\n${differences} case(s) differ from what is recorded. Anki's Deck name ` +
        "or search handling has changed: update validateDeckName and " +
        "SEARCH_TERM_ESCAPES in src/notes.ts, the Deck entry in CONTEXT.md, and " +
        "the tests. Note that quoteSearchTerm is duplicated in this script and " +
        "both copies must change together."
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
