[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/jasperket-clanki-badge.png)](https://mseep.ai/app/jasperket-clanki)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

# Clanki - Claude's Anki Integration

An MCP server that enables AI assistants like Claude to interact with Anki flashcard decks through the Model Context Protocol (MCP).

## Features

- Create and manage Anki decks
- Create basic flashcards with front/back content
- Create cloze deletion cards
- **Attach images and audio from URLs** - automatically downloaded and embedded
- HTML formatting support in card fields
- Update existing cards and cloze deletions
- Add and manage tags
- View deck contents and card information
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

## Available Tools

### create-deck

Creates a new Anki deck

- Parameters:
  - `name`: Name for the new deck

### create-card

Creates a new basic flashcard in a specified deck. Supports HTML formatting and media attachments.

- Parameters:
  - `deckName`: Name of the deck to add the card to
  - `front`: Front side content of the card (supports HTML)
  - `back`: Back side content of the card (supports HTML)
  - `tags`: (Optional) Array of tags for the card
  - `frontImages`: (Optional) Array of image URLs for the front
  - `backImages`: (Optional) Array of image URLs for the back
  - `frontAudio`: (Optional) Array of audio URLs for the front
  - `backAudio`: (Optional) Array of audio URLs for the back

### create-cloze-card

Creates a new cloze deletion card in a specified deck. Supports HTML formatting and media attachments.

- Parameters:
  - `deckName`: Name of the deck to add the card to
  - `text`: Text containing cloze deletions using {{c1::text}} syntax (supports HTML)
  - `backExtra`: (Optional) Extra information to show on the back of the card (supports HTML)
  - `tags`: (Optional) Array of tags for the card
  - `textImages`: (Optional) Array of image URLs for the text field
  - `backImages`: (Optional) Array of image URLs for the back extra field
  - `textAudio`: (Optional) Array of audio URLs for the text field
  - `backAudio`: (Optional) Array of audio URLs for the back extra field

### update-card

Updates an existing basic flashcard

- Parameters:
  - `noteId`: ID of the note to update
  - `front`: (Optional) New front side content
  - `back`: (Optional) New back side content
  - `tags`: (Optional) New tags for the card

### update-cloze-card

Updates an existing cloze deletion card

- Parameters:
  - `noteId`: ID of the note to update
  - `text`: (Optional) New text with cloze deletions
  - `backExtra`: (Optional) New extra information for the back
  - `tags`: (Optional) New tags for the card

## Usage Examples

### Basic card with text only
```
"Create a flashcard in my Spanish deck with 'Hola' on the front and 'Hello' on the back"
```

### Card with images
```
"Create a flashcard about the Eiffel Tower with an image from https://example.com/eiffel.jpg on the front"
```

### Card with audio
```
"Create a pronunciation card with audio from https://example.com/pronunciation.mp3"
```

### Card with multiple media
```
"Create a card with images on both sides and audio on the back for studying animals"
```

### Cloze card with media
```
"Create a cloze card: 'The capital of {{c1::France}} is {{c2::Paris}}' with an image of the Eiffel Tower"
```

**Note:** Media files are automatically downloaded from URLs and embedded into the cards. Ensure URLs are accessible and point to valid media files.

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
