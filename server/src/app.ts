import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import { fromNodeHeaders } from "better-auth/node";
import Fastify from "fastify";
import { appRouter, type AppContext } from "./router.ts";

export const buildApp = (context: AppContext, logger = false) => {
  const app = Fastify({ logger });
  app.get("/api/healthz", async () => ({ ok: true }));
  app.register(fastifyTRPCPlugin, {
    prefix: "/api/trpc",
    trpcOptions: {
      router: appRouter,
      createContext: ({ req }: { req: { headers: Parameters<typeof fromNodeHeaders>[0] } }) => ({
        ...context,
        headers: fromNodeHeaders(req.headers),
      }),
    },
  });
  // Sign-in, sign-out, and provider returns are Better Auth's own routes. It reads the body
  // itself (JSON from the app, a form post from Apple), so this scope hands it over unparsed.
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) =>
      done(null, body)
    );
    scope.route({
      method: ["GET", "POST"],
      url: "/api/auth/*",
      handler: async (request, reply) => {
        const body = request.body as Buffer | undefined;
        const response = await context.auth.handler(
          new Request(new URL(request.url, `http://${request.headers.host ?? "localhost"}`), {
            method: request.method,
            headers: fromNodeHeaders(request.headers),
            ...(body?.length ? { body: new Uint8Array(body) } : {}),
          })
        );
        reply.status(response.status);
        response.headers.forEach((value, key) => {
          if (key !== "set-cookie") reply.header(key, value);
        });
        const cookies = response.headers.getSetCookie();
        if (cookies.length > 0) reply.header("set-cookie", cookies);
        return reply.send(response.body ? Buffer.from(await response.arrayBuffer()) : null);
      },
    });
  });
  return app;
};
