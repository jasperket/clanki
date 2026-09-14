# Sanitize media filenames ourselves

`buildMediaArray` in `src/media.ts` builds media filenames from an allowlist
(`[a-z0-9]` only, bounded length, `http`/`https` URLs only) even though Anki's
own Rust layer already strips illegal characters and guards Windows device
names. This looks redundant, and a future reader may be tempted to delete it.

Keep it. Anki's normalizer is another project's implementation detail that can
change, and AnkiConnect's `deleteMediaFile` runs on the **un-normalized** name
we supply, before Anki ever sees it. Media URLs can originate from an LLM
reading untrusted web content, and `new URL()` percent-decodes `pathname`, so a
URL ending in `%2e%2e%2f` reaches us as `../` inside a string that becomes a
real file on disk. An allowlist costs a few lines and closes traversal, NUL
bytes, NTFS alternate data streams and Unicode tricks in a single rule, rather
than requiring us to enumerate every bad character correctly.
