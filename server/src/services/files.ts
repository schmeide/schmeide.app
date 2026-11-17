import { and, asc, count, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  FILE_NAME_MAX,
  ITEM_MAX,
  files,
  projects,
  tenants,
  type FileOwner,
  type FilePurpose,
  type FileRow,
  type FileType,
  type PlanSection,
} from "../db/schema.ts";
import { recordUsage } from "./builds.ts";
import {
  DamagedFileError,
  NotFoundError,
  ReadUnavailableError,
  UploadRefusedError,
} from "./errors.ts";
import type { FileReader } from "./fileReader.ts";
import type { FileStore } from "./fileStore.ts";
import { TYPE_LABEL, isPicture, sniffType } from "./fileTypes.ts";
import { findProject } from "./projects.ts";
import { csvTable, xlsxTable, type Table } from "./spreadsheet.ts";
import { stripMetadata } from "./stripMetadata.ts";

const MB = 1024 * 1024;
export const MAX_PICTURE_BYTES = 5 * MB;
export const MAX_UPLOAD_BYTES = 10 * MB;
export const MAX_FILES_PER_PROJECT = 50;
export const MAX_BYTES_PER_BUSINESS = 500 * MB;

export type UploadLimits = {
  readonly pictureBytes: number;
  readonly fileBytes: number;
  readonly filesPerProject: number;
  readonly bytesPerBusiness: number;
};

export const UPLOAD_LIMITS: UploadLimits = {
  pictureBytes: MAX_PICTURE_BYTES,
  fileBytes: MAX_UPLOAD_BYTES,
  filesPerProject: MAX_FILES_PER_PROJECT,
  bytesPerBusiness: MAX_BYTES_PER_BUSINESS,
};

export const REFUSAL_STATUS = {
  empty: 400,
  unsupported_type: 415,
  type_mismatch: 415,
  too_large: 413,
  damaged: 422,
  not_yours: 422,
  too_many_files: 409,
  business_full: 409,
} as const;
export type Refusal = keyof typeof REFUSAL_STATUS;

const megabytes = (bytes: number): string => `${Math.round((bytes / MB) * 10) / 10} MB`;

export const acceptedTypesMessage = (limits: UploadLimits = UPLOAD_LIMITS): string =>
  `Send a PNG, JPEG, or WebP picture of at most ${megabytes(limits.pictureBytes)}, or a PDF, CSV, or Excel (XLSX) file of at most ${megabytes(limits.fileBytes)}.`;

export const tooLargeMessage = (limits: UploadLimits = UPLOAD_LIMITS): string =>
  `This file is too large. ${acceptedTypesMessage(limits)}`;

const refuse: (code: Refusal, message: string) => never = (code, message) => {
  throw new UploadRefusedError(code, message);
};

export const cleanName = (name: string): string => {
  const base =
    name
      .normalize("NFC")
      .split(/[/\\]/)
      .at(-1)
      ?.replace(/[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu, "")
      .trim() ?? "";
  return [...base].slice(0, FILE_NAME_MAX).join("") || "file";
};

export type FileDeps = { readonly db: Db; readonly files: FileStore };

export type Upload = {
  readonly tenantId: number;
  readonly projectId: number;
  readonly uploadedBy: string;
  readonly name: string;
  readonly owner: FileOwner;
  readonly purpose: FilePurpose;
  readonly declared: FileType | "any";
  readonly bytes: Buffer;
};

const checked = (upload: Upload, limits: UploadLimits): { type: FileType; bytes: Buffer } => {
  if (upload.bytes.length === 0) refuse("empty", "This file is empty. Choose another one.");
  const type = sniffType(upload.bytes);
  if (!type) {
    return refuse(
      "unsupported_type",
      `This kind of file is not accepted. ${acceptedTypesMessage(limits)}`
    );
  }
  if (upload.declared !== "any" && upload.declared !== type) {
    refuse(
      "type_mismatch",
      `This file is named as ${TYPE_LABEL[upload.declared]}, but it holds ${TYPE_LABEL[type]}. Save it again in the format its name says, or rename it, then send it again.`
    );
  }
  const limit = isPicture(type) ? limits.pictureBytes : limits.fileBytes;
  if (upload.bytes.length > limit) refuse("too_large", tooLargeMessage(limits));
  if (upload.owner === "someone_else" && upload.purpose === "in_app") {
    refuse(
      "not_yours",
      "Something that belongs to someone else cannot go into your app. Send it for reference only, or send one that is yours."
    );
  }
  try {
    return { type, bytes: stripMetadata(type, upload.bytes) };
  } catch (error) {
    if (!(error instanceof DamagedFileError)) throw error;
    return refuse(
      "damaged",
      "We couldn't open this picture. Save it again or take a new one, then send it again."
    );
  }
};

export const uploadFile = async (
  { db, files: store }: FileDeps,
  upload: Upload,
  limits: UploadLimits = UPLOAD_LIMITS
): Promise<FileRow> => {
  const { type, bytes } = checked(upload, limits);
  const name = cleanName(upload.name);
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await tx.execute(
      sql`select 1 from ${tenants} where ${tenants.id} = ${upload.tenantId} for no key update`
    );
    const [{ held }] = await tx
      .select({ held: count() })
      .from(files)
      .where(eq(files.projectId, upload.projectId));
    if (held >= limits.filesPerProject) {
      refuse(
        "too_many_files",
        `This app already has ${limits.filesPerProject} files, which is the most it can hold. Remove one you no longer need, then send this one again.`
      );
    }
    const [{ stored }] = await tx
      .select({ stored: sql`coalesce(sum(${files.size}), 0)`.mapWith(Number) })
      .from(files)
      .innerJoin(projects, eq(projects.id, files.projectId))
      .where(eq(projects.tenantId, upload.tenantId));
    if (stored + bytes.length > limits.bytesPerBusiness) {
      refuse(
        "business_full",
        `Your business has used its ${megabytes(limits.bytesPerBusiness)} of space for files. Remove files you no longer need, then send this one again.`
      );
    }
    const [file] = await tx
      .insert(files)
      .values({
        projectId: upload.projectId,
        uploadedBy: upload.uploadedBy,
        owner: upload.owner,
        purpose: upload.purpose,
        type,
        size: bytes.length,
        originalName: name,
        displayName: name,
      })
      .returning();
    await store.put(
      { tenantId: upload.tenantId, projectId: upload.projectId, fileId: file.id },
      bytes
    );
    return file;
  });
};

