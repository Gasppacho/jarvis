/**
 * Stable error codes from docs/contracts/ERROR_CODES_V1.md. The envelope shape is
 * `ErrorResponse` in contracts/openapi/local-api.v1.yaml.
 */
export type ErrorCode =
  | "api.unauthorized"
  | "api.host-not-allowed"
  | "api.invalid-request"
  | "engine.database-unavailable"
  | "repository.path-invalid"
  | "project.already-imported"
  | "project.config-invalid"
  | "project.bindings-invalid"
  | "project.repository-write-failed"
  | "project.repository-compensation-failed"
  | "project.not-found"
  | "project.active"
  | "project.activation-not-validated"
  | "project.activation-report-stale"
  | "system.internal-error"
  | "system.storage-unavailable";

export interface ErrorEnvelope {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly correlationId: string;
    readonly details?: Record<string, unknown>;
  };
}

export class EngineError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly statusCode: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

export function toErrorEnvelope(
  error: EngineError,
  correlationId: string,
  // Details never echo a submitted secret; callers pass sanitized values only.
): ErrorEnvelope {
  return {
    error: {
      code: error.code,
      message: error.message,
      correlationId,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}
