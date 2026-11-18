// Services throw these; the router maps them to tRPC codes.
export class NotFoundError extends Error {}
export class ConflictError extends Error {}
export class ForbiddenError extends Error {}
// The input was well formed but wrong, such as a confirmation that does not match.
export class BadInputError extends Error {}
// The model could not produce the next interview turn; the caller can fall back or try again.
export class InterviewUnavailableError extends Error {}
export class ReaderUnavailableError extends Error {}
export class DamagedFileError extends Error {}
export class ReadUnavailableError extends Error {}
export class UploadRefusedError extends Error {
  readonly code: string;
  // Why the scan refused the file, for the operator record. The message is what the person sees.
  readonly detail: string | undefined;
  constructor(code: string, message: string, detail?: string) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}
// The business is suspended (services/businesses.ts): its members cannot open it, and nothing in
// it builds. The one message, so the client and the worker's build log say the same thing.
export const BUSINESS_SUSPENDED = "This business is suspended";
// The server runs with SCHMEIDE_BUILDS=off (Stage 1 on AKS): it plans apps but builds and hosts
// none. Refused as a ConflictError with this message.
export const BUILDS_OFF =
  "Building apps is not open yet. Your plan and proposal are saved, and can be built once it opens.";
export class BusinessSuspendedError extends Error {
  constructor() {
    super(BUSINESS_SUSPENDED);
  }
}
