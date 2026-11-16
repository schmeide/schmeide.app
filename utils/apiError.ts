import { TRPCClientError } from "@trpc/client";

export type ApiProblem = "unreachable" | "notFound" | "busy" | "conflict" | "badRequest" | "other";

// An error with no tRPC code never reached the server: it is down, or this is the static site.
export const classifyError = (error: unknown): ApiProblem => {
  if (!(error instanceof TRPCClientError)) return "other";
  const data: unknown = error.data;
  const code = typeof data === "object" && data && "code" in data ? data.code : undefined;
  if (!code) return "unreachable";
  if (code === "NOT_FOUND") return "notFound";
  // ponytail: matches the server's "Build N is still running" message; a dedicated error code would be sturdier
  if (code === "CONFLICT") return /still running/.test(error.message) ? "busy" : "conflict";
  if (code === "BAD_REQUEST") return "badRequest";
  return "other";
};
