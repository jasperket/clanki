import { randomBytes } from "crypto";

export interface MediaItem {
  url: string;
  filename: string;
  // AnkiConnect's addMedia passes this straight to storeMediaFile. Omitting it
  // sends `None`, which is falsy there, so the existing file is never deleted —
  // we set it explicitly so the intent survives a future reading of that code.
  deleteExisting: boolean;
  fields: string[];
}

export interface MediaArrayResult {
  items: MediaItem[];
  skipped: string[];
}

// Media filenames become real files in Anki's media folder, and the URLs can
// come from an LLM reading untrusted pages, so every component is allowlisted
// rather than denylisted. Anki caps media filenames at 120 bytes; bounding each
// component keeps us well under that, so the random suffix is never truncated
// away and no truncation step is needed at all.
const MAX_EXTENSION_LENGTH = 8;
const MAX_FIELD_SLUG_LENGTH = 20;
// Long enough to identify which URL was rejected, short enough that a crafted
// value cannot bury the real message under a wall of text.
const MAX_SKIPPED_URL_DISPLAY_LENGTH = 80;

// The worst case a filename can reach, derived from the bounds above rather
// than asserted as a round number, so that raising any one of them updates
// this and trips the test that checks it against Anki's own 120-byte cap.
//   "image" + "_" + slug + "_" + 13-digit ms + "_" + 16 hex + "." + extension
export const MAX_MEDIA_FILENAME_LENGTH =
  "image".length +
  1 +
  MAX_FIELD_SLUG_LENGTH +
  1 +
  13 +
  1 +
  16 +
  1 +
  MAX_EXTENSION_LENGTH;

export function sanitizeToken(value: string, maxLength: number): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, maxLength);
}

// Anki fetches the bytes itself; the URL path is only a hint about what they
// are, and often a wrong one (`/render.php?id=7` is an image served by a
// script). A filename whose extension does not match the real format can stop
// the card rendering, so only an extension that actually names a media format
// of the expected kind is trusted — anything else falls back to the default for
// the media type, which is at least the right kind of file.
const IMAGE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "avif",
  "svg",
  "bmp",
  "tif",
  "tiff",
  "ico",
]);

const AUDIO_EXTENSIONS = new Set([
  "mp3",
  "ogg",
  "oga",
  "opus",
  "wav",
  "flac",
  "m4a",
  "aac",
  "mp4",
  "webm",
  "weba",
  "mpga",
]);

export function extensionFromUrl(
  urlObj: URL,
  mediaType: "image" | "audio"
): string {
  const fallback = mediaType === "image" ? "jpg" : "mp3";
  const allowed = mediaType === "image" ? IMAGE_EXTENSIONS : AUDIO_EXTENSIONS;

  const lastSegment = urlObj.pathname.split("/").pop() ?? "";
  const dotIndex = lastSegment.lastIndexOf(".");
  if (dotIndex < 0) return fallback;

  const extension = sanitizeToken(
    lastSegment.slice(dotIndex + 1),
    MAX_EXTENSION_LENGTH
  );
  return allowed.has(extension) ? extension : fallback;
}

// Build the AnkiConnect media descriptors for one field's worth of URLs.
// Returns the URLs it could not use alongside the items, so the caller can
// tell the user rather than dropping them into stderr where nobody looks.
export function buildMediaArray(
  urls: string[] | undefined,
  fieldName: string,
  mediaType: "image" | "audio"
): MediaArrayResult {
  if (!urls || urls.length === 0) return { items: [], skipped: [] };

  const items: MediaItem[] = [];
  const skipped: string[] = [];

  for (const url of urls) {
    let urlObj: URL;
    try {
      urlObj = new URL(url);
    } catch {
      skipped.push(url);
      continue;
    }

    if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") {
      skipped.push(url);
      continue;
    }

    // randomBytes rather than a counter: this server is respawned per client
    // session, so any in-process counter resets and stops being unique.
    const fieldSlug = sanitizeToken(fieldName, MAX_FIELD_SLUG_LENGTH);
    const extension = extensionFromUrl(urlObj, mediaType);
    const unique = randomBytes(8).toString("hex");
    // Deliberately NOT truncated here. Every component above is already
    // individually bounded, so the result cannot exceed
    // MAX_MEDIA_FILENAME_LENGTH (see the constant). A trailing .slice() would
    // be unreachable, and worse, it would be the thing that silently ate the
    // random suffix if one of those bounds were ever raised — the test asserts
    // the computed bound instead, so raising a bound fails loudly.
    const filename = `${mediaType}_${fieldSlug}_${Date.now()}_${unique}.${extension}`;

    items.push({
      url,
      filename,
      deleteExisting: false,
      // The RAW field name, not the slug: Anki matches this against the note
      // type's real field, so "Back Extra" must keep its space.
      fields: [fieldName],
    });
  }

  return { items, skipped };
}

export function buildMediaMessage(
  pictureCount: number,
  audioCount: number
): string {
  const mediaInfo: string[] = [];
  if (pictureCount > 0) mediaInfo.push(`${pictureCount} image(s)`);
  if (audioCount > 0) mediaInfo.push(`${audioCount} audio file(s)`);
  return mediaInfo.length > 0 ? ` with ${mediaInfo.join(" and ")}` : "";
}

// A skipped "URL" is attacker-influenced text: it reached us because it was NOT
// a parseable URL, and these strings can originate from an LLM reading an
// untrusted page (see docs/adr/0001). This message is returned as tool output,
// which the model reads as trusted, so echoing it raw is an injection vector.
// Render each one as a short, single-line, allowlisted excerpt instead.
export function buildSkippedMessage(skipped: string[]): string {
  if (skipped.length === 0) return "";
  const excerpts = skipped.map(
    (url, index) => `[${index + 1}] ${excerptForDisplay(url)}`
  );
  return `\n\nSkipped ${skipped.length} invalid URL(s): ${excerpts.join(" ")}`;
}

// Allowlist rather than escape: the set of characters that can appear in a
// legitimate URL is small and known, so anything outside it is dropped rather
// than enumerated. Newlines in particular must not survive, or a crafted value
// can forge what looks like a separate line of tool output.
function excerptForDisplay(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._~:/?#@!$&'()*+,;=%-]/g, "");
  const truncated = cleaned.slice(0, MAX_SKIPPED_URL_DISPLAY_LENGTH);
  const suffix = cleaned.length > truncated.length ? "..." : "";
  return truncated.length > 0 ? `"${truncated}${suffix}"` : "(unprintable)";
}
