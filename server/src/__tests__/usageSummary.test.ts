import { afterAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import { usage, type NewUsage } from "../db/schema.ts";
import type { AppContext } from "../router.ts";
import { createProject, deleteProjectRows } from "../services/projects.ts";
import { aSignedInAdmin, aSignedInPerson, adminPaths, callApi, testAuth } from "./testAuth.ts";

const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());

const deps: AppContext = {
  db,
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

type Totals = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly costUsd: number;
};
type Summary = {
  readonly businesses: readonly (Totals & { readonly id: number; readonly name: string })[];
  readonly projects: readonly (Totals & {
    readonly id: number;
    readonly name: string;
    readonly business: { readonly id: number; readonly name: string };
  })[];
  readonly models: readonly (Totals & { readonly model: string })[];
  readonly runKinds: readonly (Totals & { readonly runKind: string })[];
};

// Each test reads its own month of an otherwise empty year, so tests running alongside cannot
// add to its sums.
const row = (projectId: number, at: string, overrides: Partial<NewUsage> = {}): NewUsage => ({
  projectId,
  runKind: "change",
  model: "claude-sonnet",
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: 30,
  cacheCreationTokens: 40,
  costUsd: 0.1,
  at: new Date(at),
  ...overrides,
});

const aBusinessWithAProject = async (name: string) => {
  const owner = await aSignedInPerson(app, deps, { name });
  const project = await createProject(db, { name: `${name}'s app`, tenantId: owner.tenantId });
  return { tenantId: owner.tenantId, project };
};

const summary = async (cookie: string, input: object) => {
  const answer = await callApi(app, "admin.usage.summary", input, cookie);
  return answer.data as Summary;
};

describe("the usage summary", () => {
  it("is on the admin base, which admin.test.ts walks as an owner and as nobody", () => {
    expect(adminPaths).toContain("admin.usage.summary");
  });

  it("sums each business's rows without mixing them, biggest spender first", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const small = await aBusinessWithAProject("Sam");
    const big = await aBusinessWithAProject("Bea");
    await db
      .insert(usage)
      .values([
        row(small.project.id, "2001-03-05T12:00:00Z"),
        row(small.project.id, "2001-03-06T12:00:00Z", { costUsd: 0.2 }),
        row(big.project.id, "2001-03-07T12:00:00Z", { costUsd: 5, runKind: "spec", model: "opus" }),
      ]);

    const result = await summary(admin.cookie, { from: "2001-03-01", to: "2001-03-31" });
    expect(result.businesses).toEqual([
      {
        id: big.tenantId,
        name: "Bea’s business",
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheCreationTokens: 40,
        costUsd: 5,
      },
      {
        id: small.tenantId,
        name: "Sam’s business",
        inputTokens: 20,
        outputTokens: 40,
        cacheReadTokens: 60,
        cacheCreationTokens: 80,
        // Summed as numeric in the database: 0.1 + 0.2 in floating point is 0.30000000000000004.
        costUsd: 0.3,
      },
    ]);
    expect(result.projects.map(({ id, business, costUsd }) => [id, business.id, costUsd])).toEqual([
      [big.project.id, big.tenantId, 5],
      [small.project.id, small.tenantId, 0.3],
    ]);
    expect(result.models.map(({ model, costUsd }) => [model, costUsd])).toEqual([
      ["opus", 5],
      ["claude-sonnet", 0.3],
    ]);
    expect(result.runKinds.map(({ runKind, inputTokens }) => [runKind, inputTokens])).toEqual([
      ["spec", 10],
      ["change", 20],
    ]);
  });

  it("includes its first day and excludes the day after its last, in UTC", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const { project } = await aBusinessWithAProject("Pat");
    await db.insert(usage).values([
      row(project.id, "2002-04-30T23:59:59.999Z", { inputTokens: 1 }),
      row(project.id, "2002-05-01T00:00:00Z", { inputTokens: 100 }),
      row(project.id, "2002-05-31T23:59:59.999Z", { inputTokens: 1000 }),
      row(project.id, "2002-06-01T00:00:00Z", { inputTokens: 10000 }),
      // Still 31 May in New York, but 1 June in UTC: out.
      row(project.id, "2002-05-31T22:00:00-04:00", { inputTokens: 100000 }),
    ]);
    const result = await summary(admin.cookie, { from: "2002-05-01", to: "2002-05-31" });
    expect(result.projects.map(({ inputTokens }) => inputTokens)).toEqual([1100]);
    const oneDay = await summary(admin.cookie, { from: "2002-05-31", to: "2002-05-31" });
    expect(oneDay.projects.map(({ inputTokens }) => inputTokens)).toEqual([1000]);
  });

  it("narrows to one business, over all time when no period is given", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const mine = await aBusinessWithAProject("Mo");
    const other = await aBusinessWithAProject("Ola");
    await db
      .insert(usage)
      .values([
        row(mine.project.id, "2003-01-01T00:00:00Z"),
        row(mine.project.id, "2024-01-01T00:00:00Z"),
        row(other.project.id, "2024-01-01T00:00:00Z"),
      ]);
    const result = await summary(admin.cookie, { tenantId: mine.tenantId });
    expect(result.businesses).toEqual([
      expect.objectContaining({ id: mine.tenantId, inputTokens: 20, costUsd: 0.2 }),
    ]);
    expect(result.projects.map(({ id }) => id)).toEqual([mine.project.id]);
  });

  it("leaves out a deleted project, whose usage is deleted with it", async () => {
    const admin = await aSignedInAdmin(app, deps);
    const { tenantId, project } = await aBusinessWithAProject("Del");
    await db.insert(usage).values([row(project.id, "2004-02-02T00:00:00Z")]);
    await deleteProjectRows(db, project.id);
    const result = await summary(admin.cookie, { tenantId });
    expect(result.businesses).toEqual([]);
  });

  it("refuses a period that ends before it starts, or is not a day", async () => {
    const admin = await aSignedInAdmin(app, deps);
    for (const input of [
      { from: "2005-02-02", to: "2005-02-01" },
      { from: "2005-02-30", to: "2005-03-01" },
      { from: "February", to: "2005-03-01" },
    ]) {
      const { code } = await callApi(app, "admin.usage.summary", input, admin.cookie);
      expect([input, code]).toEqual([input, "BAD_REQUEST"]);
    }
  });
});
