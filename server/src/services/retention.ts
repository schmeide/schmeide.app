// How long each kind of record is kept (#275), and the sweep that deletes what is past it. The
// periods are a starting point until a lawyer has read them; docs/mvp.md lists them for people.
// A deleted project's records go with it at once (removeProjectFiles, deleteProjectRows).
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { lt } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  adminActions,
  builds,
  projects,
  sessions,
  usage,
  verifications,
  websiteReads,
} from "../db/schema.ts";
import { copyOf } from "./resources.ts";
import { claudeDir, removePath, transcriptsDir } from "./projects.ts";

export const RETENTION = [
  // Every raw agent message, request and upload text of a live project's build, by its last write.
  { kind: "build_logs", days: 90 },
  { kind: "agent_sessions", days: 90 },
  // The hourly read limit only needs the last hour (services/website.ts).
  { kind: "website_reads", days: 1 },
  // Sign-in sessions and provider sign-ins in progress, counted from when they expired.
  { kind: "sign_ins", days: 30 },
  // Billing and the admin audit log: as long as the company's home country requires (HGB/AO).
  { kind: "usage", days: 3650 },
  { kind: "audit_log", days: 3650 },
] as const;

export type RetentionKind = (typeof RETENTION)[number]["kind"];

// The audit log's admin label for the sweep's own row of counts.
export const RETENTION_LABEL = "retention";

const DAY = 86_400_000;

// Removes each entry of `dir` that `goes`, given its name and last write; a missing dir has none.
const pruneEntries = async (
  dir: string,
  goes: (name: string, written: Date) => boolean
): Promise<number> => {
  const names = await readdir(dir).catch(() => [] as string[]);
  const doomed = await Promise.all(
    names.map(async (name) => {
      const path = join(dir, name);
      return goes(name, (await stat(path)).mtime) ? path : undefined;
    })
  );
  const paths = doomed.filter((path) => path !== undefined);
  await Promise.all(paths.map(removePath));
  return paths.length;
};

// Deletes everything past its period and records how many of each kind it removed in the audit log.
export const sweepExpired = async (
  db: Db,
  dataDir: string,
  now: Date = new Date(),
  claude: string = claudeDir()
): Promise<Record<RetentionKind, number>> => {
  const cutoff = (kind: RetentionKind) =>
    new Date(now.getTime() - (RETENTION.find((entry) => entry.kind === kind)?.days ?? 0) * DAY);
  const rows = async (query: Promise<readonly unknown[]>) => (await query).length;

  // What a deleted project or build left on disk goes too, however new: its rows are gone.
  // ponytail: every id and slug in memory; page through them if the tables outgrow that.
  const buildIds = new Set(
    (await db.select({ id: builds.id }).from(builds)).map((build) => String(build.id))
  );
  const slugs = new Set(
    (await db.select({ slug: projects.slug }).from(projects)).map((p) => p.slug)
  );
  const buildFile = (name: string, written: Date) => {
    const id = /^build-(\d+)(\.log)?$/.exec(name)?.[1];
    return id !== undefined && (!buildIds.has(id) || written < cutoff("build_logs"));
  };
  // Claude Code names a run's transcripts folder after its working dir (transcriptsDir): the
  // builder's are the staging copies, and a slug is only letters, digits and dashes.
  const transcriptsRoot = join(claude, "projects");
  const stagingPrefix = basename(
    transcriptsDir(claude, dirname(copyOf(dataDir, "slug", "staging").dir))
  );
  const removed: Record<RetentionKind, number> = {
    build_logs:
      (await pruneEntries(join(dataDir, "logs"), buildFile)) +
      (await pruneEntries(join(dataDir, "attachments"), buildFile)),
    agent_sessions:
      (await pruneEntries(
        transcriptsRoot,
        (name) =>
          name.startsWith(`${stagingPrefix}-`) && !slugs.has(name.slice(stagingPrefix.length + 1))
      )) +
      (
        await Promise.all(
          [...slugs].map((slug) =>
            pruneEntries(
              transcriptsDir(claude, copyOf(dataDir, slug, "staging").dir),
              (_name, written) => written < cutoff("agent_sessions")
            )
          )
        )
      ).reduce((sum, count) => sum + count, 0),
    website_reads: await rows(
      db
        .delete(websiteReads)
        .where(lt(websiteReads.at, cutoff("website_reads")))
        .returning({ id: websiteReads.id })
    ),
    sign_ins:
      (await rows(
        db
          .delete(sessions)
          .where(lt(sessions.expiresAt, cutoff("sign_ins")))
          .returning({ id: sessions.id })
      )) +
      (await rows(
        db
          .delete(verifications)
          .where(lt(verifications.expiresAt, cutoff("sign_ins")))
          .returning({ id: verifications.id })
      )),
    usage: await rows(
      db
        .delete(usage)
        .where(lt(usage.at, cutoff("usage")))
        .returning({ id: usage.id })
    ),
    audit_log: await rows(
      db
        .delete(adminActions)
        .where(lt(adminActions.createdAt, cutoff("audit_log")))
        .returning({ id: adminActions.id })
    ),
  };
  await db.insert(adminActions).values({
    adminLabel: RETENTION_LABEL,
    action: "retention sweep",
    detail: JSON.stringify(removed),
  });
  return removed;
};
