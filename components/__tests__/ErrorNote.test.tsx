import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { TRPCClientError } from "@trpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { copy } from "../../data/copy";

// Whether the API is hosted is read once, when the module loads, so each case loads it afresh.
const load = async (apiUrl: string) => {
  vi.stubEnv("VITE_API_URL", apiUrl);
  vi.resetModules();
  return import("../ErrorNote");
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("serverDownText", () => {
  it("never tells a customer on the hosted site how to start the server", async () => {
    const { serverDownText } = await load("https://api.schmeide.app");
    expect(serverDownText).toBe(copy.errors.serverDown);
    expect(serverDownText).not.toContain("make serve");
  });

  it("tells a developer running the site locally to run make serve", async () => {
    const { serverDownText } = await load("");
    expect(serverDownText).toContain("make serve");
  });
});

const trpcError = (code: string, message: string) =>
  TRPCClientError.from({ error: { code: -32000, message, data: { code, httpStatus: 400 } } });

const renderNote = async (error: Error) => {
  const { ErrorNote } = await load("");
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  render(
    <QueryClientProvider client={queryClient}>
      <ErrorNote error={error} />
    </QueryClientProvider>
  );
  return invalidate;
};

describe("ErrorNote", () => {
  it("says a conflict brought the page up to date, and refreshes it", async () => {
    const invalidate = await renderNote(
      trpcError("CONFLICT", "This page was out of date: the app is “Building” now")
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      `This page was out of date: the app is “Building” now. ${copy.errors.refreshed}`
    );
    expect(invalidate).toHaveBeenCalled();
  });

  it("names a next step for an unknown error, without the server's words", async () => {
    const invalidate = await renderNote(trpcError("INTERNAL_SERVER_ERROR", "relation x missing"));
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(copy.errors.other);
    expect(alert).toHaveTextContent("Try again");
    expect(alert).toHaveTextContent("~/.schmeide/logs");
    expect(alert).not.toHaveTextContent("relation x missing");
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("asks for a refused request to be fixed and sent again", async () => {
    await renderNote(trpcError("BAD_REQUEST", "The name is too long"));
    expect(screen.getByRole("alert")).toHaveTextContent(
      `${copy.errors.badRequest} The name is too long. ${copy.errors.badRequestNext}`
    );
  });
});
