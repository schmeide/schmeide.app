// POST /access-requests: the one route schmeide.com may call. Plain JSON, no session.
import type { FastifyInstance } from "fastify";
import type { Db } from "./db/client.ts";
import {
  ACCESS_REQUEST_PATH,
  MARKETING_ORIGIN,
  accessRequestBody,
  clientAddress,
  noteAccessAddress,
  submitAccessRequest,
} from "./services/accessRequests.ts";

export { ACCESS_REQUEST_PATH, MARKETING_ORIGIN };

const OK = { ok: true };
const NO = { ok: false };

// The field the form hides. A visitor leaves it empty; a filled one is answered and not stored.
const honeypotFilled = (body: unknown): boolean => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const website = (body as { readonly website?: unknown }).website;
  return typeof website === "string" && website.trim() !== "";
};

export const registerAccessRequests = (app: FastifyInstance, db: Db) => {
  app.post(ACCESS_REQUEST_PATH, { bodyLimit: 8 * 1024 }, async (request, reply) => {
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== MARKETING_ORIGIN) return reply.status(403).send(NO);
    const address = clientAddress(request.headers["x-forwarded-for"], request.ip);
    if (honeypotFilled(request.body)) {
      const noted = await noteAccessAddress(db, address);
      return noted === "limited" ? reply.status(429).send(NO) : OK;
    }
    const parsed = accessRequestBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(NO);
    const saved = await submitAccessRequest(db, parsed.data, address);
    return saved === "limited" ? reply.status(429).send(NO) : OK;
  });
};
