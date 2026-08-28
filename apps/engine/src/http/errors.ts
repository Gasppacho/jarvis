import { randomBytes } from "node:crypto";
import type { components } from "../api/generated/local-api.ts";

export type ErrorResponse = components["schemas"]["ErrorResponse"];

/** Correlates one API call across shell logs, engine logs and diagnostics. */
export function newCorrelationId(): string {
  return `api_${randomBytes(9).toString("base64url")}`;
}

/**
 * The single error shape of the Local API. `message` is safe to display and
 * `details` never carries a secret (docs/contracts/LOCAL_API_V1.md).
 */
export function errorResponse(code: string, message: string): ErrorResponse {
  return { error: { code, message, correlationId: newCorrelationId() } };
}
