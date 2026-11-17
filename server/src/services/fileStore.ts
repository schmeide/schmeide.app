import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type ProjectKey = { readonly tenantId: number; readonly projectId: number };
export type FileKey = ProjectKey & { readonly fileId: number };

export type FileStore = {
  readonly put: (key: FileKey, bytes: Buffer) => Promise<void>;
  readonly get: (key: FileKey) => Promise<Buffer>;
  readonly remove: (key: FileKey) => Promise<void>;
  readonly removeProject: (key: ProjectKey) => Promise<void>;
};

export const createLocalFileStore = (dataDir: string): FileStore => {
  const projectDir = ({ tenantId, projectId }: ProjectKey) =>
    join(dataDir, "files", String(Math.trunc(tenantId)), String(Math.trunc(projectId)));
  const pathOf = (key: FileKey) => join(projectDir(key), String(Math.trunc(key.fileId)));
  return {
    put: async (key, bytes) => {
      await mkdir(projectDir(key), { recursive: true, mode: 0o700 });
      const staging = `${pathOf(key)}.${randomUUID()}.part`;
      try {
        await writeFile(staging, bytes, { mode: 0o600 });
        await rename(staging, pathOf(key));
      } finally {
        await rm(staging, { force: true });
      }
    },
    get: (key) => readFile(pathOf(key)),
    remove: (key) => rm(pathOf(key), { force: true }),
    removeProject: (key) => rm(projectDir(key), { recursive: true, force: true }),
  };
};
