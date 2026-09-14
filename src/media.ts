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
// rather than denylisted. Anki caps media filenames at 120 bytes; staying well
// under that guarantees the random suffix is never truncated away.
const MAX_MEDIA_FILENAME_LENGTH = 120;
const MAX_EXTENSION_LENGTH = 8;
const MAX_FIELD_SLUG_LENGTH = 20;

export function sanitizeToken(value: string, maxLength: number): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, maxLength);
}

export function extensionFromUrl(
  urlObj: URL,
  mediaType: "image" | "audio"
): string {
  const fallback = mediaType === "image" ? "jpg" : "mp3";
  const lastSegment = urlObj.pathname.split("/").pop() ?? "";
  const dotIndex = lastSegment.lastIndexOf(".");
  if (dotIndex < 0) return fallback;

  const extension = sanitizeToken(
    lastSegment.slice(dotIndex + 1),
    MAX_EXTENSION_LENGTH
  );
  return extension.length > 0 ? extension : fallback;
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
    const filename =
      `${mediaType}_${fieldSlug}_${Date.now()}_${unique}.${extension}`.slice(
        0,
        MAX_MEDIA_FILENAME_LENGTH
      );

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

export function buildSkippedMessage(skipped: string[]): string {
  if (skipped.length === 0) return "";
  return `\n\nSkipped ${skipped.length} invalid URL(s): ${skipped.join(", ")}`;
}
