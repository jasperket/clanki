import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildMediaArray,
  buildMediaMessage,
  buildSkippedMessage,
  extensionFromUrl,
  sanitizeToken,
} from "./media.js";

const IMG = "https://example.com/a.jpg";

function filenames(...results: ReturnType<typeof buildMediaArray>[]) {
  return results.flatMap((r) => r.items.map((i) => i.filename));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("uniqueness", () => {
  // The regression being fixed: the old scheme was
  // `${type}_${field}_${Date.now()}_${index}`, so two cards created in the same
  // millisecond both produced ..._0.jpg.
  it("differs across calls even when the clock is frozen", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const a = buildMediaArray([IMG], "Front", "image");
    const b = buildMediaArray([IMG], "Front", "image");

    expect(a.items[0].filename).not.toBe(b.items[0].filename);
  });

  it("differs for the same URL repeated within one call", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const names = filenames(buildMediaArray([IMG, IMG, IMG], "Front", "image"));

    expect(new Set(names).size).toBe(3);
  });

  it("produces no duplicates when Front and Back results are concatenated", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const names = filenames(
      buildMediaArray([IMG], "Front", "image"),
      buildMediaArray([IMG], "Back", "image")
    );

    expect(new Set(names).size).toBe(names.length);
  });

  it("sets deleteExisting false on every item", () => {
    const { items } = buildMediaArray([IMG], "Front", "image");
    expect(items.every((i) => i.deleteExisting === false)).toBe(true);
  });
});

describe("extension handling", () => {
  const ext = (url: string, type: "image" | "audio" = "image") =>
    extensionFromUrl(new URL(url), type);

  it("lowercases", () => {
    expect(ext("https://e.com/a.JPG")).toBe("jpg");
  });

  it("takes the last dot", () => {
    expect(ext("https://e.com/archive.tar.gz")).toBe("gz");
  });

  it("strips percent-decoded path traversal", () => {
    // new URL() decodes %2e%2e%2f into ../ before we ever see it.
    const name = buildMediaArray(
      ["https://e.com/a.%2e%2e%2fetc%2fpasswd"],
      "Front",
      "image"
    ).items[0].filename;

    expect(name).not.toContain("/");
    expect(name).not.toContain("..");
  });

  it("strips NUL bytes", () => {
    const name = buildMediaArray(
      ["https://e.com/a.jpg%00.txt"],
      "Front",
      "image"
    ).items[0].filename;
    expect(name).not.toContain("\0");
  });

  it("strips the NTFS alternate-data-stream separator", () => {
    const name = buildMediaArray(
      ["https://e.com/a.jpg:Zone.Identifier"],
      "Front",
      "image"
    ).items[0].filename;
    expect(name).not.toContain(":");
  });

  it("truncates an absurdly long extension", () => {
    expect(ext("https://e.com/a." + "x".repeat(5000)).length).toBeLessThanOrEqual(8);
  });

  it("falls back by media type when there is no usable extension", () => {
    expect(ext("https://e.com/dir/")).toBe("jpg");
    expect(ext("https://e.com/image")).toBe("jpg");
    expect(ext("https://e.com/a.")).toBe("jpg");
    expect(ext("https://e.com/dir/", "audio")).toBe("mp3");
  });

  it("never produces a filename ending in a dot", () => {
    const name = buildMediaArray(["https://e.com/a."], "Front", "image")
      .items[0].filename;
    expect(name.endsWith(".")).toBe(false);
  });
});

describe("field names", () => {
  it("slugs the field for the filename but sends the raw name to Anki", () => {
    // "Back Extra" must keep its space in `fields` — Anki matches it against
    // the note type's real field name.
    const { items } = buildMediaArray([IMG], "Back Extra", "image");

    expect(items[0].fields).toEqual(["Back Extra"]);
    expect(items[0].filename).not.toContain(" ");
    expect(items[0].filename).toContain("backextra");
  });

  it("still produces a valid filename when the field slugs to empty", () => {
    const { items } = buildMediaArray([IMG], "日本語", "image");
    expect(items).toHaveLength(1);
    expect(items[0].filename).toMatch(/^image__\d+_[0-9a-f]{16}\.jpg$/);
  });

  it("bounds a very long field name", () => {
    const { items } = buildMediaArray([IMG], "a".repeat(500), "image");
    expect(items[0].filename.length).toBeLessThanOrEqual(120);
  });
});

describe("length", () => {
  it("stays within 120 bytes and keeps the full random component", () => {
    const { items } = buildMediaArray(
      ["https://e.com/a." + "x".repeat(5000)],
      "z".repeat(500),
      "image"
    );
    const name = items[0].filename;

    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(120);
    // The 16-hex-char random suffix must survive truncation: it is the entropy
    // the whole fix depends on.
    expect(name).toMatch(/_[0-9a-f]{16}\./);
  });
});

describe("URL validation", () => {
  it("returns empty for undefined and empty input", () => {
    expect(buildMediaArray(undefined, "Front", "image")).toEqual({
      items: [],
      skipped: [],
    });
    expect(buildMediaArray([], "Front", "image")).toEqual({
      items: [],
      skipped: [],
    });
  });

  it("skips malformed URLs without throwing and keeps valid siblings", () => {
    const { items, skipped } = buildMediaArray(
      ["not a url", IMG, ""],
      "Front",
      "image"
    );

    expect(items).toHaveLength(1);
    expect(skipped).toEqual(["not a url", ""]);
  });

  it("rejects non-http protocols", () => {
    const { items, skipped } = buildMediaArray(
      ["file:///etc/passwd", "data:text/html,x"],
      "Front",
      "image"
    );

    expect(items).toHaveLength(0);
    expect(skipped).toHaveLength(2);
  });

  it("passes the original URL through unmodified", () => {
    // Query and signature params must reach AnkiConnect intact.
    const signed = "https://e.com/a.jpg?sig=abc%20def&x=1";
    const { items } = buildMediaArray([signed], "Front", "image");
    expect(items[0].url).toBe(signed);
  });

  it("returns no items when every URL is invalid", () => {
    // Keeps the caller's `picture.length > 0` guard from adding the key.
    const { items } = buildMediaArray(["nope", "also nope"], "Front", "image");
    expect(items).toHaveLength(0);
  });
});

describe("messages", () => {
  it("describes counts, and is empty when there is no media", () => {
    expect(buildMediaMessage(0, 0)).toBe("");
    expect(buildMediaMessage(2, 0)).toBe(" with 2 image(s)");
    expect(buildMediaMessage(1, 3)).toBe(" with 1 image(s) and 3 audio file(s)");
  });

  it("names skipped URLs, and is empty when none were skipped", () => {
    expect(buildSkippedMessage([])).toBe("");
    expect(buildSkippedMessage(["a", "b"])).toContain("Skipped 2 invalid URL(s)");
    expect(buildSkippedMessage(["a", "b"])).toContain("a, b");
  });
});

describe("sanitizeToken", () => {
  it("keeps only lowercase alphanumerics and bounds length", () => {
    expect(sanitizeToken("Back Extra", 20)).toBe("backextra");
    expect(sanitizeToken("A-B_C.D", 20)).toBe("abcd");
    expect(sanitizeToken("abcdef", 3)).toBe("abc");
  });
});
