import { useState } from "react";

import { copy } from "../data/copy";
import type { Build, Project } from "../trpc";
import { BuildStep } from "./BuildStep";
import { ChangeForm } from "./ChangeForm";
import { DeleteProject } from "./DeleteProject";
import { FeaturesStep } from "./FeaturesStep";
import { SetupStepper } from "./SetupStepper";
import { SpecStep } from "./SpecStep";
import { StopButton } from "./StopButton";

import stepStyles from "./Step.module.css";
import styles from "./ProjectSetup.module.css";

type Props = {
  readonly project: Project;
  readonly latestBuild: Build | null;
  readonly specFailed: boolean;
  readonly request: string;
  readonly onRequestChange: (request: string) => void;
  readonly onStop: () => void;
};

// Setting an app up, until its first build passes: one step on screen at a time, in order.
export function ProjectSetup({
  project,
  latestBuild,
  specFailed,
  request,
  onRequestChange,
  onStop,
}: Props) {
  // Changing the requests of a ready spec goes back to the first step.
  const [editing, setEditing] = useState(false);
  const describing = project.status === "draft" || (project.status === "spec_ready" && editing);
  const building = project.status === "building" || project.status === "failed";

  return (
    <>
      <SetupStepper current={describing ? 0 : building ? 2 : 1} />
      {describing ? (
        <FeaturesStep project={project} onEditingChange={setEditing} specFailed={specFailed} />
      ) : building ? (
        latestBuild && (
          <BuildStep
            key={latestBuild.id}
            build={latestBuild}
            title={
              latestBuild.kind === "initial"
                ? copy.project.buildTitle
                : copy.project.retryBuildTitle
            }
          />
        )
      ) : (
        <SpecStep project={project} onChangeFeatures={() => setEditing(true)} />
      )}
      {project.status === "failed" && (
        <section aria-labelledby="retry" className={stepStyles.step}>
          <h2 id="retry">{copy.project.retryTitle}</h2>
          <ChangeForm project={project} request={request} onRequestChange={onRequestChange} />
        </section>
      )}
      <div className={styles.controls}>
        <StopButton project={project} onStop={onStop} />
        <DeleteProject project={project} />
      </div>
    </>
  );
}
