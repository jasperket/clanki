import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
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

const UpdateClozeCardArgumentsSchema = z.object({
  cardId: z.number(),
  text: z.string().optional(),
  backExtra: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

// Helper function for making AnkiConnect requests with retries
async function ankiRequest<T>(
  action: string,
  params: Record<string, any> = {},
  retries = 3,
  delay = 1000
): Promise<T> {
  console.error(
    `Attempting AnkiConnect request: ${action} with params:`,
    params
  );

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await new Promise<T>((resolve, reject) => {
        const data = JSON.stringify({
          action,
          version: 6,
          params,
        });

        console.error("Request payload:", data);

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
              console.error("Parsed response:", parsedData);

              if (parsedData.error) {
                reject(new Error(`AnkiConnect error: ${parsedData.error}`));
                return;
              }

              // Some actions like updateNoteFields return null on success
              if (
                parsedData.result === null ||
                parsedData.result === undefined
              ) {
                // For actions that are expected to return null/undefined, return an empty success response
                if (action === "updateNoteFields" || action === "replaceTags") {
                  resolve({} as T);
                  return;
                }
                // For other actions, treat null/undefined as an error
                reject(new Error("AnkiConnect returned null/undefined result"));
                return;
              }

              resolve(parsedData.result);
            } catch (parseError) {
              console.error("Parse error:", parseError);
              reject(
                new Error(
                  `Failed to parse AnkiConnect response: ${responseData}`
                )
              );
            }
          });
        });

        req.on("error", (error: Error) => {
          console.error(
            `Error in ankiRequest (attempt ${attempt}/${retries}):`,
            error
          );
          reject(error);
        });

        // Write data to request body
        req.write(data);
        req.end();
      });

      return result;
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      console.error(
        `Attempt ${attempt}/${retries} failed, retrying after ${delay}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      // Increase delay for next attempt
      delay *= 2;
    }
  }

  throw new Error(`Failed after ${retries} attempts`);
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
        resources: {},
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
          description:
            "Create a new cloze deletion card in a specified deck. Use {{c1::text}} syntax for cloze deletions.",
          inputSchema: {
            type: "object",
            properties: {
              deckName: {
                type: "string",
                description: "Name of the deck to add the card to",
              },
              text: {
                type: "string",
                description:
                  "Text containing cloze deletions using {{c1::text}} syntax",
              },
              backExtra: {
                type: "string",
                description:
                  "Optional extra information to show on the back of the card",
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
        {
          name: "update-cloze-card",
          description: "Update an existing cloze deletion card",
          inputSchema: {
            type: "object",
            properties: {
              cardId: {
                type: "number",
                description: "ID of the card to update",
              },
              text: {
                type: "string",
                description:
                  "New text with cloze deletions using {{c1::text}} syntax",
              },
              backExtra: {
                type: "string",
                description:
                  "New extra information to show on the back of the card",
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
        const {
          deckName,
          text,
          backExtra = "",
          tags = [],
        } = CreateClozeCardArgumentsSchema.parse(args);

        // Validate that the text contains at least one cloze deletion
        if (!text.includes("{{c") || !text.includes("}}")) {
          throw new Error(
            "Text must contain at least one cloze deletion using {{c1::text}} syntax"
          );
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

      if (name === "update-cloze-card") {
        const { cardId, text, backExtra, tags } =
          UpdateClozeCardArgumentsSchema.parse(args);

        // Get the note ID from the card ID
        const noteIdResponse = await ankiRequest<number[]>("cardsToNotes", {
          cards: [cardId],
        });

        if (noteIdResponse.length === 0) {
          throw new Error(`No note found for card ${cardId}`);
        }

        const noteId = noteIdResponse[0];

        // Get the current note info to verify it's a cloze note
        const noteInfo = await ankiRequest<any[]>("notesInfo", {
          notes: [noteId],
        });

        if (noteInfo[0].modelName !== "Cloze") {
          throw new Error("This card is not a cloze deletion card");
        }

        // Update fields if provided
        if (text || backExtra) {
          const fields: Record<string, string> = {};
          if (text) {
            // Validate that the text contains at least one cloze deletion
            if (!text.includes("{{c") || !text.includes("}}")) {
              throw new Error(
                "Text must contain at least one cloze deletion using {{c1::text}} syntax"
              );
            }
            fields.Text = text;
          }
          if (backExtra !== undefined) {
            fields["Back Extra"] = backExtra;
          }

          await ankiRequest("updateNoteFields", {
            note: {
              id: noteId,
              fields,
            },
          });
        }

        // Update tags if provided
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
              text: `Successfully updated cloze card ${cardId}`,
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

  // Add resource handlers for listing decks
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    try {
      const decks = await ankiRequest<string[]>("deckNames");
      return {
        resources: decks.map((deck) => ({
          uri: `anki://deck/${encodeURIComponent(deck)}`,
          name: deck,
          description: `Anki deck: ${deck}`,
        })),
      };
    } catch (error) {
      console.error("Error listing resources:", error);
      throw error;
    }
  });

  // Add handler for reading deck contents
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    try {
      const uri = request.params.uri;
      const match = uri.match(/^anki:\/\/deck\/(.+)$/);

      if (!match) {
        throw new Error(`Invalid resource URI: ${uri}`);
      }

      const deckName = decodeURIComponent(match[1]);
      console.error(`Attempting to fetch cards for deck: ${deckName}`);

      // Find all notes in the deck
      const noteIds = await ankiRequest<number[]>("findNotes", {
        query: `deck:${deckName}`,
      });

      console.error(`Found ${noteIds.length} notes in deck ${deckName}`);

      if (noteIds.length === 0) {
        return {
          contents: [
            {
              uri,
              mimeType: "text/plain",
              text: `Deck: ${deckName}\n\nNo notes found in this deck.`,
            },
          ],
        };
      }

      // Process notes in chunks of 5
      const chunkSize = 5;
      let allNotes: any[] = [];

      for (let i = 0; i < noteIds.length; i += chunkSize) {
        const chunk = noteIds.slice(i, i + chunkSize);
        console.error(
          `Processing notes ${i + 1} to ${Math.min(
            i + chunkSize,
            noteIds.length
          )}`
        );

        const chunkNotes = await ankiRequest<any[]>("notesInfo", {
          notes: chunk,
        });
        allNotes = allNotes.concat(chunkNotes);
      }

      console.error(`Retrieved ${allNotes.length} notes total`);

      // Debug log to see note structure
      console.error(
        "First note structure:",
        JSON.stringify(allNotes[0], null, 2)
      );
      if (allNotes.length > 1) {
        console.error(
          "Second note structure:",
          JSON.stringify(allNotes[1], null, 2)
        );
      }

      // Map notes to our card format
      const cardInfo: AnkiCard[] = allNotes.map((note) => {
        if (note.modelName === "Cloze") {
          return {
            cardId: note.cards[0],
            fields: {
              Front: { value: note.fields.Text.value },
              Back: {
                value: note.fields["Back Extra"].value || "[Cloze deletion]",
              },
            },
            tags: note.tags,
          };
        } else if (note.modelName === "Basic") {
          return {
            cardId: note.cards[0],
            fields: {
              Front: { value: note.fields.Front.value },
              Back: { value: note.fields.Back.value },
            },
            tags: note.tags,
          };
        } else {
          // Default case for unknown note types
          console.error(`Unknown note type: ${note.modelName}`);
          return {
            cardId: note.cards[0],
            fields: {
              Front: { value: "[Unknown note type]" },
              Back: { value: "[Unknown note type]" },
            },
            tags: note.tags,
          };
        }
      });

      console.error(`Successfully retrieved info for ${cardInfo.length} cards`);

      const deckContent = cardInfo
        .map((card) => {
          return `Card ID: ${card.cardId}\nFront: ${
            card.fields.Front.value
          }\nBack: ${card.fields.Back.value}\nTags: ${card.tags.join(
            ", "
          )}\n---`;
        })
        .join("\n");

      return {
        contents: [
          {
            uri,
            mimeType: "text/plain",
            text: `Deck: ${deckName}\n\n${deckContent}`,
          },
        ],
      };
    } catch (error) {
      console.error(`Error reading deck: ${error}`);
      throw new Error(
        `Failed to read deck: ${
          error instanceof Error ? error.message : "Unknown error"
        }. Make sure Anki is running and AnkiConnect plugin is installed.`
      );
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
