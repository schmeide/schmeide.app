// Services throw these; the router maps them to tRPC codes.
export class NotFoundError extends Error {}
export class ConflictError extends Error {}
// The model could not produce the next interview turn; the caller can fall back or try again.
export class InterviewUnavailableError extends Error {}
export class ReaderUnavailableError extends Error {}
export class DamagedFileError extends Error {}
export class ReadUnavailableError extends Error {}
export class UploadRefusedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
