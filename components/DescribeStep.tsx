import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { copy } from "../data/copy";
import { useTRPC, type Project } from "../trpc";
import { FeaturesStep } from "./FeaturesStep";
import { InterviewStep } from "./InterviewStep";

type Props = {
  readonly project: Project;
  readonly editing: boolean;
  readonly onEditingChange: (editing: boolean) => void;
  readonly specFailed: Project["specError"];
};

// The two ways to describe an app: answer questions that build a plan, or type the requests.
// A project that already has typed requests and no plan stays with its requests.
export function DescribeStep(props: Props) {
  const { project, onEditingChange, specFailed } = props;
  const trpc = useTRPC();
  const interview = useQuery(trpc.interview.get.queryOptions({ id: project.id }));
  const [chosen, setChosen] = useState<"interview" | "write" | null>(null);
  if (interview.isPending) return <p>{copy.loading}</p>;

  const data = interview.data;
  const hasPlan = data !== undefined && (data.items.length > 0 || data.questions.length > 0);
  const started = hasPlan || Boolean(data?.current);
  const typed = project.features.trim() !== "" || project.status !== "draft";
  const mode = chosen ?? (started || !typed ? "interview" : "write");
  // Without the interview (it could not be loaded), typing the requests still works.
  if (!data || mode === "write") {
    return (
      <FeaturesStep
        project={project}
        onEditingChange={onEditingChange}
        specFailed={specFailed}
        onUseInterview={data ? () => setChosen("interview") : undefined}
      />
    );
  }
  return <InterviewStep {...props} interview={data} onWriteMyself={() => setChosen("write")} />;
}
