import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { copy } from "../../data/copy";
import { SiteStep } from "../SiteStep";
import { aProject, renderWithApi } from "./fakeApi";

const icon = () => screen.getByLabelText(copy.project.site.iconLabel);
const huge = new File([new Uint8Array(256 * 1024 + 1)], "huge.png", { type: "image/png" });
const small = new File([new Uint8Array([0x89, 0x50])], "icon.png", { type: "image/png" });

describe("SiteStep", () => {
  it("points at the icon field when the file is too big, and still lets the title be saved", async () => {
    const calls = renderWithApi(
      <SiteStep project={aProject({ status: "live", name: "Invoices" })} hasIcon={false} />,
      { "projects.setSite": () => aProject() }
    );

    expect(screen.getByRole("button", { name: copy.project.site.save })).toBeEnabled();
    await userEvent.upload(icon(), huge);

    expect(icon()).toBeInvalid();
    expect(icon()).toHaveAccessibleDescription(copy.project.site.iconTooBig);
    expect(icon()).toHaveFocus();
    const error = screen.getByText(copy.project.site.iconTooBig);
    const status = screen.getByText(copy.project.site.iconNone);
    expect(icon().compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(error.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: copy.project.site.save }));
    await waitFor(() =>
      expect(calls).toContainEqual({ path: "projects.setSite", input: { id: 7, title: "" } })
    );
  });

  it("drops the icon error once a small enough file is chosen", async () => {
    renderWithApi(<SiteStep project={aProject({ status: "live" })} hasIcon={false} />, {
      "projects.setSite": () => aProject(),
    });

    await userEvent.upload(icon(), huge);
    await userEvent.upload(icon(), small);

    expect(icon()).not.toBeInvalid();
    expect(screen.queryByText(copy.project.site.iconTooBig)).toBeNull();
  });

  it("disables Save while that request is in flight", async () => {
    let release: (value: unknown) => void = () => {};
    renderWithApi(<SiteStep project={aProject({ status: "live" })} hasIcon={false} />, {
      "projects.setSite": () =>
        new Promise((resolve) => {
          release = () => resolve(aProject());
        }),
    });

    await userEvent.click(screen.getByRole("button", { name: copy.project.site.save }));
    expect(await screen.findByRole("button", { name: copy.project.saving })).toBeDisabled();
    release(undefined);
  });
});
