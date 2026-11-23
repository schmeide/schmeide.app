// What the owner sees of the acceptance checks (#357): the checks a spec will be held to, before it
// is approved, and which features work in each version, from what the tester found. The checks
// are written and followed in temporal/activities.ts; services/acceptance.ts shapes them.
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { buildAcceptance, builds, projectAcceptance } from "../db/schema.ts";
import {
  featureResults,
  plannedFeatures,
  specHash,
  type AcceptancePlan,
  type FeatureResult,
  type PlannedFeature,
} from "./acceptance.ts";
import { getBuild } from "./builds.ts";
import { findProject } from "./projects.ts";

const planOf = async (db: Db, projectId: number) =>
  (await db.select().from(projectAcceptance).where(eq(projectAcceptance.projectId, projectId)))[0];

// The checks of the project's spec, each under its feature. None when there are none, or when
// they were written from another spec, such as the one before the spec was written again.
export const plannedChecks = async (
  db: Db,
  projectId: number
): Promise<readonly PlannedFeature[]> => {
  const project = await findProject(db, projectId);
  const kept = await planOf(db, projectId);
  if (!kept || project.spec === null || kept.specHash !== specHash(project.spec)) return [];
  return plannedFeatures(kept.plan);
};

const resultsOf = async (
  db: Db,
  plan: AcceptancePlan | undefined,
  buildId: number
): Promise<readonly FeatureResult[]> =>
  featureResults(
    plan,
    await db.select().from(buildAcceptance).where(eq(buildAcceptance.buildId, buildId))
  );

// Which features work in a build's version, from the last time the tester followed its checks.
// Empty for a build the tester never followed.
export const buildResults = async (db: Db, buildId: number): Promise<readonly FeatureResult[]> => {
  const build = await getBuild(db, buildId);
  return resultsOf(db, (await planOf(db, build.projectId))?.plan, buildId);
};

// Which features work in the version being worked on: the newest passed build whose commit
// staging runs and that the tester followed. `buildId` is null when there is none, such as after
// a build that skips the tester (a site build) or for an app from before there was a tester.
export const stagingResults = async (
  db: Db,
  projectId: number
): Promise<{ readonly buildId: number | null; readonly features: readonly FeatureResult[] }> => {
  const project = await findProject(db, projectId);
  const none = { buildId: null, features: [] };
  if (project.stagingCommit === null) return none;
  const [tested] = await db
    .selectDistinct({ id: builds.id })
    .from(builds)
    .innerJoin(buildAcceptance, eq(buildAcceptance.buildId, builds.id))
    .where(
      and(
        eq(builds.projectId, projectId),
        eq(builds.commit, project.stagingCommit),
        eq(builds.status, "passed")
      )
    )
    .orderBy(desc(builds.id))
    .limit(1);
  if (!tested) return none;
  return {
    buildId: tested.id,
    features: await resultsOf(db, (await planOf(db, projectId))?.plan, tested.id),
  };
};
