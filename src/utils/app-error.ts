export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.status = STATUS[code];
  }

  static notFound(what: string) {
    return new AppError("NOT_FOUND", `${what} not found`);
  }
  static conflict(message: string) {
    return new AppError("CONFLICT", message);
  }
  static forbidden(message = "You don't have access to this resource") {
    return new AppError("FORBIDDEN", message);
  }
  static unauthenticated(message = "Please sign in") {
    return new AppError("UNAUTHENTICATED", message);
  }
}
