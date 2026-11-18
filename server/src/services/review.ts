// The operator list at /admin/review (#277). One queue, newest first, of records other work
// already stores on disk under the data dir:
//   review/upload-refusals/  refused uploads (#276)
//   review/queue/            flagged requests (#80), tier changes (#259), app reports (#90)
// Closing one writes review/closures/<id>.json and, through adminMutation, an admin_actions row.
// Nothing here is an app's database: request text, the rule, the scan finding, the report.
//
// When email exists (#88), a new item is told to platform admins only. Nothing is sent until
// that sender exists. The customer and the person who reported are not told.
// A business is listed for repeated refusals once it has two, the smallest count that is more
// than one. The issue does not set the number. Refused requests and refused uploads both count.
// A request the check could not classify does not.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { memberships, projects, tenants, users } from "../db/schema.ts";
import { ConflictError, NotFoundError } from "./errors.ts";

export const REVIEW_DISPOSITIONS = [
  "no_action",
  "tier_changed",
  "owner_contacted",
  "app_offline",
  "business_suspended",
] as const;

export type ReviewDisposition = (typeof REVIEW_DISPOSITIONS)[number];

export const REVIEW_KINDS = ["request", "tier", "upload", "report", "repeated"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

// How many refusals, across requests and uploads, put a business on the list.
export const REPEATED_REFUSALS = 2;

const ID = /^[A-Za-z0-9-]{1,200}$/;

const reasonSchema = z.string().trim().min(1).max(500);
export const closeReviewSchema = z.object({
  id: z.string().regex(ID),
  disposition: z.enum(REVIEW_DISPOSITIONS),
  reason: reasonSchema,
});
export const reviewListSchema = z.object({
  cursor: z.string().regex(ID).nullish(),
  limit: z.number().int().min(1).max(100).default(50),
});

export type NewFlaggedRequest = {
  readonly tenantId: number | null;
  readonly projectId: number | null;
  readonly requestText: string;
  readonly rule: string | null;
  readonly outcome: "refused" | "unclassified";
};

export type NewTierChange = {
  readonly tenantId: number;
  readonly projectId: number;
  readonly fromTier: string;
  readonly toTier: string;
  readonly cause: string;
};

export type NewAppReport = {
  readonly tenantId: number | null;
  readonly projectId: number | null;
  readonly address: string;
  readonly reason: string;
  readonly details: string;
  readonly replyEmail: string;
};

type Closure = {
  readonly disposition: ReviewDisposition;
  readonly reason: string;
  readonly at: Date;
  readonly by: string;
};

type Names = {
  readonly business: ReadonlyMap<number, string>;
  readonly project: ReadonlyMap<number, { readonly name: string; readonly tenantId: number }>;
  readonly ownerEmail: ReadonlyMap<number, string>;
};

export type ReviewItem = {
  readonly id: string;
  readonly kind: ReviewKind;
  readonly at: Date;
  readonly status: "open" | "closed";
  readonly disposition: ReviewDisposition | null;
  readonly closeReason: string | null;
  readonly requestText: string | null;
  readonly rule: string | null;
  readonly outcome: "refused" | "unclassified" | null;
  readonly cause: string | null;
  readonly fromTier: string | null;
  readonly toTier: string | null;
  readonly fileName: string | null;
  readonly fileType: string | null;
  readonly address: string | null;
  readonly replyEmail: string | null;
  readonly count: number | null;
  readonly tenantId: number | null;
  readonly businessName: string | null;
  readonly projectId: number | null;
  readonly projectName: string | null;
  readonly customerEmail: string | null;
};

type RequestSource = NewFlaggedRequest & { readonly id: string; readonly at: Date };
type TierSource = NewTierChange & { readonly id: string; readonly at: Date };
type ReportSource = NewAppReport & { readonly id: string; readonly at: Date };
type UploadSource = {
  readonly id: string;
  readonly at: Date;
  readonly tenantId: number;
  readonly projectId: number;
  readonly uploadedBy: string | null;
  readonly fileName: string;
  readonly fileType: string;
  readonly rule: string;
};

export type ReviewSources = {
  readonly requests: readonly RequestSource[];
  readonly tiers: readonly TierSource[];
  readonly uploads: readonly UploadSource[];
  readonly reports: readonly ReportSource[];
  readonly closures: ReadonlyMap<string, Closure>;
};

const queueDir = (dataDir: string) => join(dataDir, "review", "queue");
const uploadDir = (dataDir: string) => join(dataDir, "review", "upload-refusals");
const closureDir = (dataDir: string) => join(dataDir, "review", "closures");

const stamp = (now: Date) => now.toISOString().replace(/[:.]/g, "-");

const writeQueue = async (
  dataDir: string,
  kind: string,
  body: NewFlaggedRequest | NewTierChange | NewAppReport,
  now: Date
) => {
  const dir = queueDir(dataDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const id = `${kind}-${stamp(now)}-${randomUUID()}`;
  await writeFile(
    join(dir, `${id}.json`),
    JSON.stringify({ ...body, kind, at: now.toISOString() }),
    { mode: 0o600 }
  );
  return { id, at: now.toISOString() };
};

// #80 calls this when a request is refused or the check cannot classify it.
export const recordFlaggedRequest = (dataDir: string, input: NewFlaggedRequest, now = new Date()) =>
  writeQueue(dataDir, "request", input, now);

// #259 calls this when a project's tier changes, with what caused it.
export const recordTierChange = (dataDir: string, input: NewTierChange, now = new Date()) =>
  writeQueue(dataDir, "tier", input, now);

// #90 calls this when a report resolves to a project, or to none.
export const recordAppReport = (dataDir: string, input: NewAppReport, now = new Date()) =>
  writeQueue(dataDir, "report", input, now);

const readJsonDir = async (dir: string): Promise<readonly { id: string; value: unknown }[]> => {
  const names = await readdir(dir).catch(() => [] as string[]);
  const files = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        try {
          return {
            id: name.slice(0, -".json".length),
            value: JSON.parse(await readFile(join(dir, name), "utf8")) as unknown,
          };
        } catch {
          return undefined;
        }
      })
  );
  return files.filter((file) => file !== undefined);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const atOf = (value: unknown): Date | undefined => {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const positive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

const idOrNull = (value: unknown): number | null | undefined => {
  if (value === null) return null;
  return positive(value);
};

const text = (value: unknown, max = 4000): string | undefined =>
  typeof value === "string" && value.length <= max ? value : undefined;

const textOrNull = (value: unknown): string | null | undefined => {
  if (value === null) return null;
  return text(value);
};

const requestOf = (id: string, value: unknown): RequestSource | undefined => {
  if (!isRecord(value) || value.kind !== "request") return undefined;
  const at = atOf(value.at);
  const tenantId = idOrNull(value.tenantId);
  const projectId = idOrNull(value.projectId);
  const requestText = text(value.requestText);
  const rule = textOrNull(value.rule);
  if (
    !at ||
    tenantId === undefined ||
    projectId === undefined ||
    !requestText ||
    rule === undefined
  )
    return undefined;
  if (value.outcome !== "refused" && value.outcome !== "unclassified") return undefined;
  return { id, at, tenantId, projectId, requestText, rule, outcome: value.outcome };
};

const tierOf = (id: string, value: unknown): TierSource | undefined => {
  if (!isRecord(value) || value.kind !== "tier") return undefined;
  const at = atOf(value.at);
  const tenantId = positive(value.tenantId);
  const projectId = positive(value.projectId);
  const fromTier = text(value.fromTier, 80);
  const toTier = text(value.toTier, 80);
  const cause = text(value.cause);
  if (!at || !tenantId || !projectId || !fromTier || !toTier || !cause) return undefined;
  return { id, at, tenantId, projectId, fromTier, toTier, cause };
};

const reportOf = (id: string, value: unknown): ReportSource | undefined => {
  if (!isRecord(value) || value.kind !== "report") return undefined;
  const at = atOf(value.at);
  const tenantId = idOrNull(value.tenantId);
  const projectId = idOrNull(value.projectId);
  const address = text(value.address, 500);
  const reason = text(value.reason, 200);
  const details = text(value.details);
  const replyEmail = text(value.replyEmail, 254);
  if (
    !at ||
    tenantId === undefined ||
    projectId === undefined ||
    !address ||
    !reason ||
    details === undefined ||
    !replyEmail
  )
    return undefined;
  return { id, at, tenantId, projectId, address, reason, details, replyEmail };
};

// The shape fileScan.ts writes. Extra keys (a spreadsheet, a table list) are not read.
const uploadOf = (id: string, value: unknown): UploadSource | undefined => {
  if (!isRecord(value)) return undefined;
  const at = atOf(value.at);
  const tenantId = positive(value.tenantId);
  const projectId = positive(value.projectId);
  const fileName = text(value.name, 500);
  const fileType = text(value.type, 40);
  const rule = text(value.detail);
  const uploadedBy = value.uploadedBy === null ? null : text(value.uploadedBy, 80);
  if (!at || !tenantId || !projectId || !fileName || !fileType || !rule || uploadedBy === undefined)
    return undefined;
  return {
    id: `upload-${id}`,
    at,
    tenantId,
    projectId,
    uploadedBy,
    fileName,
    fileType,
    rule,
  };
};

const closureOf = (value: unknown): Closure | undefined => {
  if (!isRecord(value)) return undefined;
  const at = atOf(value.at);
  const reason = text(value.reason, 500);
  const by = text(value.by, 254);
  if (!at || !reason || !by) return undefined;
  if (!REVIEW_DISPOSITIONS.includes(value.disposition as ReviewDisposition)) return undefined;
  return { disposition: value.disposition as ReviewDisposition, reason, at, by };
};

export const readReviewSources = async (dataDir: string): Promise<ReviewSources> => {
  const [queue, uploads, closures] = await Promise.all([
    readJsonDir(queueDir(dataDir)),
    readJsonDir(uploadDir(dataDir)),
    readJsonDir(closureDir(dataDir)),
  ]);
  const closed = new Map<string, Closure>();
  for (const file of closures) {
    const closure = closureOf(file.value);
    if (closure && ID.test(file.id)) closed.set(file.id, closure);
  }
  return {
    requests: queue.flatMap((file) => {
      const request = requestOf(file.id, file.value);
      return request ? [request] : [];
    }),
    tiers: queue.flatMap((file) => {
      const tier = tierOf(file.id, file.value);
      return tier ? [tier] : [];
    }),
    uploads: uploads.flatMap((file) => {
      const upload = uploadOf(file.id, file.value);
      return upload ? [upload] : [];
    }),
    reports: queue.flatMap((file) => {
      const report = reportOf(file.id, file.value);
      return report ? [report] : [];
    }),
    closures: closed,
  };
};

const emptyNames = (): Names => ({
  business: new Map(),
  project: new Map(),
  ownerEmail: new Map(),
});

const lookupNames = async (
  db: Db,
  tenantIds: readonly number[],
  projectIds: readonly number[]
): Promise<Names> => {
  if (tenantIds.length === 0 && projectIds.length === 0) return emptyNames();
  const [businessRows, projectRows, ownerRows] = await Promise.all([
    tenantIds.length === 0
      ? []
      : db
          .select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
          .from(tenants)
          .where(inArray(tenants.id, [...tenantIds])),
    projectIds.length === 0
      ? []
      : db
          .select({ id: projects.id, name: projects.name, tenantId: projects.tenantId })
          .from(projects)
          .where(inArray(projects.id, [...projectIds])),
    tenantIds.length === 0
      ? []
      : db
          .select({
            tenantId: memberships.tenantId,
            email: users.email,
          })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(and(inArray(memberships.tenantId, [...tenantIds]), eq(memberships.role, "owner")))
          .orderBy(asc(memberships.createdAt), asc(users.email)),
  ]);
  const ownerEmail = new Map<number, string>();
  for (const row of ownerRows)
    if (!ownerEmail.has(row.tenantId)) ownerEmail.set(row.tenantId, row.email);
  return {
    business: new Map(businessRows.map((row) => [row.id, row.name || row.slug])),
    project: new Map(
      projectRows.map((row) => [row.id, { name: row.name, tenantId: row.tenantId }])
    ),
    ownerEmail,
  };
};

const named = (names: Names, tenantId: number | null, projectId: number | null) => {
  const project = projectId === null ? undefined : names.project.get(projectId);
  const businessId = tenantId ?? project?.tenantId ?? null;
  return {
    tenantId: businessId,
    projectId,
    businessName: businessId === null ? null : (names.business.get(businessId) ?? null),
    projectName: project?.name ?? null,
    customerEmail: businessId === null ? null : (names.ownerEmail.get(businessId) ?? null),
  };
};

const closedAs = (
  closures: ReadonlyMap<string, Closure>,
  id: string,
  at: Date,
  // A repeated-refusals item is one row per business. A refusal newer than the close opens it
  // again. A single record stays closed.
  reopenWhenNewer: boolean
): Pick<ReviewItem, "status" | "disposition" | "closeReason"> => {
  const closure = closures.get(id);
  if (!closure || (reopenWhenNewer && at > closure.at))
    return { status: "open", disposition: null, closeReason: null };
  return { status: "closed", disposition: closure.disposition, closeReason: closure.reason };
};

const blank = {
  requestText: null,
  rule: null,
  outcome: null,
  cause: null,
  fromTier: null,
  toTier: null,
  fileName: null,
  fileType: null,
  address: null,
  replyEmail: null,
  count: null,
} as const;

export const assembleReview = (
  sources: ReviewSources,
  names: Names = emptyNames()
): ReviewItem[] => {
  const items: ReviewItem[] = [
    ...sources.requests.map((request) => ({
      ...blank,
      id: request.id,
      kind: "request" as const,
      at: request.at,
      ...closedAs(sources.closures, request.id, request.at, false),
      requestText: request.requestText,
      rule: request.rule,
      outcome: request.outcome,
      ...named(names, request.tenantId, request.projectId),
    })),
    ...sources.tiers.map((tier) => ({
      ...blank,
      id: tier.id,
      kind: "tier" as const,
      at: tier.at,
      ...closedAs(sources.closures, tier.id, tier.at, false),
      cause: tier.cause,
      fromTier: tier.fromTier,
      toTier: tier.toTier,
      ...named(names, tier.tenantId, tier.projectId),
    })),
    ...sources.uploads.map((upload) => ({
      ...blank,
      id: upload.id,
      kind: "upload" as const,
      at: upload.at,
      ...closedAs(sources.closures, upload.id, upload.at, false),
      rule: upload.rule,
      fileName: upload.fileName,
      fileType: upload.fileType,
      ...named(names, upload.tenantId, upload.projectId),
    })),
    ...sources.reports.map((report) => ({
      ...blank,
      id: report.id,
      kind: "report" as const,
      at: report.at,
      ...closedAs(sources.closures, report.id, report.at, false),
      requestText: report.details,
      rule: report.reason,
      address: report.address,
      replyEmail: report.replyEmail,
      ...named(names, report.tenantId, report.projectId),
    })),
  ];

  const refusals = [
    ...sources.requests
      .filter((request) => request.outcome === "refused" && request.tenantId !== null)
      .map((request) => ({
        at: request.at,
        tenantId: request.tenantId as number,
        projectId: request.projectId,
        requestText: request.requestText,
        rule: request.rule,
      })),
    ...sources.uploads.map((upload) => ({
      at: upload.at,
      tenantId: upload.tenantId,
      projectId: upload.projectId,
      requestText: null as string | null,
      rule: upload.rule,
    })),
  ];
  const byBusiness = new Map<number, typeof refusals>();
  for (const refusal of refusals) {
    const list = byBusiness.get(refusal.tenantId) ?? [];
    list.push(refusal);
    byBusiness.set(refusal.tenantId, list);
  }
  for (const [tenantId, list] of byBusiness) {
    if (list.length < REPEATED_REFUSALS) continue;
    const latest = list.reduce((best, refusal) => (refusal.at > best.at ? refusal : best));
    const id = `repeated-${tenantId}`;
    items.push({
      ...blank,
      id,
      kind: "repeated",
      at: latest.at,
      ...closedAs(sources.closures, id, latest.at, true),
      requestText: latest.requestText,
      rule: latest.rule,
      count: list.length,
      ...named(names, tenantId, latest.projectId),
    });
  }

  items.sort(
    (left, right) => right.at.getTime() - left.at.getTime() || (left.id < right.id ? 1 : -1)
  );
  return items;
};

export const listReviewItems = async (db: Db, dataDir: string): Promise<ReviewItem[]> => {
  const sources = await readReviewSources(dataDir);
  const tenantIds = new Set<number>();
  const projectIds = new Set<number>();
  for (const request of sources.requests) {
    if (request.tenantId) tenantIds.add(request.tenantId);
    if (request.projectId) projectIds.add(request.projectId);
  }
  for (const tier of sources.tiers) {
    tenantIds.add(tier.tenantId);
    projectIds.add(tier.projectId);
  }
  for (const upload of sources.uploads) {
    tenantIds.add(upload.tenantId);
    projectIds.add(upload.projectId);
  }
  for (const report of sources.reports) {
    if (report.tenantId) tenantIds.add(report.tenantId);
    if (report.projectId) projectIds.add(report.projectId);
  }
  return assembleReview(sources, await lookupNames(db, [...tenantIds], [...projectIds]));
};

export const pageReviewItems = (
  items: readonly ReviewItem[],
  cursor: string | null | undefined,
  limit: number
) => {
  const start = cursor ? Math.max(0, items.findIndex((item) => item.id === cursor) + 1) : 0;
  const slice = items.slice(start, start + limit + 1);
  const entries = slice.slice(0, limit);
  return {
    entries,
    nextCursor: slice.length > limit ? (entries[entries.length - 1]?.id ?? null) : null,
  };
};

export const reviewOpen = (items: readonly ReviewItem[]) => {
  const open = items.filter((item) => item.status === "open");
  const oldest = open.reduce<Date | null>(
    (best, item) => (best === null || item.at < best ? item.at : best),
    null
  );
  return { count: open.length, oldestAt: oldest };
};

export const writeClosure = async (
  dataDir: string,
  item: Pick<ReviewItem, "id" | "status" | "tenantId">,
  input: { readonly disposition: ReviewDisposition; readonly reason: string },
  by: string,
  now = new Date()
): Promise<{ readonly targetTenantId: number | undefined; readonly detail: string }> => {
  if (!ID.test(item.id)) throw new NotFoundError("That review item does not exist");
  if (item.status === "closed") throw new ConflictError("That review item is already closed");
  const dir = closureDir(dataDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(dir, `${item.id}.json`),
    JSON.stringify({
      disposition: input.disposition,
      reason: input.reason,
      at: now.toISOString(),
      by,
    }),
    { mode: 0o600 }
  );
  return {
    targetTenantId: item.tenantId ?? undefined,
    detail: `${input.disposition} (${item.id}): ${input.reason}`,
  };
};
