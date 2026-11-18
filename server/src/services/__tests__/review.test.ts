import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recordUploadRefusal } from "../fileScan.ts";
import {
  assembleReview,
  readReviewSources,
  recordAppReport,
  recordFlaggedRequest,
  recordTierChange,
  writeClosure,
  type ReviewSources,
} from "../review.ts";

const at = (day: string) => new Date(`${day}T12:00:00.000Z`);

const sources = (overrides: Partial<ReviewSources> = {}): ReviewSources => ({
  requests: [],
  tiers: [],
  uploads: [],
  reports: [],
  closures: new Map(),
  ...overrides,
});

describe("assembleReview", () => {
  it("lists every kind newest first and drops anything that is not the review record", () => {
    const items = assembleReview(
      sources({
        requests: [
          {
            id: "request-old",
            at: at("2026-11-01"),
            tenantId: 4,
            projectId: 9,
            requestText: "a clinic's patient records",
            rule: "health-records",
            outcome: "refused",
          },
          {
            id: "request-open",
            at: at("2026-11-02"),
            tenantId: 4,
            projectId: 9,
            requestText: "something we could not sort",
            rule: null,
            outcome: "unclassified",
          },
        ],
        tiers: [
          {
            id: "tier-1",
            at: at("2026-11-04"),
            tenantId: 4,
            projectId: 9,
            fromTier: "build",
            toTier: "guardrails",
            cause: "the plan started keeping customer contacts",
          },
        ],
        uploads: [
          {
            id: "upload-1",
            at: at("2026-11-03"),
            tenantId: 4,
            projectId: 9,
            uploadedBy: null,
            fileName: "catalogue.pdf",
            fileType: "pdf",
            rule: "PDF has a JavaScript action",
          },
        ],
        reports: [
          {
            id: "report-1",
            at: at("2026-11-05"),
            tenantId: 4,
            projectId: 9,
            address: "https://orders.example",
            reason: "it copies my work",
            details: "the photos are mine",
            replyEmail: "pat@example.com",
          },
        ],
      })
    );

    expect(items.map((item) => item.kind)).toEqual([
      "report",
      "tier",
      "upload",
      "repeated",
      "request",
      "request",
    ]);
    const repeated = items.find((item) => item.kind === "repeated");
    expect(repeated).toMatchObject({
      id: "repeated-4",
      count: 2,
      status: "open",
      requestText: null,
      rule: "PDF has a JavaScript action",
    });
    expect(JSON.stringify(items)).not.toContain("secret-row");
    expect(JSON.stringify(items)).not.toContain("patients");
  });

  it("keeps one record closed even when it is dated after the close", () => {
    const items = assembleReview(
      sources({
        closures: new Map([
          [
            "request-1",
            {
              disposition: "no_action",
              reason: "seen",
              at: at("2026-11-01"),
              by: "grace@example.com",
            },
          ],
        ]),
        requests: [
          {
            id: "request-1",
            at: at("2026-12-01"),
            tenantId: 4,
            projectId: null,
            requestText: "patient records",
            rule: "health-records",
            outcome: "refused",
          },
        ],
      })
    );
    expect(items[0]).toMatchObject({ status: "closed", closeReason: "seen" });
  });

  it("does not call one refusal repeated, and does not count a request it could not classify", () => {
    const items = assembleReview(
      sources({
        requests: [
          {
            id: "request-1",
            at: at("2026-11-01"),
            tenantId: 4,
            projectId: null,
            requestText: "a menu",
            rule: null,
            outcome: "unclassified",
          },
        ],
        uploads: [
          {
            id: "upload-1",
            at: at("2026-11-02"),
            tenantId: 4,
            projectId: 9,
            uploadedBy: null,
            fileName: "menu.pdf",
            fileType: "pdf",
            rule: "script",
          },
        ],
      })
    );
    expect(items.map((item) => item.kind)).toEqual(["upload", "request"]);
  });

  it("stays closed until a newer refusal arrives, which opens the business's repeated item again", async () => {
    const closures = new Map([
      [
        "repeated-4",
        {
          disposition: "no_action" as const,
          reason: "looked",
          at: at("2026-11-03"),
          by: "grace@example.com",
        },
      ],
    ]);
    const closed = assembleReview(
      sources({
        closures,
        requests: [
          {
            id: "request-1",
            at: at("2026-11-01"),
            tenantId: 4,
            projectId: 9,
            requestText: "patient records",
            rule: "health-records",
            outcome: "refused",
          },
          {
            id: "request-2",
            at: at("2026-11-02"),
            tenantId: 4,
            projectId: 9,
            requestText: "more records",
            rule: "health-records",
            outcome: "refused",
          },
        ],
      })
    );
    expect(closed.find((item) => item.kind === "repeated")?.status).toBe("closed");

    const reopened = assembleReview(
      sources({
        closures,
        requests: [
          {
            id: "request-1",
            at: at("2026-11-01"),
            tenantId: 4,
            projectId: 9,
            requestText: "patient records",
            rule: "health-records",
            outcome: "refused",
          },
          {
            id: "request-3",
            at: at("2026-11-04"),
            tenantId: 4,
            projectId: 9,
            requestText: "still the records",
            rule: "health-records",
            outcome: "refused",
          },
        ],
      })
    );
    expect(reopened.find((item) => item.kind === "repeated")).toMatchObject({
      status: "open",
      closeReason: null,
      count: 2,
    });
  });
});

