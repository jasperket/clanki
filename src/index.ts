import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  buildMediaArray,
  buildMediaMessage,
  buildSkippedMessage,
  MediaItem,
} from "./media.js";
import {
  AddabilityReport,
  BASIC_FIELD_BACK,
  BASIC_FIELD_FRONT,
  CLOZE_FIELD_BACK_EXTRA,
  CLOZE_FIELD_TEXT,
  NOTES_INFO_CHUNK_SIZE,
  NewNote,
  SEARCH_RESULT_LIMIT,
  buildBasicNote,
  buildBulkSummary,
  buildClozeNote,
  buildNoteUpdate,
  buildSearchSummary,
  partitionAddable,
  summarizeNote,
  truncateSummary,
  validateClozeText,
} from "./notes.js";
import * as http from "http";

// Constants
const ANKI_CONNECT_URL = new URL("http://127.0.0.1:8765");

// AnkiConnect actions that return `null` on success rather than a value. A null
// result from anything NOT listed here is a real failure, so this must be
// extended whenever a new mutating action is called — otherwise the action
// succeeds in Anki and this server reports an error anyway, which for a
// destructive action is the worst case: the caller may retry.
const NULL_ON_SUCCESS_ACTIONS = new Set([
  "updateNoteFields",
  "updateNote",
  "replaceTags",
]);

// Type definitions for Anki responses
interface AnkiResponse<T> {
  result: T;
  error: string | null;
}

interface NoteParams {
  note: {
    deckName: string;
    modelName: string;
    fields: Record<string, string>;
    tags: string[];
    picture?: MediaItem[];
    audio?: MediaItem[];
  };
}

// Validation schemas
const ListDecksArgumentsSchema = z.object({});

const CreateDeckArgumentsSchema = z.object({
  name: z.string().min(1),
});

const CreateCardArgumentsSchema = z.object({
  deckName: z.string(),
  // Anki refuses a Note whose first Field is empty, and in a bulk batch that
  // refusal arrives as an anonymous null. Rejecting it here names the problem
  // instead. `back` stays unconstrained — an empty back is a legitimate Note.
  front: z.string().min(1),
  back: z.string(),
  tags: z.array(z.string()).optional(),
  frontImages: z.array(z.string()).optional(),
  backImages: z.array(z.string()).optional(),
  frontAudio: z.array(z.string()).optional(),
  backAudio: z.array(z.string()).optional(),
});

const CreateClozeCardArgumentsSchema = z.object({
  deckName: z.string(),
  text: z.string(),
  backExtra: z.string().optional(),
  tags: z.array(z.string()).optional(),
  textImages: z.array(z.string()).optional(),
  backImages: z.array(z.string()).optional(),
  textAudio: z.array(z.string()).optional(),
  backAudio: z.array(z.string()).optional(),
});

