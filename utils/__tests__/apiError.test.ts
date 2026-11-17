import { TRPCClientError } from "@trpc/client";

import { classifyError } from "../apiError";

const trpcError = (code: string, message: string) =>
  TRPCClientError.from({
    error: { code: -32000, message, data: { code, httpStatus: 400 } },
  });

describe("classifyError", () => {
  it("treats an error without a tRPC code as an unreachable server", () => {
    expect(classifyError(TRPCClientError.from(new TypeError("Failed to fetch")))).toBe(
      "unreachable"
    );
  });

  it("maps the codes", () => {
    expect(
      classifyError(trpcError("CONFLICT", "Project 1 is live; this needs it to be draft"))
    ).toBe("conflict");
    expect(classifyError(trpcError("NOT_FOUND", "Project 9 not found"))).toBe("notFound");
    expect(classifyError(trpcError("FORBIDDEN", "not a member"))).toBe("forbidden");
    expect(classifyError(trpcError("BAD_REQUEST", "too long"))).toBe("badRequest");
    expect(classifyError(trpcError("SERVICE_UNAVAILABLE", "no model"))).toBe("unavailable");
    expect(classifyError(trpcError("PRECONDITION_FAILED", "This business is suspended"))).toBe(
      "suspended"
    );
    expect(classifyError(trpcError("INTERNAL_SERVER_ERROR", "boom"))).toBe("other");
  });
});
