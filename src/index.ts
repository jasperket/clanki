import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as http from "http";

// Constants
const ANKI_CONNECT_URL = "http://localhost:8765";

// Type definitions for Anki responses
interface AnkiCard {
  cardId: number;
  fields: {
    Front: { value: string };
    Back: { value: string };
  };
  tags: string[];
}

interface AnkiResponse<T> {
  result: T;
  error: string | null;
}

// Validation schemas
const ListDecksArgumentsSchema = z.object({});

const ListCardsArgumentsSchema = z.object({
  deckName: z.string(),
});

const CreateDeckArgumentsSchema = z.object({
  name: z.string().min(1),
});

const CreateCardArgumentsSchema = z.object({
  deckName: z.string(),
  front: z.string(),
  back: z.string(),
  tags: z.array(z.string()).optional(),
});

const CreateClozeCardArgumentsSchema = z.object({
  deckName: z.string(),
  text: z.string(),
  backExtra: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const UpdateCardArgumentsSchema = z.object({
  cardId: z.number(),
  front: z.string().optional(),
  back: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

// Helper function for making AnkiConnect requests
async function ankiRequest<T>(
  action: string,
  params: Record<string, any> = {}
): Promise<T> {
  console.error(`Attempting AnkiConnect request: ${action}`);

  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      action,
      version: 6,
      params,
    });

    const options = {
      hostname: "127.0.0.1",
      port: 8765,
      path: "/",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    };

    const req = http.request(options, (res) => {
      let responseData = "";

      res.on("data", (chunk: Buffer) => {
        responseData += chunk.toString();
      });

      res.on("end", () => {
        console.error(`AnkiConnect response status: ${res.statusCode}`);
        console.error(`AnkiConnect response body: ${responseData}`);

        if (res.statusCode !== 200) {
          reject(
            new Error(
              `AnkiConnect request failed with status ${res.statusCode}: ${responseData}`
            )
          );
          return;
        }

        try {
          const parsedData = JSON.parse(responseData) as AnkiResponse<T>;
          if (parsedData.error) {
            reject(new Error(`AnkiConnect error: ${parsedData.error}`));
            return;
          }
          resolve(parsedData.result);
        } catch (parseError) {
          reject(
            new Error(`Failed to parse AnkiConnect response: ${responseData}`)
          );
        }
      });
    });

    req.on("error", (error: Error) => {
      console.error(`Error in ankiRequest: ${error}`);
      reject(
        new Error(
          `Cannot connect to AnkiConnect at ${ANKI_CONNECT_URL}. Make sure Anki is running and AnkiConnect plugin is installed. Error: ${error.message}`
        )
      );
    });

    // Write data to request body
    req.write(data);
    req.end();
  });
}

