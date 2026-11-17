import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

import { copy } from "../../data/copy";
import type { Project } from "../../trpc";
import { ChangeForm } from "../ChangeForm";
import { aBuild, aProject, renderWithApi } from "./fakeApi";

function Harness({
  project = aProject({ status: "live" }),
  note,
}: {
  readonly project?: Project;
  readonly note?: string;
}) {
  const [request, setRequest] = useState("");
  return (
    <ChangeForm project={project} request={request} onRequestChange={setRequest} note={note} />
  );
}

const field = () => screen.getByLabelText(copy.project.changeLabel);
const submit = () => screen.getByRole("button", { name: copy.project.requestChange });

describe("ChangeForm", () => {
  it("stays enabled when the change is empty, then points at the field and sends nothing", async () => {
    const calls = renderWithApi(<Harness />, {
      "projects.requestChange": () => ({ project: aProject(), build: aBuild() }),
    });

    expect(submit()).toBeEnabled();
    await userEvent.click(submit());

    expect(field()).toBeInvalid();
    expect(field()).toHaveAccessibleDescription(copy.project.changeMissing);
    expect(field()).toHaveFocus();
    expect(
      field().compareDocumentPosition(screen.getByText(copy.project.changeMissing)) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it("treats a blank change as empty", async () => {
    const calls = renderWithApi(<Harness />, {
      "projects.requestChange": () => ({ project: aProject(), build: aBuild() }),
    });

    await userEvent.type(field(), "   ");
    await userEvent.click(submit());

    expect(field()).toHaveAccessibleDescription(copy.project.changeMissing);
    expect(calls).toEqual([]);
  });

  it("drops the error once the change is written, and keeps a note on the field", async () => {
    renderWithApi(<Harness note={copy.project.designer.buildsToStaging} />, {
      "projects.requestChange": () => ({ project: aProject(), build: aBuild() }),
    });

    await userEvent.click(submit());
    expect(field()).toHaveAccessibleDescription(
      `${copy.project.changeMissing} ${copy.project.designer.buildsToStaging}`
    );

    await userEvent.type(field(), "Add a logo");
    expect(field()).not.toBeInvalid();
    expect(field()).toHaveAccessibleDescription(copy.project.designer.buildsToStaging);
    expect(screen.queryByText(copy.project.changeMissing)).toBeNull();
  });

  it("sends the change and disables the button while that request is in flight", async () => {
    let release: (value: unknown) => void = () => {};
    const calls = renderWithApi(<Harness />, {
      "projects.requestChange": () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });

    await userEvent.type(field(), "Add a logo");
    await userEvent.click(submit());

    expect(await screen.findByRole("button", { name: copy.project.requesting })).toBeDisabled();
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "projects.requestChange",
        input: { id: 7, request: "Add a logo" },
      })
    );
    release({ project: aProject(), build: aBuild() });
  });
});
