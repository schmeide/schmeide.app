// Once per run: the `demo` business, which the migrations no longer leave, for tests that only need
// some business (`DEMO_TENANT_ID` in testAuth.ts).
import type { TestProject } from "vitest/node";
import { createDb } from "../db/client.ts";
import { ensureDemoTenant } from "../services/seed.ts";

declare module "vitest" {
  export interface ProvidedContext {
    readonly demoTenantId: number;
  }
}

export default async function setup(project: TestProject): Promise<void> {
  const db = createDb(process.env.DATABASE_URL ?? "");
  try {
    project.provide("demoTenantId", await ensureDemoTenant(db));
  } finally {
    await db.$client.end();
  }
}
