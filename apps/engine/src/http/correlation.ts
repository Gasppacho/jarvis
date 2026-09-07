/** The response header every Local API operation echoes, so a client's
 * diagnostics can be matched against engine logs. Lives in its own module
 * because both `http/server.ts` (which sets it on normal replies) and
 * `stream/routes.ts` (which writes its own raw head, and would otherwise
 * drop it — issue #60 code review, finding 4) need the same name, and
 * `server.ts` already imports the stream routes. */
export const CORRELATION_HEADER = "x-jarvis-correlation-id";
