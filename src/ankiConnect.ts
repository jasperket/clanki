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

// AnkiConnect actions that must never be retried automatically.
//
// The criterion, which is the part to apply when adding an action: an action
// belongs here when SENDING IT TWICE PRODUCES A DIFFERENT COLLECTION THAN
// SENDING IT ONCE. That is a property of the action itself -- not of how likely
// a retry is, and emphatically not of how destructive the action is.
//
// Why it matters: a lost response is indistinguishable from a request that never
// arrived. If Anki commits `addNotes` and the reply is dropped -- socket reset,
// timeout, Anki busy -- the retry sends the same batch again and every Note is
// added twice, silently. AnkiConnect has no idempotency key and no request id,
// so neither side can tell a retry from a new call (issue #23).
//
// Applying the criterion to every action this server sends:
//
//   addNotes    IN.  Creates N Notes with new ids each call. The reported bug.
//   addNote     IN.  The same property at N=1. Included because the rule is
//                    about the action, and leaving it out would teach the wrong
//                    one to whoever adds the next action.
//   createDeck  out. Returns the existing Deck's id for a name already present,
//                    so a second call changes nothing.
//   deleteNotes out. Succeeds silently on an id that is no longer in the
//                    collection (see partitionExistingNotes in notes.ts), so
//                    deleting twice reaches the same state as deleting once.
//                    NOTE THE ASYMMETRY: this action is destructive but
//                    idempotent. Danger is not the test -- idempotence is. Do
//                    not add it here "to be safe"; that would only convert a
//                    recoverable blip into a failed deletion.
//   updateNoteFields, updateNote, replaceTags
//               out. Writing the same values twice leaves the same state.
//                    `replaceTags` renames A to B and finds no A the second time.
//   findNotes, notesInfo, deckNames, canAddNotesWithErrorDetail, version
//               out. Reads.
//
// This set and NULL_ON_SUCCESS_ACTIONS happen to be disjoint. That is a
// coincidence of which actions exist, not a rule -- do not fold them together.
const NON_IDEMPOTENT_ACTIONS = new Set(["addNote", "addNotes"]);

// Whether an action is one a lost response makes ambiguous rather than safe to
// resend. Exported as a predicate rather than the Set so the set itself stays
// closed and the classification can be asserted in tests.
export function isNonIdempotent(action: string): boolean {
  return NON_IDEMPOTENT_ACTIONS.has(action);
}

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

// Marks a write that was sent but whose outcome is unknown: a non-idempotent
// action failed at the transport level, so Anki may or may not have committed it.
//
// This is the exact opposite of AnkiConnectError and the two must not be
// conflated. An AnkiConnectError means Anki ANSWERED and refused, so nothing was
// written and the caller can safely try something else. This means Anki DID NOT
// ANSWER, so the caller cannot know what is in the collection without looking.
//
// It exists as a class, rather than a flag or a message convention, so a caller
// can recognise the case with `instanceof` instead of matching on message text
// -- the same reason AnkiConnectError is a class. The message here stays at the
// transport level and names no MCP tool; the caller-facing wording belongs where
// the tool names live (see addNoteBatch in index.ts).
export class UnconfirmedWriteError extends Error {
  readonly action: string;

  constructor(action: string, cause: string) {
    super(
      `${action} got no usable response so it is not known whether the write landed. Underlying error: ${cause}`
    );
    this.name = "UnconfirmedWriteError";
    this.action = action;
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

  // A non-idempotent action gets one attempt and no retry, whatever the caller
  // asked for. The override is deliberate: this is a safety property, and a
  // caller that thinks it knows better must not be able to defeat it by passing
  // a retry count. No call site passes one today.
  //
  // Held in its own const rather than reassigning `retries`. Mutating a
  // parameter reads like a bug and invites a "cleanup" that quietly restores
  // the retries this exists to prevent.
  const attempts = isNonIdempotent(action) ? 1 : retries;

  for (let attempt = 1; attempt <= attempts; attempt++) {
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
            `Error in ankiRequest (attempt ${attempt}/${attempts}):`,
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
      //
      // This check MUST stay ahead of the UnconfirmedWriteError below. A verdict
      // means Anki received the request and refused it, so nothing was written
      // and there is no ambiguity to report -- wrapping it would tell the caller
      // its Notes might be in the collection when they certainly are not.
      if (error instanceof AnkiConnectError) {
        throw error;
      }

      // No usable response for an action that cannot be safely resent. The
      // request may have been committed before the connection died, so the
      // outcome is unknown rather than failed, and saying "failed" would invite
      // exactly the blind retry that duplicates the batch.
      if (isNonIdempotent(action)) {
        throw new UnconfirmedWriteError(
          action,
          error instanceof Error ? error.message : String(error)
        );
      }

      if (attempt === attempts) {
        throw error;
      }
      console.error(
        `Attempt ${attempt}/${attempts} failed, retrying after ${delay}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      // Increase delay for next attempt
      delay *= 2;
    }
  }

  throw new Error(`Failed after ${attempts} attempts`);
}
