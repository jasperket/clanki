import * as http from "http";

// The AnkiConnect endpoint. Overridable because AnkiConnect can be configured to
// bind a different port, and because a user may tunnel it from another machine.
// The default is AnkiConnect's own default and covers almost every install.
const ANKI_CONNECT_URL = new URL(
  process.env.CLANKI_ANKI_CONNECT_URL ?? "http://127.0.0.1:8765"
);

// AnkiConnect actions that return `null` on success rather than a value. A null
// result from anything NOT listed here is a real failure, so this must be
// extended whenever a new mutating action is called — otherwise the action
// succeeds in Anki and this server reports an error anyway, which for a
// destructive action is the worst case: the caller may retry.
const NULL_ON_SUCCESS_ACTIONS = new Set([
  "updateNoteFields",
  "updateNote",
  "replaceTags",
  "deleteNotes",
]);

interface AnkiResponse<T> {
  result: T;
  error: string | null;
}

// Marks an error that came back in AnkiConnect's own `error` field, as opposed
// to a socket or HTTP failure.
//
// The distinction drives the retry loop. A transport failure is worth retrying:
// Anki may still be starting, or the port may not be listening yet. An
// AnkiConnect-level error is a verdict — "model was not found", "deck was not
// found" — and the same request will fail identically every time. Retrying it
// only makes the user wait ~7s (1s + 2s + 4s) before seeing a message that was
// available immediately.
export class AnkiConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnkiConnectError";
  }
}

// The shape every caller of AnkiConnect depends on. Named so that modules which
// need to make requests can accept it as a parameter and be tested with a fake
// rather than a live Anki.
export type AnkiRequestFn = <T>(
  action: string,
  params?: Record<string, any>
) => Promise<T>;

// Helper function for making AnkiConnect requests with retries
export async function ankiRequest<T>(
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
                reject(
                  new AnkiConnectError(`AnkiConnect error: ${parsedData.error}`)
                );
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
      // A verdict from AnkiConnect will not change on a retry, so surface it now.
      if (error instanceof AnkiConnectError) {
        throw error;
      }
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
