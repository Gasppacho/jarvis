/**
 * A failure the Local API can express with a stable code, as opposed to an
 * unexpected crash. `message` is safe to display and carries no secret and no
 * echoed user value beyond what the caller already sent.
 */
export class JarvisError extends Error {
  override readonly name = "JarvisError";

  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, statusCode: number, message: string) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }

  static badRequest(code: string, message: string): JarvisError {
    return new JarvisError(code, 400, message);
  }

  static notFound(code: string, message: string): JarvisError {
    return new JarvisError(code, 404, message);
  }

  static conflict(code: string, message: string): JarvisError {
    return new JarvisError(code, 409, message);
  }

  static unavailable(code: string, message: string): JarvisError {
    return new JarvisError(code, 503, message);
  }
}
