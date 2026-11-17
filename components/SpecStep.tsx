import { useMutation } from "@tanstack/react-query";

import { copy } from "../data/copy";
import { useRefreshProjects, useTRPC, type Project } from "../trpc";
import { ErrorNote } from "./ErrorNote";
import { useSession } from "./SessionProvider";
import { Spec } from "./Spec";

import styles from "./Step.module.css";

type Props = { readonly project: Project; readonly onChangeFeatures: () => void };

// Setup step 2: the spec being written, then ready to read and approve.
export function SpecStep({ project, onChangeFeatures }: Props) {
  const trpc = useTRPC();
  const refresh = useRefreshProjects();
  const { session } = useSession();
  const approve = useMutation(
    trpc.projects.approveSpec.mutationOptions({ onSettled: () => refresh() })
  );

  return (
    <section aria-labelledby="spec" className={styles.step}>
      <h2 id="spec">{copy.project.specTitle}</h2>
      {project.status === "spec_generating" && <p>{copy.project.specWriting}</p>}
      {project.status === "spec_ready" && project.spec && (
        <>
          <p className={styles.muted}>{copy.project.specIntro}</p>
          <Spec source={project.spec} />
          {!session.canBuild && <p>{copy.project.buildsOff}</p>}
          <div className={styles.actions}>
            {session.canBuild && (
              <button
                type="button"
                data-variant="primary"
                onClick={() => approve.mutate({ id: project.id })}
                disabled={approve.isPending}
              >
                {approve.isPending ? copy.project.approving : copy.project.approve}
              </button>
            )}
            <button type="button" onClick={onChangeFeatures} disabled={approve.isPending}>
              {copy.project.changeFeatures}
            </button>
          </div>
          <ErrorNote error={approve.error} />
        </>
      )}
    </section>
  );
}
