import type { FastifyInstance } from "fastify";
import { PLANS } from "../../utils/plans.ts";

// `GET /plans`, for schmeide.com's pricing page: public and the same for everyone, so any site may
// read it and caches may keep it. No session is read, and no credentials are allowed even for the
// app's own origin.
export const registerPlans = (app: FastifyInstance) =>
  app.get("/plans", async (_request, reply) =>
    reply
      .header("cache-control", "public, max-age=300")
      .header("access-control-allow-origin", "*")
      .removeHeader("access-control-allow-credentials")
      .send({ plans: PLANS })
  );