export const listFiles = (db: Db, projectId: number): Promise<readonly FileRow[]> =>
  db.select().from(files).where(eq(files.projectId, projectId)).orderBy(asc(files.id));

const inProject = (input: { readonly id: number; readonly fileId: number }) =>
  and(eq(files.id, input.fileId), eq(files.projectId, input.id));

const missing = (fileId: number): NotFoundError => new NotFoundError(`File ${fileId} not found`);

export const renameFile = async (
  db: Db,
  input: { readonly id: number; readonly fileId: number; readonly displayName: string }
): Promise<FileRow> => {
  const [file] = await db
    .update(files)
    .set({ displayName: cleanName(input.displayName) })
    .where(inProject(input))
    .returning();
  if (!file) throw missing(input.fileId);
  return file;
};

export const deleteFile = async (
  { db, files: store }: FileDeps,
  input: { readonly id: number; readonly fileId: number }
): Promise<FileRow> => {
  const { tenantId } = await findProject(db, input.id);
  const [file] = await db.delete(files).where(inProject(input)).returning();
  if (!file) throw missing(input.fileId);
  await store.remove({ tenantId, projectId: input.id, fileId: file.id });
  return file;
};

export type Proposal = { readonly section: PlanSection; readonly text: string };

export const READ_FAILURES = {
  unreadable: "We couldn't read this picture. Try a closer or sharper one.",
  unreadable_file: "We couldn't open this file. Save it again, then send it again.",
  nothing_found:
    "We didn't find anything in this to add to your plan. You can carry on without it.",
  unavailable: "We couldn't read this just now. Try again in a moment, or carry on without it.",
} as const;
export type ReadFailure = keyof typeof READ_FAILURES;

export type ReadResult =
  | {
      readonly status: "read";
      readonly fileId: number;
      readonly proposals: readonly Proposal[];
      readonly table: Table | null;
    }
  | {
      readonly status: "failed";
      readonly fileId: number;
      readonly reason: ReadFailure;
      readonly message: string;
    };

const failed = (fileId: number, reason: ReadFailure): ReadResult => ({
  status: "failed",
  fileId,
  reason,
  message: READ_FAILURES[reason],
});

const readTable = async (file: FileRow, bytes: Buffer): Promise<ReadResult> => {
  try {
    const table = file.type === "csv" ? csvTable(bytes) : await xlsxTable(bytes);
    if (table.columns.length === 0) return failed(file.id, "nothing_found");
    return {
      status: "read",
      fileId: file.id,
      proposals: table.columns.map((name) => ({
        section: "keeps",
        text: [...name].slice(0, ITEM_MAX).join(""),
      })),
      table,
    };
  } catch (error) {
    if (error instanceof DamagedFileError) return failed(file.id, "unreadable_file");
    throw error;
  }
};

export const readFileIntoProposals = async (
  { db, files: store, reader }: FileDeps & { readonly reader: FileReader },
  input: { readonly id: number; readonly fileId: number }
): Promise<ReadResult> => {
  const project = await findProject(db, input.id);
  const [file] = await db.select().from(files).where(inProject(input));
  if (!file) throw missing(input.fileId);
  const bytes = await store.get({
    tenantId: project.tenantId,
    projectId: project.id,
    fileId: file.id,
  });
  if (file.type === "csv" || file.type === "xlsx") return readTable(file, bytes);
  try {
    const { reading, usage } = await reader({ project, file, bytes });
    await recordUsage(db, usage);
    if (reading.outcome === "unreadable")
      return failed(file.id, isPicture(file.type) ? "unreadable" : "unreadable_file");
    if (reading.outcome !== "read") return failed(file.id, reading.outcome);
    return { status: "read", fileId: file.id, proposals: reading.items, table: null };
  } catch (error) {
    if (error instanceof ReadUnavailableError) return failed(file.id, "unavailable");
    throw error;
  }
};
