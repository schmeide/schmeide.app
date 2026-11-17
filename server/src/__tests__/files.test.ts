import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import {
  approvedEmails,
  buildFiles,
  builds,
  files,
  planItems,
  usage,
  users,
} from "../db/schema.ts";
import { BUSINESS_HEADER, type AppContext } from "../router.ts";
import { approveEmail } from "../services/access.ts";
import { ReadUnavailableError } from "../services/errors.ts";
import type { FileReader } from "../services/fileReader.ts";
import { createLocalFileStore } from "../services/fileStore.ts";
import {
  READ_FAILURES,
  acceptedTypesMessage,
  cleanName,
  type UploadLimits,
} from "../services/files.ts";
import { createProject, deleteProjectRows, transition } from "../services/projects.ts";
import {
  JPEG,
  PDF,
  PNG,
  PNG_HEAD,
  PNG_IDAT,
  PNG_IEND,
  PNG_IHDR,
  WEBP,
  exifPayload,
  jpegSegment,
  jpegWith,
  pngChunk,
  xlsxOf,
  zipOf,
} from "../services/__tests__/fileFixtures.ts";
import { aSignedInPerson, callApi, testAuth } from "./testAuth.ts";

const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());

const dataDir = mkdtempSync(join(tmpdir(), "schmeide-files-"));
const start = vi.fn(async () => ({}) as never);
const reader = vi.fn<FileReader>();
const deps: AppContext = {
  db,
  workflows: { start, getHandle: vi.fn() as never },
  taskQueue: "test",
  interviewer: vi.fn(),
  files: createLocalFileStore(dataDir),
  resources: {} as never,
  reader,
  siteFetcher: vi.fn(),
  websiteReader: vi.fn(),
  auth: testAuth(db),
  providers: [],
};
const LIMITS: UploadLimits = {
  pictureBytes: 4096,
  fileBytes: 8192,
  filesPerProject: 3,
  bytesPerBusiness: 12_000,
};
const app = buildApp(deps, { uploadLimits: LIMITS });
afterAll(() => app.close());
beforeEach(() => {
  start.mockClear();
  reader.mockReset();
});

const CSV = Buffer.from("Client name,Amount owed\nAda Example,120\nBob Example,80\n");
const XLSX = xlsxOf([
  ["Client name", "Amount owed"],
  ["Ada Example", 120],
]);
const HEIC = Buffer.from("\0\0\0\x18ftypheic\0\0\0\0mif1heic", "latin1");
const PHONE_PHOTO = jpegWith(JPEG, jpegSegment(0xe1, exifPayload(1)));
const ANY = "application/octet-stream";

type Sent = {
  readonly type?: string;
  readonly name?: string;
  readonly owner?: string | null;
  readonly purpose?: string;
  readonly headers?: Readonly<Record<string, string>>;
};

const upload = async (
  cookie: string,
  projectId: number | string,
  payload: Buffer | Readable,
  { type = ANY, name = "file", owner = "mine", purpose, headers = {} }: Sent = {}
) => {
  const query = new URLSearchParams({
    name,
    ...(owner === null ? {} : { owner }),
    ...(purpose ? { purpose } : {}),
  });
  const response = await app.inject({
    method: "POST",
    url: `/projects/${projectId}/files?${query}`,
    headers: { cookie, "content-type": type, ...headers },
    payload,
  });
  const body = response.json();
  return {
    status: response.statusCode,
    file: body.file as (typeof files.$inferSelect & { createdAt: string }) | undefined,
    code: body.error?.code as string | undefined,
    message: body.error?.message as string | undefined,
  };
};

const aProject = (tenantId: number) =>
  createProject(db, { name: `files ${randomUUID()}`, tenantId });

const anOwner = async () => {
  const person = await aSignedInPerson(app, deps);
  return { ...person, project: await aProject(person.tenantId) };
};

const pathOf = (tenantId: number, projectId: number, fileId: number) =>
  join(dataDir, "files", String(tenantId), String(projectId), String(fileId));

const rowsOf = (projectId: number) => db.select().from(files).where(eq(files.projectId, projectId));

