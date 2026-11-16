import { TRPCClientError } from "@trpc/client";

import { classifyError } from "../apiError";

const trpcError = (code: string, message: string) =>
  TRPCClientError.from({ error: { code: -32000, message, data: { code, httpStatus: 400 } } });

describe("classifyError", () => {
  it("treats an error without a tRPC code as an unreachable server", () => {
    expect(classifyError(TRPCClientError.from(new TypeError("Failed to fetch")))).toBe(
      "unreachable"
    );
  });

  it("tells a running build apart from other conflicts", () => {
    expect(
      classifyError(trpcError("CONFLICT", "Build 3 is still running; wait for it to finish"))
    ).toBe("busy");
    expect(
      classifyError(trpcError("CONFLICT", "Project 1 is live; this needs it to be draft"))
    ).toBe("conflict");
  });

  it("maps the other codes", () => {
    expect(classifyError(trpcError("NOT_FOUND", "Project 9 not found"))).toBe("notFound");
    expect(classifyError(trpcError("BAD_REQUEST", "too long"))).toBe("badRequest");
    expect(classifyError(trpcError("INTERNAL_SERVER_ERROR", "boom"))).toBe("other");
  });
});