describe("review files", () => {
  it("reads back what was recorded and ignores fields that are not part of the record", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "schmeide-review-"));
    const request = await recordFlaggedRequest(
      dataDir,
      {
        tenantId: 4,
        projectId: 9,
        requestText: "patient records",
        rule: "health-records",
        outcome: "refused",
      },
      at("2026-11-01")
    );
    await recordTierChange(
      dataDir,
      {
        tenantId: 4,
        projectId: 9,
        fromTier: "build",
        toTier: "cant_build",
        cause: "the app decides who is hired",
      },
      at("2026-11-02")
    );
    await recordAppReport(
      dataDir,
      {
        tenantId: 4,
        projectId: 9,
        address: "https://orders.example",
        reason: "harmful",
        details: "it lists people",
        replyEmail: "pat@example.com",
      },
      at("2026-11-03")
    );
    await recordUploadRefusal(dataDir, {
      tenantId: 4,
      projectId: 9,
      uploadedBy: "person-1",
      fileId: null,
      name: "catalogue.pdf",
      type: "pdf",
      detail: "PDF has a JavaScript action",
    });
    const planted = join(dataDir, "review", "upload-refusals");
    await mkdir(planted, { recursive: true });
    await writeFile(
      join(planted, "planted.json"),
      JSON.stringify({
        tenantId: 4,
        projectId: 9,
        uploadedBy: null,
        fileId: null,
        name: "prices.xlsx",
        type: "xlsx",
        detail: "macro",
        at: "2026-11-04T00:00:00.000Z",
        rows: ["secret-row"],
        tables: ["patients"],
      })
    );

    const read = await readReviewSources(dataDir);
    expect(JSON.stringify(read)).not.toContain("secret-row");
    expect(JSON.stringify(read)).not.toContain("patients");
    expect(read.requests.map((item) => item.id)).toEqual([request.id]);
    expect(read.tiers).toHaveLength(1);
    expect(read.reports[0]).toMatchObject({
      address: "https://orders.example",
      replyEmail: "pat@example.com",
    });
    expect(read.uploads.map((item) => item.fileName).sort()).toEqual([
      "catalogue.pdf",
      "prices.xlsx",
    ]);

    const [item] = assembleReview(read);
    await writeClosure(
      dataDir,
      item,
      { disposition: "owner_contacted", reason: "wrote to them" },
      "grace@example.com"
    );
    const again = await readReviewSources(dataDir);
    expect(assembleReview(again).find((entry) => entry.id === item.id)?.status).toBe("closed");
  });
});
