// The test apps of the feature evaluation (`make eval/features`, docs/feature-eval.md). Each file in
// apps/ is what an owner asked for and the acceptance checks a person wrote for it, agreed in the
// pull request that added them. A build of a test app is given these checks in place of the
// writer's, so every run of the same app is judged against the same checks.
import { readdirSync, readFileSync } from "node:fs";
import { z } from "zod";
import { planFrom, writtenSchema, type AcceptancePlan } from "../services/acceptance.ts";

const testAppSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  // The features as the owner typed them, one per line, as `projects.setFeatures` takes them.
  request: z.string().trim().min(1),
  checks: writtenSchema,
});

export type TestApp = z.infer<typeof testAppSchema> & { readonly id: string };

export const APPS_DIR = new URL("./apps/", import.meta.url);

// Every test app in `dir`, by file name; a file that is not a test app throws, naming it.
export const readApps = (dir: URL = APPS_DIR): readonly TestApp[] =>
  readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const parsed = testAppSchema.safeParse(JSON.parse(readFileSync(new URL(file, dir), "utf8")));
      if (!parsed.success) throw new Error(`${file}: ${z.prettifyError(parsed.error)}`);
      return { id: file.replace(/\.json$/, ""), ...parsed.data };
    });

// The checks as a build keeps them: numbered F1.1, F1.2, ... as the writer's would be. They come
// before any build, so they carry build 0.
export const planOf = (app: TestApp): AcceptancePlan => planFrom(app.checks, 0);
