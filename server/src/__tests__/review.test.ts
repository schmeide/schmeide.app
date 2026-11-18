import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import { adminActions, users } from "../db/schema.ts";
import type { AppContext } from "../router.ts";
import { createProject } from "../services/projects.ts";
import { recordAppReport, recordFlaggedRequest, recordTierChange } from "../services/review.ts";
import { aSignedInAdmin, aSignedInPerson, callApi, testAuth } from "./testAuth.ts";

const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());

const dataDir = mkdtempSync(join(tmpdir(), "schmeide-review-api-"));
const deps: AppContext = {
  db,
  dataDir,
  workflows: { start: vi.fn(), getHandle: vi.fn() as never },
  taskQueue: "test",
  interviewer: vi.fn(),
  siteFetcher: vi.fn(),
  websiteReader: vi.fn(),
  files: {} as never,
  reader: vi.fn(),
  resources: {} as never,
  auth: testAuth(db),
  providers: [],
};
const app = buildApp(deps);
afterAll(() => app.close());

const noProcedure = (path: string) => ({
  status: 404,
  code: "NOT_FOUND",
  message: `No procedure found on path "${path}"`,
});

const answer = async (path: string, cookie = "", input?: unknown) => {
  const { status, code, message } = await callApi(app, path, input, cookie);
  return { status, code, message };
};

const at = (day: string) => new Date(`${day}T12:00:00.000Z`);

describe("admin.review", () => {
  it("answers a customer and a signed-out caller as a procedure that does not exist", async () => {
    const owner = await aSignedInPerson(app, deps);
    for (const path of ["admin.review.list", "admin.review.open", "admin.review.close"]) {
      expect(
        await answer(path, owner.cookie, { id: "request-1", disposition: "no_action", reason: "x" })
      ).toEqual(noProcedure(path));
      expect(await answer(path)).toEqual(noProcedure(path));
    }
  });

  it("lists each kind, with the project and business a report resolves to, and no app data", async () => {
    const owner = await aSignedInPerson(app, deps);
    const admin = await aSignedInAdmin(app, deps);
    const project = await createProject(db, { name: "Orders", tenantId: owner.tenantId });
    await recordFlaggedRequest(
      dataDir,
      {
        tenantId: owner.tenantId,
        projectId: project.id,
        requestText: "a clinic's patient records",
        rule: "health-records",
        outcome: "refused",
      },
      at("2026-11-01")
    );
    await recordFlaggedRequest(
      dataDir,
      {
        tenantId: owner.tenantId,
        projectId: project.id,
        requestText: "the same records again",
        rule: "health-records",
        outcome: "refused",
      },
      at("2026-11-02")
    );
    await recordTierChange(
      dataDir,
      {
        tenantId: owner.tenantId,
        projectId: project.id,
        fromTier: "build",
        toTier: "guardrails",
        cause: "the plan started keeping customer contacts",
      },
      at("2026-11-04")
    );
    await recordAppReport(
      dataDir,
      {
        tenantId: owner.tenantId,
        projectId: project.id,
        address: "https://orders.example",
        reason: "it copies my work",
        details: "the photos are mine",
        replyEmail: "pat@example.com",
      },
      at("2026-11-05")
    );
    const refusals = join(dataDir, "review", "upload-refusals");
    await mkdir(refusals, { recursive: true });
    await writeFile(
      join(refusals, "scan.json"),
      JSON.stringify({
        tenantId: owner.tenantId,
        projectId: project.id,
        uploadedBy: null,
        fileId: null,
        name: "catalogue.pdf",
        type: "pdf",
        detail: "PDF has a JavaScript action",
        at: "2026-11-03T12:00:00.000Z",
        rows: ["secret-row"],
        tables: ["patients"],
      })
    );

    const { data } = await callApi(app, "admin.review.list", {}, admin.cookie);
    expect(data.entries.map((entry: { kind: string }) => entry.kind)).toEqual([
      "report",
      "tier",
      "upload",
      "repeated",
      "request",
      "request",
    ]);
    expect(data.entries[0]).toMatchObject({
      kind: "report",
      requestText: "the photos are mine",
      rule: "it copies my work",
      address: "https://orders.example",
      replyEmail: "pat@example.com",
      projectName: "Orders",
      customerEmail: owner.email,
      status: "open",
    });
    expect(data.entries[0].businessName).toContain("Ada Example");
    expect(data.entries.find((entry: { kind: string }) => entry.kind === "tier")).toMatchObject({
      fromTier: "build",
      toTier: "guardrails",
      cause: "the plan started keeping customer contacts",
    });
    expect(data.entries.find((entry: { kind: string }) => entry.kind === "upload")).toMatchObject({
      fileName: "catalogue.pdf",
      rule: "PDF has a JavaScript action",
    });
    expect(data.entries.find((entry: { kind: string }) => entry.kind === "repeated")).toMatchObject(
      {
        count: 3,
        customerEmail: owner.email,
      }
    );
    const body = JSON.stringify(data);
    expect(body).not.toContain("secret-row");
    expect(body).not.toContain("patients");
    expect(body).toContain("a clinic's patient records");

    const open = await callApi(app, "admin.review.open", undefined, admin.cookie);
    expect(open.data.count).toBe(6);
    expect(open.data.oldestAt).toContain("2026-11-01");
  });

  it("asks for a reason, then records the close on the item and in the audit log", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const owner = await aSignedInPerson(app, deps);
    const [adminRow] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, admin.email));
    const recorded = await recordFlaggedRequest(
      dataDir,
      {
        tenantId: owner.tenantId,
        projectId: null,
        requestText: "close me",
        rule: "health-records",
        outcome: "refused",
      },
      new Date("2026-12-01T12:00:00.000Z")
    );
    const id = recorded.id;

    expect(
      await answer("admin.review.close", admin.cookie, {
        id,
        disposition: "no_action",
        reason: " ",
      })
    ).toMatchObject({ code: "BAD_REQUEST" });

    const closed = await callApi(
      app,
      "admin.review.close",
      { id, disposition: "owner_contacted", reason: "wrote to the owner" },
      admin.cookie
    );
    expect(closed.status).toBe(200);

    const again = await callApi(app, "admin.review.list", {}, admin.cookie);
    expect(again.data.entries.find((entry: { id: string }) => entry.id === id)).toMatchObject({
      status: "closed",
      disposition: "owner_contacted",
      closeReason: "wrote to the owner",
    });
    const rows = await db.select().from(adminActions).where(eq(adminActions.adminId, adminRow.id));
    expect(
      rows.some((row) => row.action === "review.close" && row.detail.includes("wrote to the owner"))
    ).toBe(true);

    expect(
      await answer("admin.review.close", admin.cookie, {
        id,
        disposition: "no_action",
        reason: "again",
      })
    ).toMatchObject({ code: "CONFLICT" });
  });
});
