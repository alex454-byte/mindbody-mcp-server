/**
 * Error hierarchy for Mindbody API failures.
 */

export class MboError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "MboError";
  }
}

export class MboAuthError extends MboError {
  constructor(message: string) {
    super(message, 401);
    this.name = "MboAuthError";
  }
}

export class MboRateLimitError extends MboError {
  constructor(message: string) {
    super(message, 429);
    this.name = "MboRateLimitError";
  }
}
