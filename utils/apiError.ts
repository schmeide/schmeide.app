import { TRPCClientError } from "@trpc/client";

export type ApiProblem =
  "unreachable" | "notFound" | "forbidden" | "conflict" | "badRequest" | "unavailable" | "other";

// An error with no tRPC code never reached the server: it is down, or this is the static site.
export const classifyError = (error: unknown): ApiProblem => {
  if (!(error instanceof TRPCClientError)) return "other";
  const data: unknown = error.data;
  const code = typeof data === "object" && data && "code" in data ? data.code : undefined;
  if (!code) return "unreachable";
  if (code === "NOT_FOUND") return "notFound";
  if (code === "FORBIDDEN") return "forbidden";
  if (code === "CONFLICT") return "conflict";
  if (code === "BAD_REQUEST") return "badRequest";
  // The server answered, but something it relies on (the model) did not.
  if (code === "SERVICE_UNAVAILABLE") return "unavailable";
  return "other";
};
