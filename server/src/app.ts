import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import Fastify from "fastify";
import { appRouter, type Context } from "./router.ts";

export const buildApp = (context: Context, logger = false) => {
  const app = Fastify({ logger });
  app.get("/api/healthz", async () => ({ ok: true }));
  app.register(fastifyTRPCPlugin, {
    prefix: "/api/trpc",
    trpcOptions: { router: appRouter, createContext: () => context },
  });
  return app;
};
