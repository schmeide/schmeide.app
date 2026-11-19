import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import { fromNodeHeaders } from "better-auth/node";
import Fastify from "fastify";
import { ACCESS_REQUEST_PATH, MARKETING_ORIGIN, registerAccessRequests } from "./accessRequests.ts";
import { registerPlans } from "./plans.ts";
import { appRouter, BUSINESS_HEADER, type AppContext, type Context } from "./router.ts";
import { AUTH_PATH, AUTH_PATHS_WHILE_IMPERSONATING, currentPerson } from "./services/auth.ts";
import type { FileScanner, NewUploadRefusal } from "./services/fileScan.ts";
import type { UploadLimits } from "./services/files.ts";
import { registerUploads } from "./uploads.ts";

type Options = {
  readonly logger?: boolean;
  // The address people open the app at. When the API is on another origin (the hosted site),
  // that origin alone may call it from a browser, with the session cookie.
  readonly allowOrigin?: string;
  readonly uploadLimits?: UploadLimits;
  readonly scanner?: FileScanner;
  readonly recordUploadRefusal?: (refusal: NewUploadRefusal) => Promise<unknown>;
};

export const buildApp = (
  context: AppContext,
  { logger = false, allowOrigin, uploadLimits, scanner, recordUploadRefusal }: Options = {}
) => {
  const app = Fastify({ logger });
  // Every answer is about one signed-in person (or one origin), so nothing may keep a copy.
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("cache-control", "no-store");
  });
  // schmeide.com may post an access request, and only that. No session cookie on this route.
  app.addHook("onRequest", async (request, reply) => {
    if (request.url.split("?")[0] !== ACCESS_REQUEST_PATH) return;
    if (request.headers.origin !== MARKETING_ORIGIN) return;
    reply.header("access-control-allow-origin", MARKETING_ORIGIN);
    if (request.method !== "OPTIONS") return;
    return reply
      .header("access-control-allow-methods", "POST")
      .header("access-control-allow-headers", "content-type")
      .header("access-control-max-age", "600")
      .status(204)
      .send();
  });
  if (allowOrigin) {
    app.addHook("onRequest", async (request, reply) => {
      if (request.url.split("?")[0] === ACCESS_REQUEST_PATH) return;
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
  app.get("/healthz", async () => ({ ok: true }));
  registerPlans(app);
  registerUploads(app, context, uploadLimits, { scanner, recordUploadRefusal });
  registerAccessRequests(app, context.db);
  app.register(fastifyTRPCPlugin, {
    prefix: "/trpc",
    trpcOptions: {
      router: appRouter,
      createContext: ({
        req,
      }: {
        req: { headers: Parameters<typeof fromNodeHeaders>[0] };
      }): Context => ({
        ...context,
        headers: fromNodeHeaders(req.headers),
        responseCookies: [],
      }),
      // Cookies a procedure set (starting or stopping a view as someone), only when nothing failed.
      responseMeta: ({ ctx, errors }: { ctx?: Context; errors: readonly unknown[] }) =>
        ctx && errors.length === 0 && ctx.responseCookies.length > 0
          ? { headers: new Headers(ctx.responseCookies.map((cookie) => ["set-cookie", cookie])) }
          : {},
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
      url: `${AUTH_PATH}/*`,
      handler: async (request, reply) => {
        const body = request.body as Buffer | undefined;
        // The route below Better Auth's address, which is the one the browser used: in `make
        // serve` it has the /api in front that Vite strips before it gets here.
        const route = request.url.slice(AUTH_PATH.length);
        const url = new URL(`${context.auth.options.baseURL}${route}`);
        const headers = fromNodeHeaders(request.headers);
        // A session an admin views the app through reaches only the routes on the list: none
        // that change how the person signs in. Default deny, so a route an upgrade adds is
        // refused too. Stopping the view is the `impersonation.stop` procedure. Asked on every
        // route, so a view that is over is ended before Better Auth sees it.
        const person = await currentPerson(context, headers);
        if (person?.impersonatedBy && !AUTH_PATHS_WHILE_IMPERSONATING.includes(route.split("?")[0]))
          return reply
            .status(403)
            .send({ code: "IMPERSONATING", message: "Not while viewing as someone else" });
        const response = await context.auth.handler(
          new Request(url, {
            method: request.method,
            headers,
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
