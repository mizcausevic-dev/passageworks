export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class JobCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "JobCancelled";
  }
}

export class IngestError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable: boolean, message = code) {
    super(message);
    this.name = "IngestError";
    this.code = code;
    this.retryable = retryable;
  }
}
