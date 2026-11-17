import { TRPCError } from "@trpc/server";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { FILE_OWNERS, FILE_PURPOSES, type FileType } from "./db/schema.ts";
import {
  callerOf,
  NOT_IN_A_BUSINESS,
  recordWrite,
  SIGN_IN_FIRST,
  type AppContext,
} from "./router.ts";
import type { Person } from "./services/auth.ts";
import { assertProjectIn } from "./services/businesses.ts";
import { BUSINESS_SUSPENDED, NotFoundError, UploadRefusedError } from "./services/errors.ts";
import { declaredType } from "./services/fileTypes.ts";
import {
  REFUSAL_STATUS,
  UPLOAD_LIMITS,
  acceptedTypesMessage,
  tooLargeMessage,
  uploadFile,
  type Refusal,
  type UploadLimits,
} from "./services/files.ts";

export const UPLOAD_PATH = "/projects/:id/files";

const querySchema = z.object({
  name: z.string().max(1000).default(""),
  owner: z.enum(FILE_OWNERS),
  purpose: z.enum(FILE_PURPOSES).default("reference"),
});

type Caller = {
  readonly person: Person;
  readonly tenantId: number;
  readonly projectId: number;
  readonly declared: FileType | "any";
};

const refusal = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.status(status).send({ error: { code, message } });

export const registerUploads = (
  app: FastifyInstance,
  context: AppContext,
  limits: UploadLimits = UPLOAD_LIMITS
): void => {
  const callers = new WeakMap<FastifyRequest, Caller>();
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) =>
      done(null, body)
    );
    scope.setErrorHandler((error: { readonly statusCode?: number }, _request, reply) =>
      error.statusCode === 413
        ? refusal(reply, 413, "too_large", tooLargeMessage(limits))
        : refusal(reply, 500, "failed", "The file could not be saved. Try again in a moment.")
    );
    scope.route<{ Params: { id: string } }>({
      method: "POST",
      url: UPLOAD_PATH,
      bodyLimit: limits.fileBytes,
      onRequest: async (request, reply) => {
        const caller = await callerOf(context, fromNodeHeaders(request.headers)).catch(
          (error: unknown) => {
            if (error instanceof TRPCError && error.code === "FORBIDDEN")
              return "forbidden" as const;
            if (error instanceof TRPCError && error.code === "PRECONDITION_FAILED")
              return "suspended" as const;
            throw error;
          }
        );
        if (!caller) return refusal(reply, 401, "unauthorized", SIGN_IN_FIRST);
        if (caller === "forbidden") return refusal(reply, 403, "forbidden", NOT_IN_A_BUSINESS);
        if (caller === "suspended") return refusal(reply, 403, "suspended", BUSINESS_SUSPENDED);
        // An upload is a write: while an admin views as the person, it is on record first.
        await recordWrite(context, caller, "files.upload");
        const projectId = Number(request.params.id);
        try {
          if (!Number.isSafeInteger(projectId) || projectId < 1)
            throw new NotFoundError(`Project ${request.params.id} not found`);
          await assertProjectIn(context.db, caller.tenantId, projectId);
        } catch (error) {
          if (!(error instanceof NotFoundError)) throw error;
          return refusal(reply, 404, "not_found", error.message);
        }
        const declared = declaredType(request.headers["content-type"]);
        if (!declared) {
          return refusal(
            reply,
            REFUSAL_STATUS.unsupported_type,
            "unsupported_type" satisfies Refusal,
            `This kind of file is not accepted. ${acceptedTypesMessage(limits)}`
          );
        }
        callers.set(request, { ...caller, projectId, declared });
      },
      handler: async (request, reply) => {
        const caller = callers.get(request);
        if (!caller) return refusal(reply, 401, "unauthorized", SIGN_IN_FIRST);
        const query = querySchema.safeParse(request.query);
        if (!query.success) {
          return refusal(
            reply,
            400,
            "bad_request",
            "Say whose this file is (owner=mine or owner=someone_else) and send it again."
          );
        }
        try {
          const file = await uploadFile(
            context,
            {
              tenantId: caller.tenantId,
              projectId: caller.projectId,
              uploadedBy: caller.person.id,
              declared: caller.declared,
              bytes: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
              ...query.data,
            },
            limits
          );
          return reply.status(201).send({ file });
        } catch (error) {
          if (!(error instanceof UploadRefusedError)) throw error;
          return refusal(
            reply,
            REFUSAL_STATUS[error.code as Refusal] ?? 400,
            error.code,
            error.message
          );
        }
      },
    });
  });
};
