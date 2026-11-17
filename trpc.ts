import { useQueryClient } from "@tanstack/react-query";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import type { inferRouterOutputs } from "@trpc/server";

import type { AppRouter } from "./server/src/router.ts";

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();

type Outputs = inferRouterOutputs<AppRouter>;
export type Project = Outputs["projects"]["get"]["project"];
export type Build = NonNullable<Outputs["projects"]["get"]["latestBuild"]>;
export type BuildEvent = Outputs["builds"]["events"][number];
export type BuildSummary = Outputs["builds"]["summaries"][number];
export type BuiltChange = Outputs["projects"]["get"]["changes"][number];
export type Usage = Outputs["projects"]["get"]["usage"];
export type TimeTotals = Outputs["projects"]["get"]["time"];
export type ProjectStatus = Project["status"];
export type Interview = Outputs["interview"]["get"];
export type PlanItem = Interview["items"][number];
export type Question = Interview["questions"][number];
export type Answer = NonNullable<Question["answer"]>;
export type AuditEntry = Outputs["admin"]["audit"]["list"]["entries"][number];
export type BusinessEntry = Outputs["admin"]["businesses"]["list"]["entries"][number];
export type BusinessPage = Outputs["admin"]["businesses"]["get"];
export type PersonEntry = Outputs["admin"]["people"]["list"]["entries"][number];
export type HostedProject = Outputs["admin"]["projects"]["list"]["entries"][number];
export type ProjectResources = Outputs["admin"]["projects"]["resources"][number];
export type UsageSummaryData = Outputs["admin"]["usage"]["summary"];

// How often a spec in progress, a running build, or its log is checked.
export const POLL_MS = 2000;

// Refetches every projects.* query after a change.
export const useRefreshProjects = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: trpc.projects.pathKey() });
};
