// Services throw these; the router maps them to tRPC codes.
export class NotFoundError extends Error {}
export class ConflictError extends Error {}
// Another build is running (one at a time); the API marks it so the UI need not parse the message.
export class BuildRunningError extends ConflictError {}
