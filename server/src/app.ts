import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import { fromNodeHeaders } from "better-auth/node";
import Fastify from "fastify";
import { appRouter, BUSINESS_HEADER, type AppContext } from "./router.ts";
import type { UploadLimits } from "./services/files.ts";
import { registerUploads } from "./uploads.ts";

type Options = {
  readonly logger?: boolean;
  // The address people open the app at. When the API is on another origin (the hosted site),
  // that origin alone may call it from a browser, with the session cookie.
  readonly allowOrigin?: string;
  readonly uploadLimits?: UploadLimits;
};

export const buildApp = (
  context: AppContext,
  { logger = false, allowOrigin, uploadLimits }: Options = {}
) => {
  const app = Fastify({ logger });
  // Every answer is about one signed-in person (or one origin), so nothing may keep a copy.
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("cache-control", "no-store");
  });
  if (allowOrigin) {
    app.addHook("onRequest", async (request, reply) => {
      if (request.headers.origin !== allowOrigin) return;
      reply.header("access-control-allow-origin", allowOrigin);
      reply.header("access-control-allow-credentials", "true");
      if (request.method !== "OPTIONS") return;
      // The browser asks first whether a call with JSON, or with the business header, is allowed.
      return reply
        .header("access-control-allow-methods", "GET, POST")
        .header("access-control-allow-headers", `content-type, ${BUSINESS_HEADER}`)
        .header("access-control-max-age", "600")
        .status(204)
        .send();
    });
  }
  app.get("/api/healthz", async () => ({ ok: true }));
  registerUploads(app, context, uploadLimits);
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