const UpdateCardArgumentsSchema = z.object({
  noteId: z.number(),
  front: z.string().optional(),
  back: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const UpdateClozeCardArgumentsSchema = z.object({
  noteId: z.number(),
  text: z.string().optional(),
  backExtra: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const FindCardsArgumentsSchema = z.object({
  query: z.string().min(1),
});

const BulkCreateCardsArgumentsSchema = z.object({
  deckName: z.string(),
  cards: z.array(
    z.object({
      front: z.string().min(1),
      back: z.string(),
      tags: z.array(z.string()).optional(),
    })
  ).min(1),
});

const BulkCreateClozeCardsArgumentsSchema = z.object({
  deckName: z.string(),
  cards: z.array(
    z.object({
      text: z.string().min(1),
      backExtra: z.string().optional(),
      tags: z.array(z.string()).optional(),
    })
  ).min(1),
});

// Add a batch of Notes, skipping the ones Anki will refuse.
//
// `addNotes` is all-or-nothing: one duplicate fails the entire call with a
// top-level error and none of the batch is added. Asking which Notes are
// addable first is what keeps one repeat from costing the other 99.
async function addNoteBatch(
  notes: NewNote[],
  deckName: string
): Promise<string> {
  const reports = await ankiRequest<AddabilityReport[]>(
    "canAddNotesWithErrorDetail",
    { notes }
  );
  const { addable, rejected } = partitionAddable(notes, reports);

  // Nothing left to send. Returning early matters: `addNotes` with an empty
  // array is a pointless round trip, and on some builds an error.
  if (addable.length === 0) {
    return buildBulkSummary({ added: 0, rejected, deckName });
  }

  await ankiRequest<(number | null)[]>("addNotes", { notes: addable });

  return buildBulkSummary({ added: addable.length, rejected, deckName });
}

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
          hostname: ANKI_CONNECT_URL.hostname,
          port: ANKI_CONNECT_URL.port,
          path: ANKI_CONNECT_URL.pathname,
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
                if (NULL_ON_SUCCESS_ACTIONS.has(action)) {
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
          description: "Create a new flashcard in a specified deck. Supports HTML formatting in text fields. You can attach multiple images and audio files from URLs - they will be automatically downloaded and embedded in the card.",
          inputSchema: {
            type: "object",
            properties: {
              deckName: {
                type: "string",
                description: "Name of the deck to add the card to",
              },
              front: {
                type: "string",
                description: "Front side content of the card (supports HTML formatting)",
              },
              back: {
                type: "string",
                description: "Back side content of the card (supports HTML formatting)",
              },
              tags: {
                type: "array",
                items: { type: "string" },
                description: "Optional tags for the card",
              },
              frontImages: {
                type: "array",
                items: { type: "string" },
                description: "Optional array of image URLs to embed on the front of the card. Images will be downloaded and attached automatically.",
              },
              backImages: {
                type: "array",
                items: { type: "string" },
                description: "Optional array of image URLs to embed on the back of the card. Images will be downloaded and attached automatically.",
              },
              frontAudio: {
                type: "array",
                items: { type: "string" },
                description: "Optional array of audio file URLs to attach to the front of the card. Audio will be downloaded and can be played in Anki.",
              },
              backAudio: {
                type: "array",
                items: { type: "string" },
                description: "Optional array of audio file URLs to attach to the back of the card. Audio will be downloaded and can be played in Anki.",
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
              noteId: {
                type: "number",
                description: "ID of the note to update",
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
            required: ["noteId"],
          },
        },
        {
          name: "create-cloze-card",
          description:
            "Create a new cloze deletion card in a specified deck. Use {{c1::text}} syntax for cloze deletions (e.g., {{c1::Paris}} is the capital of France). Supports HTML formatting and can attach multiple images and audio files from URLs - they will be automatically downloaded and embedded.",
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
                  "Text containing cloze deletions using {{c1::text}} syntax. Supports HTML formatting. Use {{c1::word}}, {{c2::word}}, etc. for multiple deletions.",
              },
              backExtra: {
                type: "string",
                description:
                  "Optional extra information to show on the back of the card (supports HTML formatting)",
              },
              tags: {
                type: "array",
                items: { type: "string" },
                description: "Optional tags for the card",
              },
              textImages: {
                type: "array",
                items: { type: "string" },
                description: "Optional array of image URLs to embed in the main text field. Images will be downloaded and attached automatically.",
              },
              backImages: {
                type: "array",
                items: { type: "string" },
                description: "Optional array of image URLs to embed in the back extra field. Images will be downloaded and attached automatically.",
              },
              textAudio: {
                type: "array",
                items: { type: "string" },
                description: "Optional array of audio file URLs to attach to the main text field. Audio will be downloaded and can be played in Anki.",
              },
              backAudio: {
                type: "array",
                items: { type: "string" },
                description: "Optional array of audio file URLs to attach to the back extra field. Audio will be downloaded and can be played in Anki.",
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
              noteId: {
                type: "number",
                description: "ID of the note to update",
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
            required: ["noteId"],
          },
        },
        {
          name: "create-cards-bulk",
          description:
            "Create multiple basic cards in a single call. Use this instead of calling create-card repeatedly — it sends one request to Anki regardless of how many cards are in the batch. Does not support images or audio: use create-card for cards that need media.",
          inputSchema: {
            type: "object",
            properties: {
              deckName: {
                type: "string",
                description: "Name of the deck to add the cards to",
              },
              cards: {
                type: "array",
                description: "Array of cards to create",
                items: {
                  type: "object",
                  properties: {
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
                  required: ["front", "back"],
                },
              },
            },
            required: ["deckName", "cards"],
          },
        },
        {
          name: "create-cloze-cards-bulk",
          description:
            "Create multiple cloze deletion cards in a single call. Use this instead of calling create-cloze-card repeatedly — it sends one request to Anki regardless of how many cards are in the batch. Does not support images or audio: use create-cloze-card for cards that need media.",
          inputSchema: {
            type: "object",
            properties: {
              deckName: {
                type: "string",
                description: "Name of the deck to add the cards to",
              },
              cards: {
                type: "array",
                description: "Array of cloze cards to create",
                items: {
                  type: "object",
                  properties: {
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
                  required: ["text"],
                },
              },
            },
            required: ["deckName", "cards"],
          },
        },
        {
          name: "find-cards",
          description:
            "Search for notes using Anki's search syntax and return their note IDs, note type, tags, and a short excerpt of each field. Use this to get the noteId needed by update-card, update-cloze-card or delete-card. Field content is truncated and the number of results is capped, so narrow the query if the note you want is not listed. Examples: 'deck:Spanish', 'tag:vocab', 'front:hello', 'deck:Spanish tag:verbs'.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description:
                  "Anki search query, e.g. 'deck:Default', 'tag:vocab', or 'deck:Spanish tag:verbs'. See Anki's search documentation for the full syntax.",
              },
            },
            required: ["query"],
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
          frontImages = [],
          backImages = [],
          frontAudio = [],
          backAudio = [],
        } = CreateCardArgumentsSchema.parse(args);

        // Build picture and audio arrays for AnkiConnect
        const pictureResults = [
          buildMediaArray(frontImages, "Front", "image"),
          buildMediaArray(backImages, "Back", "image"),
        ];
        const picture = pictureResults.flatMap((r) => r.items);

        const audioResults = [
          buildMediaArray(frontAudio, "Front", "audio"),
          buildMediaArray(backAudio, "Back", "audio"),
        ];
        const audio = audioResults.flatMap((r) => r.items);

        const noteParams: NoteParams = {
          note: buildBasicNote({
            deckName,
            front,
            back,
            tags,
            picture,
            audio,
          }),
        };

        await ankiRequest("addNote", noteParams);

        const mediaText = buildMediaMessage(picture.length, audio.length);
        const skippedText = buildSkippedMessage([
          ...pictureResults.flatMap((r) => r.skipped),
          ...audioResults.flatMap((r) => r.skipped),
        ]);

        return {
          content: [
            {
              type: "text",
              text: `Successfully created new card in deck "${deckName}"${mediaText}${skippedText}`,
            },
          ],
        };
      }

      if (name === "update-card") {
        const { noteId, front, back, tags } =
          UpdateCardArgumentsSchema.parse(args);

        // `!== undefined`, not truthiness: "" is a caller explicitly clearing a
        // field, which is different from omitting the argument. A truthiness
        // check drops the clear and still reports success.
        const fields: Record<string, string> = {};
        if (front !== undefined) fields[BASIC_FIELD_FRONT] = front;
        if (back !== undefined) fields[BASIC_FIELD_BACK] = back;

        // One `updateNote` carries both halves; see buildNoteUpdate.
        const note = buildNoteUpdate({ noteId, fields, tags });

        // Nothing to change — say so without troubling Anki, which rejects an
        // update carrying neither Fields nor Tags.
        if (note !== null) {
          await ankiRequest("updateNote", { note });
        }

        return {
          content: [
            {
              type: "text",
              text: `Successfully updated note ${noteId}`,
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
          textImages = [],
          backImages = [],
          textAudio = [],
          backAudio = [],
        } = CreateClozeCardArgumentsSchema.parse(args);

        validateClozeText(text);

        // Build picture and audio arrays for AnkiConnect
        const pictureResults = [
          buildMediaArray(textImages, "Text", "image"),
          buildMediaArray(backImages, "Back Extra", "image"),
        ];
        const picture = pictureResults.flatMap((r) => r.items);

        const audioResults = [
          buildMediaArray(textAudio, "Text", "audio"),
          buildMediaArray(backAudio, "Back Extra", "audio"),
        ];
        const audio = audioResults.flatMap((r) => r.items);

        const noteParams: NoteParams = {
          note: buildClozeNote({
            deckName,
            text,
            backExtra,
            tags,
            picture,
            audio,
          }),
        };

        await ankiRequest("addNote", noteParams);

        const mediaText = buildMediaMessage(picture.length, audio.length);
        const skippedText = buildSkippedMessage([
          ...pictureResults.flatMap((r) => r.skipped),
          ...audioResults.flatMap((r) => r.skipped),
        ]);

        return {
          content: [
            {
              type: "text",
              text: `Successfully created new cloze card in deck "${deckName}"${mediaText}${skippedText}`,
            },
          ],
        };
      }

      if (name === "update-cloze-card") {
        const { noteId, text, backExtra, tags } =
          UpdateClozeCardArgumentsSchema.parse(args);

        // Get the current note info to verify it's a cloze note
        const noteInfo = await ankiRequest<any[]>("notesInfo", {
          notes: [noteId],
        });

        if (noteInfo.length === 0) {
          throw new Error(`No note found with ID ${noteId}`);
        }

        if (noteInfo[0].modelName !== "Cloze") {
          throw new Error("This note is not a cloze deletion note");
        }

        const fields: Record<string, string> = {};
        if (text !== undefined) {
          // Reached by `text: ""` too, which is the point: an empty Text is
          // rejected here rather than silently dropped, since a Cloze note
          // with no deletion generates no cards.
          validateClozeText(text);
          fields[CLOZE_FIELD_TEXT] = text;
        }
        if (backExtra !== undefined) {
          fields[CLOZE_FIELD_BACK_EXTRA] = backExtra;
        }

        // Fields and Tags in one request; see the note on buildNoteUpdate.
        const note = buildNoteUpdate({ noteId, fields, tags });

        if (note !== null) {
          await ankiRequest("updateNote", { note });
        }

        return {
          content: [
            {
              type: "text",
              text: `Successfully updated cloze note ${noteId}`,
            },
          ],
        };
      }

      if (name === "find-cards") {
        const { query } = FindCardsArgumentsSchema.parse(args);

        const noteIds = await ankiRequest<number[]>("findNotes", { query });

        // The query is the caller's own text, so repeating it is not a fresh
        // injection channel, and it tells the model which search came back
        // empty. Note content is never echoed on this path.
        if (noteIds.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: buildSearchSummary({ matched: 0, shown: [] }),
              },
            ],
          };
        }

        // Only the capped slice is fetched: notesInfo on every match would
        // cost a request per chunk for notes that are never shown.
        const shownIds = noteIds.slice(0, SEARCH_RESULT_LIMIT);

        let allNotes: any[] = [];
        for (let i = 0; i < shownIds.length; i += NOTES_INFO_CHUNK_SIZE) {
          const chunk = shownIds.slice(i, i + NOTES_INFO_CHUNK_SIZE);
          const chunkNotes = await ankiRequest<any[]>("notesInfo", {
            notes: chunk,
          });
          allNotes = allNotes.concat(chunkNotes);
        }

        const shown = allNotes
          .map(summarizeNote)
          .map((note) => truncateSummary(note));

        return {
          content: [
            {
              type: "text",
              // `capped` comes from the id list, not from how many notes came
              // back: notesInfo can return fewer than asked for a note deleted
              // since findNotes, which is not a cap and must not read as one.
              text: buildSearchSummary({
                matched: noteIds.length,
                shown,
                capped: noteIds.length > SEARCH_RESULT_LIMIT,
              }),
            },
          ],
        };
      }

      if (name === "create-cards-bulk") {
        const { deckName, cards } = BulkCreateCardsArgumentsSchema.parse(args);

        const notes = cards.map((card) =>
          buildBasicNote({
            deckName,
            front: card.front,
            back: card.back,
            tags: card.tags,
          })
        );

        return {
          content: [
            { type: "text", text: await addNoteBatch(notes, deckName) },
          ],
        };
      }

      if (name === "create-cloze-cards-bulk") {
        const { deckName, cards } =
          BulkCreateClozeCardsArgumentsSchema.parse(args);

        // Validate the whole batch before sending anything, so a malformed
        // entry fails the call rather than leaving a partial batch in the deck.
        cards.forEach((card, index) => validateClozeText(card.text, index + 1));

        const notes = cards.map((card) =>
          buildClozeNote({
            deckName,
            text: card.text,
            backExtra: card.backExtra,
            tags: card.tags,
          })
        );

        return {
          content: [
            { type: "text", text: await addNoteBatch(notes, deckName) },
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
      console.error(`Attempting to fetch notes for deck: ${deckName}`);

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

      const chunkSize = NOTES_INFO_CHUNK_SIZE;
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

      // Map AnkiConnect notes to our own note shape. Shared with find-cards so
      // the two readers cannot drift apart on field names or placeholders.
      const noteInfo = allNotes.map(summarizeNote);

      console.error(`Successfully retrieved info for ${noteInfo.length} notes`);

      // No truncation here: a deck read returns Note content in full, and only
      // the search path bounds it. See docs/adr/0003.
      const deckContent = noteInfo
        .map(
          (note) =>
            `Note ID: ${note.noteId}\nFront: ${note.front}\nBack: ${note.back}\nTags: ${note.tags.join(
              ", "
            )}\n---`
        )
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
