import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import superjson from "superjson";

import { App } from "./App";
import { SessionProvider } from "./components/SessionProvider";
import type { AppRouter } from "./server/src/router.ts";
import { TRPCProvider } from "./trpc";
import { classifyError } from "./utils/apiError";

import "./assets/main.css";

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");

// No retries: an unreachable API (the static site, or the server not started) should say so at once.
// A call that answers "signed out" (the session ended, or the approval was removed) asks the
// server again who this is, which sends the person to the sign-in page.
const queryClient: QueryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
  queryCache: new QueryCache({
    onError: (error) => {
      if (classifyError(error) === "signedOut")
        void queryClient.invalidateQueries({ queryKey: [["session"]] });
    },
  }),
});
const trpcClient = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: "/api/trpc", transformer: superjson })],
});

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <SessionProvider>
          <App />
        </SessionProvider>
      </TRPCProvider>
    </QueryClientProvider>
  </StrictMode>
);
