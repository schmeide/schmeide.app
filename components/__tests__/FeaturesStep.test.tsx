import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { copy } from "../../data/copy";
import { FeaturesStep } from "../FeaturesStep";
import { aProject, renderWithApi } from "./fakeApi";

const handlers = {
  "projects.setFeatures": (input: { readonly features?: unknown }) =>
    aProject({ features: String(input.features) }),
  "projects.generateSpec": () => aProject({ status: "spec_generating" as const }),
};

const first = () => screen.getByLabelText(copy.project.requestLabel(1));
const writeSpec = () => screen.getByRole("button", { name: copy.project.writeSpec });
const save = () => screen.getByRole("button", { name: copy.project.saveFeatures });

describe("FeaturesStep", () => {
  it("keeps Save disabled when nothing changed, and points at the first request when none is written", async () => {
    const calls = renderWithApi(
      <FeaturesStep project={aProject()} onEditingChange={() => {}} specFailed={null} />,
      handlers
    );

    expect(save()).toBeDisabled();
    expect(writeSpec()).toBeEnabled();
    await userEvent.click(writeSpec());

    expect(first()).toBeInvalid();
    expect(first()).toHaveAccessibleDescription(copy.project.needFeatures);
    expect(first()).toHaveFocus();
    const error = screen.getByText(copy.project.needFeatures);
    expect(first().compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      error.compareDocumentPosition(writeSpec()) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(calls).toEqual([]);
    expect(save()).toBeDisabled();
  });

  it("treats blank requests as none, then drops the error once one is written", async () => {
    renderWithApi(
      <FeaturesStep project={aProject()} onEditingChange={() => {}} specFailed={null} />,
      handlers
    );

    await userEvent.type(first(), "   ");
    await userEvent.click(writeSpec());
    expect(first()).toHaveAccessibleDescription(copy.project.needFeatures);

    await userEvent.type(first(), "Clients");
    expect(first()).not.toBeInvalid();
    expect(screen.queryByText(copy.project.needFeatures)).toBeNull();
    expect(save()).toBeEnabled();
  });

  it("keeps Save disabled while the saved requests are unchanged", () => {
    renderWithApi(
      <FeaturesStep
        project={aProject({ features: "Clients" })}
        onEditingChange={() => {}}
        specFailed={null}
      />,
      handlers
    );

    expect(save()).toBeDisabled();
    expect(first()).toHaveValue("Clients");
  });

  it("disables Write the spec while that request is in flight", async () => {
    let release: (value: unknown) => void = () => {};
    const calls = renderWithApi(
      <FeaturesStep project={aProject()} onEditingChange={() => {}} specFailed={null} />,
      {
        "projects.setFeatures": (input) => aProject({ features: String(input.features) }),
        "projects.generateSpec": () =>
          new Promise((resolve) => {
            release = () => resolve(aProject({ status: "spec_generating" }));
          }),
      }
    );

    await userEvent.type(first(), "Clients");
    await userEvent.click(writeSpec());

    const starting = await screen.findByRole("button", { name: copy.project.startingSpec });
    expect(starting).toBeDisabled();
    expect(within(starting).getByTestId("working")).toHaveAttribute("aria-hidden", "true");
    await waitFor(() =>
      expect(calls.map((call) => call.path)).toEqual([
        "projects.setFeatures",
        "projects.generateSpec",
      ])
    );
    release(undefined);
  });
});