describe("uploading a file", () => {
  it("stores it for the project with who sent it, whose it is, and what it is for", async () => {
    const { cookie, email, tenantId, project } = await anOwner();
    const [person] = await db.select().from(users).where(eq(users.email, email));

    const sent = await upload(cookie, project.id, PHONE_PHOTO, {
      type: "image/jpeg",
      name: "paper form.jpg",
      purpose: "in_app",
    });

    expect(sent.status).toBe(201);
    expect(sent.file).toMatchObject({
      projectId: project.id,
      uploadedBy: person.id,
      owner: "mine",
      purpose: "in_app",
      type: "jpeg",
      size: JPEG.length,
      originalName: "paper form.jpg",
      displayName: "paper form.jpg",
    });
    expect(await rowsOf(project.id)).toHaveLength(1);
    const stored = readFileSync(pathOf(tenantId, project.id, sent.file?.id ?? 0));
    expect(stored.equals(JPEG)).toBe(true);
    expect(stored.includes("SecretCam")).toBe(false);
  });

  it("is for reference only unless it says otherwise, and may be someone else's", async () => {
    const { cookie, project } = await anOwner();

    const sent = await upload(cookie, project.id, PNG, { owner: "someone_else" });

    expect(sent.file).toMatchObject({ owner: "someone_else", purpose: "reference", type: "png" });
  });

  it.each([
    ["png", PNG, "image/png"],
    ["jpeg", JPEG, "image/jpeg"],
    ["webp", WEBP, "image/webp"],
    ["pdf", PDF, "application/pdf"],
    ["csv", CSV, "text/csv"],
    ["xlsx", XLSX, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ])("accepts %s by what it holds, declared or not", async (type, bytes, mime) => {
    const { cookie, project } = await anOwner();

    expect((await upload(cookie, project.id, bytes, { type: mime })).file?.type).toBe(type);
    expect((await upload(cookie, project.id, bytes)).file?.type).toBe(type);
  });

  it("strips a PNG's text and camera details before storing it", async () => {
    const { cookie, tenantId, project } = await anOwner();
    const loaded = Buffer.concat([
      PNG_HEAD,
      PNG_IHDR,
      pngChunk("tEXt", Buffer.from("Author\0Ada Example")),
      pngChunk("eXIf", exifPayload(1).subarray(6)),
      PNG_IDAT,
      PNG_IEND,
    ]);

    const sent = await upload(cookie, project.id, loaded);

    expect(sent.file?.size).toBe(PNG.length);
    expect(readFileSync(pathOf(tenantId, project.id, sent.file?.id ?? 0)).equals(PNG)).toBe(true);
  });

  it("never uses the file's name as a place to store it", async () => {
    const { cookie, tenantId, project } = await anOwner();

    const sent = await upload(cookie, project.id, PNG, {
      name: "../../../etc/cron.d/evil\u0000\u202E.png",
    });

    expect(sent.file?.originalName).toBe("evil.png");
    expect(readdirSync(join(dataDir, "files", String(tenantId), String(project.id)))).toEqual([
      String(sent.file?.id),
    ]);
    expect(cleanName("C:\\Users\\ada\\form.png")).toBe("form.png");
    expect(cleanName(" \n ")).toBe("file");
    expect(cleanName("x".repeat(500))).toHaveLength(200);
  });

  it("answers 401 to a signed-out caller and to one taken off the approved list", async () => {
    const { cookie, email, project } = await anOwner();

    const signedOut = await upload("", project.id, PNG);
    expect([signedOut.status, signedOut.code]).toEqual([401, "unauthorized"]);

    await db.delete(approvedEmails).where(eq(approvedEmails.email, email));
    const removed = await upload(cookie, project.id, PNG);
    expect([removed.status, removed.code]).toEqual([401, "unauthorized"]);
    expect(await rowsOf(project.id)).toEqual([]);
  });

  it("answers 404 for a project in another business, exactly as for one that does not exist", async () => {
    const { project, tenantId } = await anOwner();
    const other = await aSignedInPerson(app, deps, { name: "Mallory" });

    const theirs = await upload(other.cookie, project.id, PNG);
    const missing = await upload(other.cookie, 2_000_000_000, PNG);
    const named = await upload(other.cookie, project.id, PNG, {
      headers: { [BUSINESS_HEADER]: String(tenantId) },
    });

    expect([theirs.status, theirs.code]).toEqual([404, "not_found"]);
    expect(theirs.message).toBe(missing.message?.replace("2000000000", String(project.id)));
    expect([named.status, named.code]).toEqual([404, "not_found"]);
    expect((await upload(other.cookie, "abc", PNG)).status).toBe(404);
    expect(await rowsOf(project.id)).toEqual([]);
    expect(existsSync(join(dataDir, "files", String(tenantId)))).toBe(false);
  });

  it("lets a person in several businesses name the one the project is in", async () => {
    const ada = await aSignedInPerson(app, deps);
    const bob = await anOwner();
    await approveEmail(db, ada.email, { tenantId: bob.tenantId });

    const unnamed = await upload(ada.cookie, bob.project.id, PNG);
    const named = await upload(ada.cookie, bob.project.id, PNG, {
      headers: { [BUSINESS_HEADER]: String(bob.tenantId) },
    });

    expect(unnamed.status).toBe(404);
    expect(named.status).toBe(201);
  });

  it("refuses a file whose content is not what it says it is, with a reason to show", async () => {
    const { cookie, project } = await anOwner();

    const sent = await upload(cookie, project.id, PNG, { type: "image/jpeg", name: "form.jpg" });

    expect([sent.status, sent.code]).toEqual([415, "type_mismatch"]);
    expect(sent.message).toContain("a JPEG picture");
    expect(sent.message).toContain("a PNG picture");
    expect(await rowsOf(project.id)).toEqual([]);
  });

  it.each([
    ["a HEIC picture sent undeclared", HEIC, ANY],
    ["a HEIC picture sent as one", HEIC, "image/heic"],
    ["a PNG sent as plain text", PNG, "text/plain"],
    ["a zip that is not a spreadsheet", zipOf([{ name: "a.txt", data: Buffer.from("a") }]), ANY],
    ["a script named like a picture", Buffer.from("#!/bin/sh\nrm -rf /\n"), ANY],
  ])("refuses %s and names the accepted types and sizes", async (_, bytes, type) => {
    const { cookie, project } = await anOwner();

    const sent = await upload(cookie, project.id, bytes, { type, name: "picture.png" });

    expect([sent.status, sent.code]).toEqual([415, "unsupported_type"]);
    expect(sent.message).toContain("PNG, JPEG, or WebP picture of at most");
    expect(sent.message).toContain("PDF, CSV, or Excel (XLSX) file of at most");
    expect(acceptedTypesMessage()).toBe(
      "Send a PNG, JPEG, or WebP picture of at most 5 MB, or a PDF, CSV, or Excel (XLSX) file of at most 10 MB."
    );
    expect(await rowsOf(project.id)).toEqual([]);
  });

  it("refuses a file over the size limit, also when the size is not announced up front", async () => {
    const { cookie, project } = await anOwner();
    const big = Buffer.concat([CSV, randomBytes(LIMITS.fileBytes).fill("a")]);

    const announced = await upload(cookie, project.id, big, { type: "text/csv" });
    const streamed = await upload(
      cookie,
      project.id,
      Readable.from([big.subarray(0, 5000), big.subarray(5000)]),
      { type: "text/csv" }
    );

    expect([announced.status, announced.code]).toEqual([413, "too_large"]);
    expect([streamed.status, streamed.code]).toEqual([413, "too_large"]);
    expect(streamed.message).toContain("too large");
    expect(await rowsOf(project.id)).toEqual([]);
  });

  it("holds pictures to their own, smaller limit", async () => {
    const { cookie, project } = await anOwner();
    const bigPicture = Buffer.concat([
      PNG_HEAD,
      PNG_IHDR,
      pngChunk("IDAT", randomBytes(LIMITS.pictureBytes)),
      PNG_IEND,
    ]);

    const sent = await upload(cookie, project.id, bigPicture);

    expect(bigPicture.length).toBeLessThan(LIMITS.fileBytes);
    expect([sent.status, sent.code]).toEqual([413, "too_large"]);
  });

  it("refuses more files than a project may hold, and says how to make room", async () => {
    const { cookie, project } = await anOwner();
    for (let sent = 0; sent < LIMITS.filesPerProject; sent++)
      expect((await upload(cookie, project.id, PNG)).status).toBe(201);

    const extra = await upload(cookie, project.id, PNG);

    expect([extra.status, extra.code]).toEqual([409, "too_many_files"]);
    expect(extra.message).toContain("Remove one");
    expect(await rowsOf(project.id)).toHaveLength(LIMITS.filesPerProject);
  });

  it("refuses more bytes than a business may hold across its projects, and no other business", async () => {
    const { cookie, tenantId, project } = await anOwner();
    const second = await aProject(tenantId);
    const other = await anOwner();
    const large = Buffer.concat([CSV, Buffer.alloc(5000, "a")]);
    expect((await upload(cookie, project.id, large)).status).toBe(201);
    expect((await upload(cookie, second.id, large)).status).toBe(201);

    const extra = await upload(cookie, second.id, large);

    expect([extra.status, extra.code]).toEqual([409, "business_full"]);
    expect(extra.message).toContain("Remove files");
    expect((await upload(cookie, second.id, PNG)).status).toBe(201);
    expect((await upload(other.cookie, other.project.id, large)).status).toBe(201);
  });

  it("refuses to take something that is someone else's for use in the app", async () => {
    const { cookie, project } = await anOwner();

    const sent = await upload(cookie, project.id, PNG, {
      owner: "someone_else",
      purpose: "in_app",
    });

    expect([sent.status, sent.code]).toEqual([422, "not_yours"]);
    expect(await rowsOf(project.id)).toEqual([]);
  });

  it("refuses a damaged picture instead of storing it unstripped", async () => {
    const { cookie, project } = await anOwner();

    const sent = await upload(cookie, project.id, PHONE_PHOTO.subarray(0, PHONE_PHOTO.length - 2));

    expect([sent.status, sent.code]).toEqual([422, "damaged"]);
    expect(await rowsOf(project.id)).toEqual([]);
  });

  it("refuses an upload that does not say whose the file is, or is empty", async () => {
    const { cookie, project } = await anOwner();

    const unowned = await upload(cookie, project.id, PNG, { owner: null });
    const strange = await upload(cookie, project.id, PNG, { owner: "the internet" });
    const empty = await upload(cookie, project.id, Buffer.alloc(0));

    expect([unowned.status, unowned.code]).toEqual([400, "bad_request"]);
    expect(strange.status).toBe(400);
    expect([empty.status, empty.code]).toEqual([400, "empty"]);
  });
});

describe("a project's files", () => {
  it("are listed oldest first", async () => {
    const { cookie, project } = await anOwner();
    const first = await upload(cookie, project.id, PNG, { name: "one.png" });
    const second = await upload(cookie, project.id, CSV, { name: "two.csv" });

    const listed = await callApi(app, "files.list", { id: project.id }, cookie);

    expect(listed.data.map((file: { id: number }) => file.id)).toEqual([
      first.file?.id,
      second.file?.id,
    ]);
    expect(listed.data[1]).toMatchObject({ type: "csv", displayName: "two.csv", size: CSV.length });
  });

  it("can be given a new name for screen readers, which leaves the file name alone", async () => {
    const { cookie, tenantId, project } = await anOwner();
    const elsewhere = await aProject(tenantId);
    const { file } = await upload(cookie, project.id, PNG, { name: "IMG_0042.png" });
    const fileId = file?.id ?? 0;

    const renamed = await callApi(
      app,
      "files.rename",
      { id: project.id, fileId, displayName: "  The paper order form  " },
      cookie
    );
    const blank = await callApi(
      app,
      "files.rename",
      { id: project.id, fileId, displayName: "   " },
      cookie
    );
    const wrongProject = await callApi(
      app,
      "files.rename",
      { id: elsewhere.id, fileId, displayName: "Moved" },
      cookie
    );

    expect(renamed.data).toMatchObject({
      displayName: "The paper order form",
      originalName: "IMG_0042.png",
    });
    expect(blank.code).toBe("BAD_REQUEST");
    expect(wrongProject.code).toBe("NOT_FOUND");
    expect((await rowsOf(project.id))[0].displayName).toBe("The paper order form");
  });

  it("can be deleted, which removes the stored file too", async () => {
    const { cookie, tenantId, project } = await anOwner();
    const { file } = await upload(cookie, project.id, PNG);
    const fileId = file?.id ?? 0;
    expect(existsSync(pathOf(tenantId, project.id, fileId))).toBe(true);

    const deleted = await callApi(app, "files.delete", { id: project.id, fileId }, cookie);
    const again = await callApi(app, "files.delete", { id: project.id, fileId }, cookie);

    expect(deleted.data.id).toBe(fileId);
    expect(again.code).toBe("NOT_FOUND");
    expect(await rowsOf(project.id)).toEqual([]);
    expect(existsSync(pathOf(tenantId, project.id, fileId))).toBe(false);
  });

  it("answer NOT_FOUND to another business on every call, and stay as they were", async () => {
    const { cookie, tenantId, project } = await anOwner();
    const other = await aSignedInPerson(app, deps, { name: "Mallory" });
    const { file } = await upload(cookie, project.id, PNG, { name: "secret plan.png" });
    const fileId = file?.id ?? 0;
    const calls = {
      "files.list": { id: project.id },
      "files.rename": { id: project.id, fileId, displayName: "Taken over" },
      "files.delete": { id: project.id, fileId },
      "files.read": { id: project.id, fileId },
    };

    for (const [path, input] of Object.entries(calls)) {
      const answer = await callApi(app, path, input, other.cookie);
      expect([path, answer.code]).toEqual([path, "NOT_FOUND"]);
      expect(answer.message).not.toContain("secret");
    }

    expect(reader).not.toHaveBeenCalled();
    expect(await rowsOf(project.id)).toEqual([
      expect.objectContaining({ id: fileId, displayName: "secret plan.png" }),
    ]);
    expect(existsSync(pathOf(tenantId, project.id, fileId))).toBe(true);
  });

  it("go when the project's rows are deleted, with what attached them to changes", async () => {
    const { cookie, project } = await anOwner();
    const { file } = await upload(cookie, project.id, PNG);
    await transition(db, project.id, ["draft"], { status: "live", spec: "## Features" });
    const changed = await callApi(
      app,
      "projects.requestChange",
      { id: project.id, request: "Make it look like this", fileIds: [file?.id] },
      cookie
    );
    expect(changed.status).toBe(200);

    await deleteProjectRows(db, project.id);

    expect(await rowsOf(project.id)).toEqual([]);
    expect(
      await db
        .select()
        .from(buildFiles)
        .where(eq(buildFiles.fileId, file?.id ?? 0))
    ).toEqual([]);
  });
});

describe("attaching files to a change request", () => {
  it("records the files with the change, once each", async () => {
    const { cookie, project } = await anOwner();
    const one = await upload(cookie, project.id, PNG);
    const two = await upload(cookie, project.id, JPEG);
    await transition(db, project.id, ["draft"], { status: "live", spec: "## Features" });

    const changed = await callApi(
      app,
      "projects.requestChange",
      {
        id: project.id,
        request: "Make it look like this",
        fileIds: [one.file?.id, two.file?.id, one.file?.id],
      },
      cookie
    );

    const attached = await db
      .select()
      .from(buildFiles)
      .where(eq(buildFiles.buildId, changed.data.build.id));
    expect(attached.map((row) => row.fileId).sort()).toEqual([one.file?.id, two.file?.id].sort());
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("refuses a file from another project and starts nothing", async () => {
    const { cookie, tenantId, project } = await anOwner();
    const elsewhere = await aProject(tenantId);
    const { file } = await upload(cookie, elsewhere.id, PNG);
    await transition(db, project.id, ["draft"], { status: "live", spec: "## Features" });

    const changed = await callApi(
      app,
      "projects.requestChange",
      { id: project.id, request: "Use that one", fileIds: [file?.id] },
      cookie
    );

    expect(changed.code).toBe("NOT_FOUND");
    expect(start).not.toHaveBeenCalled();
    expect(await db.select().from(builds).where(eq(builds.projectId, project.id))).toEqual([]);
  });
});

describe("reading a file into proposals", () => {
  const read = (cookie: string, id: number, fileId: number | undefined) =>
    callApi(app, "files.read", { id, fileId }, cookie);

  it("reads a spreadsheet's columns without the model, as things the app keeps", async () => {
    const { cookie, project } = await anOwner();
    const sheet = await upload(cookie, project.id, XLSX);
    const list = await upload(cookie, project.id, CSV);

    const fromSheet = await read(cookie, project.id, sheet.file?.id);
    const fromList = await read(cookie, project.id, list.file?.id);

    expect(fromSheet.data).toEqual({
      status: "read",
      fileId: sheet.file?.id,
      proposals: [
        { section: "keeps", text: "Client name" },
        { section: "keeps", text: "Amount owed" },
      ],
      table: {
        sheet: "Clients",
        columns: ["Client name", "Amount owed"],
        sampleRows: [["Ada Example", "120"]],
      },
    });
    expect(fromList.data.proposals).toEqual(fromSheet.data.proposals);
    expect(fromList.data.table.sampleRows).toEqual([
      ["Ada Example", "120"],
      ["Bob Example", "80"],
    ]);
    expect(reader).not.toHaveBeenCalled();
    expect(await db.select().from(usage).where(eq(usage.projectId, project.id))).toEqual([]);
  });

  it("sends a picture to the model, records what it cost, and leaves the plan alone", async () => {
    const { cookie, project } = await anOwner();
    const { file } = await upload(cookie, project.id, PHONE_PHOTO, {
      name: "order form.jpg",
      owner: "someone_else",
    });
    reader.mockResolvedValue({
      reading: { outcome: "read", items: [{ section: "does", text: "Take an order" }] },
      usage: [
        {
          projectId: project.id,
          buildId: null,
          runKind: "read",
          model: "claude-test",
          inputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 3,
          cacheCreationTokens: 4,
          costUsd: 0.03,
        },
      ],
    });

    const result = await read(cookie, project.id, file?.id);

    expect(result.data).toEqual({
      status: "read",
      fileId: file?.id,
      proposals: [{ section: "does", text: "Take an order" }],
      table: null,
    });
    const [[sent]] = reader.mock.calls;
    expect(sent.bytes.equals(JPEG)).toBe(true);
    expect(sent.file).toMatchObject({
      type: "jpeg",
      owner: "someone_else",
      displayName: "order form.jpg",
    });
    expect(sent.project.id).toBe(project.id);
    expect(await db.select().from(usage).where(eq(usage.projectId, project.id))).toEqual([
      expect.objectContaining({ runKind: "read", costUsd: 0.03, buildId: null }),
    ]);
    expect(await db.select().from(planItems).where(eq(planItems.projectId, project.id))).toEqual(
      []
    );
  });

  it.each([
    ["unreadable", "unreadable"],
    ["nothing_found", "nothing_found"],
  ] as const)("returns a %s picture as a stated reason, not an error", async (outcome, reason) => {
    const { cookie, project } = await anOwner();
    const { file } = await upload(cookie, project.id, PNG);
    reader.mockResolvedValue({ reading: { outcome, items: [] }, usage: [] });

    const result = await read(cookie, project.id, file?.id);

    expect(result.status).toBe(200);
    expect(result.data).toEqual({
      status: "failed",
      fileId: file?.id,
      reason,
      message: READ_FAILURES[reason],
    });
  });

  it("says so when the model cannot be reached, so the person can carry on", async () => {
    const { cookie, project } = await anOwner();
    const { file } = await upload(cookie, project.id, PDF);
    reader.mockRejectedValue(new ReadUnavailableError("The model run failed"));

    const result = await read(cookie, project.id, file?.id);

    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({ status: "failed", reason: "unavailable" });
    expect(result.data.message).toContain("carry on");
  });

  it("says a spreadsheet could not be opened, or held nothing, without the model", async () => {
    const { cookie, project } = await anOwner();
    const parts = [
      { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
      { name: "xl/workbook.xml", data: Buffer.from("<workbook/>") },
    ];
    const broken = await upload(cookie, project.id, zipOf(parts));
    const blank = await upload(cookie, project.id, xlsxOf([]));

    expect((await read(cookie, project.id, broken.file?.id)).data).toMatchObject({
      status: "failed",
      reason: "unreadable_file",
    });
    expect((await read(cookie, project.id, blank.file?.id)).data).toMatchObject({
      status: "failed",
      reason: "nothing_found",
    });
    expect(reader).not.toHaveBeenCalled();
  });

  it("answers NOT_FOUND for a file that is not in the project", async () => {
    const { cookie, tenantId, project } = await anOwner();
    const elsewhere = await aProject(tenantId);
    const { file } = await upload(cookie, elsewhere.id, PNG);

    expect((await read(cookie, project.id, file?.id)).code).toBe("NOT_FOUND");
    expect((await read(cookie, project.id, 2_000_000_000)).code).toBe("NOT_FOUND");
    expect(reader).not.toHaveBeenCalled();
  });
});
