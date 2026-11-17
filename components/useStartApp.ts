import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useRefreshProjects, useTRPC } from "../trpc";
import { navigate } from "../utils/navigation";
import { pathTo } from "../utils/routes";

export const useStartApp = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const refresh = useRefreshProjects();
  const create = useMutation(trpc.projects.create.mutationOptions());
  const first = useMutation(trpc.interview.start.mutationOptions());

  const start = (input: Parameters<typeof create.mutate>[0]) =>
    create.mutate(input, {
      onSuccess: (project) =>
        first.mutate(
          { id: project.id },
          {
            onSuccess: (interview) =>
              queryClient.setQueryData(trpc.interview.get.queryKey({ id: project.id }), interview),
            onSettled: () => {
              void refresh();
              navigate(pathTo("project", { id: project.id }));
            },
          }
        ),
    });

  return { start, busy: create.isPending || first.isPending, error: create.error };
};