async function main() {
  // Create server instance
  const server = new Server(
    {
      name: "anki-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "create-deck",
          description: "Create a new Anki deck",
          inputSchema: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Name for the new deck",
              },
            },
            required: ["name"],
          },
        },
        {
          name: "list-decks",
          description: "List all available Anki decks",
          inputSchema: {
            type: "object",
            properties: {},
            required: [],
          },
        },
        {
          name: "list-cards",
          description: "List all cards in a specified deck",
          inputSchema: {
            type: "object",
            properties: {
              deckName: {
                type: "string",
                description: "Name of the deck to list cards from",
              },
            },
            required: ["deckName"],
          },
        },
        {
          name: "create-card",
          description: "Create a new flashcard in a specified deck",
          inputSchema: {
            type: "object",
            properties: {
              deckName: {
                type: "string",
                description: "Name of the deck to add the card to",
              },
              front: {
                type: "string",
                description: "Front side content of the card",
              },
              back: {
                type: "string",
                description: "Back side content of the card",
              },
              tags: {
                type: "array",
                items: { type: "string" },
                description: "Optional tags for the card",
              },
            },
            required: ["deckName", "front", "back"],
          },
        },
        {
          name: "update-card",
          description: "Update an existing flashcard",
          inputSchema: {
            type: "object",
            properties: {
              cardId: {
                type: "number",
                description: "ID of the card to update",
              },
              front: {
                type: "string",
                description: "New front side content",
              },
              back: {
                type: "string",
                description: "New back side content",
              },
              tags: {
                type: "array",
                items: { type: "string" },
                description: "New tags for the card",
              },
            },
            required: ["cardId"],
          },
        },
        {
          name: "create-cloze-card",
          description: "Create a new cloze deletion card in a specified deck. Use {{c1::text}} syntax for cloze deletions.",
          inputSchema: {
            type: "object",
            properties: {
              deckName: {
                type: "string",
                description: "Name of the deck to add the card to",
              },
              text: {
                type: "string",
                description: "Text containing cloze deletions using {{c1::text}} syntax",
              },
              backExtra: {
                type: "string",
                description: "Optional extra information to show on the back of the card",
              },
              tags: {
                type: "array",
                items: { type: "string" },
                description: "Optional tags for the card",
              },
            },
            required: ["deckName", "text"],
          },
        },
      ],
    };
  });

  // Handle tool execution
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === "create-deck") {
        const { name: deckName } = CreateDeckArgumentsSchema.parse(args);
        await ankiRequest("createDeck", {
          deck: deckName,
        });
        return {
          content: [
            {
              type: "text",
              text: `Successfully created new deck "${deckName}"`,
            },
          ],
        };
      }

      if (name === "list-decks") {
        ListDecksArgumentsSchema.parse(args);
        const decks = await ankiRequest<string[]>("deckNames");
        return {
          content: [
            {
              type: "text",
              text: `Available decks:\n${decks.join("\n")}`,
            },
          ],
        };
      }

      if (name === "list-cards") {
        const { deckName } = ListCardsArgumentsSchema.parse(args);
        const cards = await ankiRequest<number[]>("findCards", {
          query: `deck:"${deckName}"`,
        });

        const cardInfo = await ankiRequest<AnkiCard[]>("cardsInfo", {
          cards,
        });

        const formattedCards = cardInfo
          .map((card) => {
            return `Card ID: ${card.cardId}\nFront: ${
              card.fields.Front.value
            }\nBack: ${card.fields.Back.value}\nTags: ${card.tags.join(
              ", "
            )}\n---`;
          })
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text: `Cards in deck "${deckName}":\n${formattedCards}`,
            },
          ],
        };
      }

      if (name === "create-card") {
        const {
          deckName,
          front,
          back,
          tags = [],
        } = CreateCardArgumentsSchema.parse(args);

        await ankiRequest("addNote", {
          note: {
            deckName,
            modelName: "Basic", // Using the basic note type
            fields: {
              Front: front,
              Back: back,
            },
            tags,
          },
        });

        return {
          content: [
            {
              type: "text",
              text: `Successfully created new card in deck "${deckName}"`,
            },
          ],
        };
      }

      if (name === "update-card") {
        const { cardId, front, back, tags } =
          UpdateCardArgumentsSchema.parse(args);

        const noteIdResponse = await ankiRequest<number[]>("cardsToNotes", {
          cards: [cardId],
        });

        if (noteIdResponse.length === 0) {
          throw new Error(`No note found for card ${cardId}`);
        }

        const noteId = noteIdResponse[0];

        if (front || back) {
          const fields: Record<string, string> = {};
          if (front) fields.Front = front;
          if (back) fields.Back = back;

          await ankiRequest("updateNoteFields", {
            note: {
              id: noteId,
              fields,
            },
          });
        }

        if (tags) {
          await ankiRequest("replaceTags", {
            notes: [noteId],
            tags: tags.join(" "),
          });
        }

        return {
          content: [
            {
              type: "text",
              text: `Successfully updated card ${cardId}`,
            },
          ],
        };
      }

      if (name === "create-cloze-card") {
        const { deckName, text, backExtra = "", tags = [] } = CreateClozeCardArgumentsSchema.parse(args);

        // Validate that the text contains at least one cloze deletion
        if (!text.includes("{{c") || !text.includes("}}")) {
          throw new Error("Text must contain at least one cloze deletion using {{c1::text}} syntax");
        }

        await ankiRequest("addNote", {
          note: {
            deckName,
            modelName: "Cloze", // Using the cloze note type
            fields: {
              Text: text,
              Back: backExtra,
            },
            tags,
          },
        });

        return {
          content: [
            {
              type: "text",
              text: `Successfully created new cloze card in deck "${deckName}"`,
            },
          ],
        };
      }

      throw new Error(`Unknown tool: ${name}`);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(
          `Invalid arguments: ${error.errors
            .map((e) => `${e.path.join(".")}: ${e.message}`)
            .join(", ")}`
        );
      }
      throw error;
    }
  });

  // Start the server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Anki MCP Server running on stdio");
}

// Run the server
main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
