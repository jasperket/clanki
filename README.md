[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/jasperket-clanki-badge.png)](https://mseep.ai/app/jasperket-clanki)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

# Clanki - Claude's Anki Integration

An MCP server that enables AI assistants like Claude to interact with Anki flashcard decks through the Model Context Protocol (MCP).

## Features

- Create and manage Anki decks
- Create basic notes with front/back content
- Create cloze notes
- Create many notes at once in a single request
- **Attach images and audio from URLs** - automatically downloaded and embedded
- HTML formatting support in note fields
- Update existing notes and cloze deletions
- Add and manage tags
- Search for notes with Anki's query syntax
- Delete notes permanently
- View deck contents and note information
- Full integration with AnkiConnect

## Prerequisites

- [Anki](https://apps.ankiweb.net/) installed and running
- [AnkiConnect](https://ankiweb.net/shared/info/2055492159) plugin installed in Anki
- Node.js 16 or higher

## Installation

1. Clone this repository:

```bash
git clone https://github.com/yourusername/clanki.git
cd clanki
```

2. Install dependencies:

```bash
npm install
```

3. Build the project:

```bash
npm run build
```

## Setup

1. Make sure Anki is running and the AnkiConnect plugin is installed and enabled

2. Configure Claude for Desktop to use the server by editing `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "clanki": {
      "command": "node",
      "args": ["/absolute/path/to/clanki/build/index.js"]
    }
  }
}
```

Replace `/absolute/path/to/clanki` with the actual path to your clanki installation.

3. Verify the server can reach Anki. With Anki running:

```bash
curl -X POST http://127.0.0.1:8765 -d "{\"action\":\"version\",\"version\":6}"
```

A working setup replies `{"result": 6, "error": null}`. If it does not, see
[docs/troubleshooting.md](docs/troubleshooting.md) — connection failures are by
far the most common problem, and AnkiConnect's default configuration needs no
changes.

## Configuration

Clanki needs no configuration in a normal setup. Every variable below is
optional.

### Using Anki in a language other than English

Anki translates the names of its built-in note types, and their fields, when a
collection is created — a German collection has `Einfach` with the fields
`Vorderseite` and `Rückseite`, not `Basic` with `Front` and `Back`. Clanki finds
them by their structure rather than their names, so this works with no setup
whatever language you use.

If your collection contains several note types that look alike, Clanki cannot
tell which you meant. It stops and lists the candidates rather than guessing,
because guessing wrong would write your text into a field that does not exist,
and Anki discards it without an error. Name the one you want:

| Variable | What it does |
| --- | --- |
| `CLANKI_BASIC_NOTE_TYPE` | Note type for ordinary two-sided notes, e.g. `Einfach` |
| `CLANKI_CLOZE_NOTE_TYPE` | Note type for cloze notes, e.g. `Lückentext` |
| `CLANKI_BASIC_FIELDS` | Its two fields, front first, e.g. `Vorderseite,Rückseite` |
| `CLANKI_CLOZE_FIELDS` | Its two fields, text first, e.g. `Text,Extra` |

Naming the note type is usually enough — Clanki reads its fields from your
collection in order. The `_FIELDS` variables are only needed for a note type
whose fields are not in front-then-back order. Both are checked against your
collection at startup, so a typo is reported rather than silently losing content.

### Connecting to AnkiConnect elsewhere

| Variable | Default |
| --- | --- |
| `CLANKI_ANKI_CONNECT_URL` | `http://127.0.0.1:8765` |

Set this only if you changed AnkiConnect's port or reach Anki on another machine.

Variables go in the `env` block of your MCP server config, alongside `command`
and `args`:

```json
{
  "mcpServers": {
    "clanki": {
      "command": "node",
      "args": ["/path/to/clanki/build/index.js"],
      "env": {
        "CLANKI_BASIC_NOTE_TYPE": "Einfach"
      }
    }
  }
}
```

Restart the server after changing them.

## Available Tools

### create-deck

Creates a new Anki deck

- Parameters:
  - `name`: Name for the new deck

### create-card

Creates a new note in a specified deck. Supports HTML formatting and media attachments.

- Parameters:
  - `deckName`: Name of the deck to add the note to
  - `front`: Front side content of the note (supports HTML)
  - `back`: Back side content of the note (supports HTML)
  - `tags`: (Optional) Array of tags for the note
  - `frontImages`: (Optional) Array of image URLs for the front
  - `backImages`: (Optional) Array of image URLs for the back
  - `frontAudio`: (Optional) Array of audio URLs for the front
  - `backAudio`: (Optional) Array of audio URLs for the back

### create-cloze-card

Creates a new cloze note in a specified deck. Supports HTML formatting and media attachments.

- Parameters:
  - `deckName`: Name of the deck to add the note to
  - `text`: Text containing cloze deletions using {{c1::text}} syntax (supports HTML)
  - `backExtra`: (Optional) Extra information to show on the back of the card (supports HTML)
  - `tags`: (Optional) Array of tags for the note
  - `textImages`: (Optional) Array of image URLs for the text field
  - `backImages`: (Optional) Array of image URLs for the back extra field
  - `textAudio`: (Optional) Array of audio URLs for the text field
  - `backAudio`: (Optional) Array of audio URLs for the back extra field

### create-cards-bulk

Creates many basic notes in one request. Prefer this over repeated `create-card`
calls for a batch: it sends a single request to Anki regardless of size. Does
not support media — use `create-card` for notes that need images or audio.

- Parameters:
  - `deckName`: Name of the deck to add the notes to
  - `cards`: Array of `{ front, back, tags? }` objects (at least one)

Anki's `addNotes` is all-or-nothing — a single duplicate would otherwise fail
the whole batch — so the tool asks which notes are addable first and sends only
those. The response reports how many were added, and the input position and
Anki's own reason for each note skipped, so you can correct and resend just
those.

### create-cloze-cards-bulk

Creates many cloze notes in one request. Same trade-offs as
`create-cards-bulk`; use `create-cloze-card` when you need media.

- Parameters:
  - `deckName`: Name of the deck to add the notes to
  - `cards`: Array of `{ text, backExtra?, tags? }` objects (at least one)

Cloze syntax is validated for the whole batch before anything is sent, so a
malformed entry fails the call rather than leaving a partial batch in the deck.

### update-card

Updates an existing note

- Parameters:
  - `noteId`: ID of the note to update
  - `front`: (Optional) New front side content
  - `back`: (Optional) New back side content
  - `tags`: (Optional) New tags for the note

### update-cloze-card

Updates an existing cloze note

- Parameters:
  - `noteId`: ID of the note to update
  - `text`: (Optional) New text with cloze deletions
  - `backExtra`: (Optional) New extra information for the back
  - `tags`: (Optional) New tags for the note

### find-cards

Searches for notes with Anki's query syntax and returns their note IDs, note
type, tags, and a short excerpt of each field. Use it to obtain the `noteId`
that `update-card`, `update-cloze-card` and `delete-card` need.

Field content is truncated and the number of results is capped, so narrow the
query if the note you want is not listed — the reply always reports how many
notes matched in total.

- Parameters:
  - `query`: Anki search query, e.g. `deck:Spanish`, `tag:vocab`,
    `deck:Spanish tag:verbs`

### delete-card

**Permanently deletes notes.** This cannot be undone — there is no trash to
recover them from, and every card generated from a deleted note goes with it.

Note IDs must be listed explicitly; there is no delete-by-query. Use
`find-cards` first to obtain them and to check you have the right notes. The
reply reports which IDs were actually deleted and which did not exist, because
Anki reports success either way.

- Parameters:
  - `noteIds`: IDs of the notes to delete, at most 50 per call
  - `confirm`: Must be `true`

## Resources

Besides the tools above, decks are exposed as a readable resource.

### anki://deck/`<name>`

Reads one deck and returns every note in it — note ID, front, back and tags.
Unlike `find-cards`, the content is returned in full rather than truncated.

## Usage Examples

### Basic card with text only

```text
"Create a flashcard in my Spanish deck with 'Hola' on the front and 'Hello' on the back"

```

### Card with images

```text
"Create a flashcard about the Eiffel Tower with an image from https://example.com/eiffel.jpg on the front"

```

### Card with audio

```text
"Create a pronunciation card with audio from https://example.com/pronunciation.mp3"

```

### Card with multiple media

```text
"Create a card with images on both sides and audio on the back for studying animals"

```

### Cloze card with media

```text
"Create a cloze card: 'The capital of {{c1::France}} is {{c2::Paris}}' with an image of the Eiffel Tower"

```

**Note:** Media files are automatically downloaded from URLs and embedded into
the cards. Ensure URLs are accessible and point to valid media files. A URL that
cannot be used is reported back in the tool's response; the note is still
created without that attachment.

**Media placement:** Attachments are appended to the **end** of the field they
belong to, after any text. You cannot position an image inline with HTML,
because the filename is generated at upload time and is not known in advance.
HTML formatting and media attachments therefore do not compose: use HTML to
format your text, and the media parameters to attach files after it.

## Known Issue: Missing Back Extra on Older Cloze Cards

Earlier versions wrote the `backExtra` value to a field named `Back`. Anki's
built-in Cloze note type has no such field — its fields are `Text` and
`Back Extra` — and AnkiConnect silently discards values sent to a field that
does not exist.

As a result, **cloze cards created before this fix have no extra content
stored**, even though the card was reported as created successfully. The text
was never written to Anki, so it cannot be recovered automatically; re-entering
it on the affected cards is the only fix.

Cloze cards created from this version onward store `backExtra` correctly.

## Development

To modify or extend the server:

1. Make changes to `src/index.ts`
2. Rebuild with `npm run build`
3. Debug with `npx @modelcontextprotocol/inspector node build/index.js`

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Acknowledgments

- Built with the [Model Context Protocol SDK](https://github.com/modelcontextprotocol)
- Integrates with [Anki](https://apps.ankiweb.net/) via [AnkiConnect](https://foosoft.net/projects/anki-connect/)
