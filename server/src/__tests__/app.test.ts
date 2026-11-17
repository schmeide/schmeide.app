import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import { finishBuild } from "../services/builds.ts";
import { InterviewUnavailableError } from "../services/errors.ts";
import type { Interviewer } from "../services/interview.ts";
import { approveSpec, createProject, transition } from "../services/projects.ts";
import type { AppContext } from "../router.ts";
import { aSignedInPerson, testAuth } from "./testAuth.ts";

const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());

const interviewer = vi.fn<Interviewer>();
const deps: AppContext = {
  db,
  workflows: { start: vi.fn(async () => ({}) as never), getHandle: vi.fn() as never },
  taskQueue: "test",
  interviewer,
  siteFetcher: vi.fn(),
  websiteReader: vi.fn(),
  files: {} as never,
  reader: vi.fn(),
  resources: {} as never,
  auth: testAuth(db),
  providers: [],
};

describe("the API", () => {
  it("answers CONFLICT when a running build is edited as if it were queued", async () => {
    const app = buildApp(deps);
    const { cookie, tenantId } = await aSignedInPerson(app, deps);
    const project = await createProject(db, { name: `api ${randomUUID()}`, tenantId });
    await transition(db, project.id, ["draft"], { status: "spec_ready", spec: "## Features" });
    const { build } = await approveSpec(deps, project.id);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/trpc/builds.editQueued",
        headers: { cookie },
        payload: { json: { buildId: build.id, request: "something else" } },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.json.data).toMatchObject({ code: "CONFLICT" });
    } finally {
      await finishBuild(db, build.id);
      await app.close();
    }
  });

  it("runs an interview: a question, an answer, and the plan they produce", async () => {
    const app = buildApp(deps);
    const { cookie, tenantId } = await aSignedInPerson(app, deps);
    const project = await createProject(db, { name: `api ${randomUUID()}`, tenantId });
    const call = (path: string, json: unknown) =>
      app.inject({
        method: "POST",
        url: `/api/trpc/${path}`,
        headers: { cookie },
        payload: { json },
      });
    const empty = { add: [], update: [], remove: [], ready: [] };
    interviewer
      .mockResolvedValueOnce({
        turn: { ...empty, question: { text: "Who uses it?", kind: "text", choices: [] } },
        usage: null,
      })
      .mockResolvedValueOnce({
        turn: {
          ...empty,
          add: [{ section: "who", text: "Only the owner", phase: "day_one" }],
          ready: ["who"],
          question: null,
        },
        usage: null,
      });
    try {
      const started = await call("interview.start", { id: project.id });
      const questionId: number = started.json().result.data.json.current.id;
      const answered = await call("interview.answer", {
        id: project.id,
        questionId,
        answer: { type: "text", value: "Just me" },
      });
      const added = await call("interview.addItem", {
        id: project.id,
        section: "does",
        text: "Create an invoice",
      });

      expect(answered.json().result.data.json).toMatchObject({
        finished: true,
        sections: { who: "ready", does: "not_started" },
      });
      expect(added.json().result.data.json).toMatchObject({ source: "you", phase: "day_one" });
    } finally {
      await app.close();
    }
  });

  it("answers SERVICE_UNAVAILABLE when the next question cannot be produced", async () => {
    const app = buildApp(deps);
    const { cookie, tenantId } = await aSignedInPerson(app, deps);
    const project = await createProject(db, { name: `api ${randomUUID()}`, tenantId });
    interviewer.mockRejectedValueOnce(new InterviewUnavailableError("The model run failed"));
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/trpc/interview.start",
        headers: { cookie },
        payload: { json: { id: project.id } },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json().error.json.data).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    } finally {
      await app.close();
    }
  });
});
