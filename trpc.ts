import { useQueryClient } from "@tanstack/react-query";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import type { inferRouterOutputs } from "@trpc/server";

import type { AppRouter } from "./server/src/router.ts";

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();

type Outputs = inferRouterOutputs<AppRouter>;
export type Project = Outputs["projects"]["get"]["project"];
export type Build = NonNullable<Outputs["projects"]["get"]["latestBuild"]>;
export type BuildEvent = Outputs["builds"]["events"][number];
export type Usage = Outputs["projects"]["get"]["usage"];
export type ProjectStatus = Project["status"];

// How often a spec in progress, a running build, or its log is checked.
export const POLL_MS = 2000;

// Refetches every projects.* query after a change.
export const useRefreshProjects = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: trpc.projects.pathKey() });
};
