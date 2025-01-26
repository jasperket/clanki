# Clanki - Claude's Anki Integration

An MCP server that enables AI assistants like Claude to interact with Anki flashcard decks through the Model Context Protocol (MCP).

## Features

- Create and manage Anki decks
- Create basic flashcards with front/back content
- Create cloze deletion cards
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

Creates a new basic flashcard in a specified deck

- Parameters:
  - `deckName`: Name of the deck to add the card to
  - `front`: Front side content of the card
  - `back`: Back side content of the card
  - `tags`: (Optional) Array of tags for the card

### create-cloze-card

Creates a new cloze deletion card in a specified deck

- Parameters:
  - `deckName`: Name of the deck to add the card to
  - `text`: Text containing cloze deletions using {{c1::text}} syntax
  - `backExtra`: (Optional) Extra information to show on the back of the card
  - `tags`: (Optional) Array of tags for the card

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

## Development

To modify or extend the server:

1. Make changes to `src/index.ts`
2. Rebuild with `npm run build`
3. Debug with `npx @modelcontextprotocol/inspector node build/index.js`
