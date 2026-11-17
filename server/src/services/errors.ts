// Services throw these; the router maps them to tRPC codes.
export class NotFoundError extends Error {}
export class ConflictError extends Error {}
// The model could not produce the next interview turn; the caller can fall back or try again.
export class InterviewUnavailableError extends Error {}
export class ReaderUnavailableError extends Error {}
