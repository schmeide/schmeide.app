import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { copy } from "../../data/copy";
import { QueuedChanges } from "../QueuedChanges";
import { aBuild, renderWithApi } from "./fakeApi";

const queuedChange = aBuild({
  id: 4,
  kind: "change",
  status: "queued",
  request: "Sort by dat",
});

const field = () => screen.getByLabelText(copy.project.queueEditFieldLabel(1));
const save = () => screen.getByRole("button", { name: copy.project.queueSave });

describe("QueuedChanges", () => {
  it("stays enabled when the edit is empty, then points at the field and sends nothing", async () => {
    const calls = renderWithApi(<QueuedChanges queued={[queuedChange]} />, {
      "builds.editQueued": (input) => aBuild({ request: String(input.request) }),
    });

    await userEvent.click(
      await screen.findByRole("button", { name: copy.project.queueEditLabel(1) })
    );
    await userEvent.clear(field());
    expect(save()).toBeEnabled();
    await userEvent.click(save());

    expect(field()).toBeInvalid();
    expect(field()).toHaveAccessibleDescription(copy.project.queueMissing);
    expect(field()).toHaveFocus();
    expect(
      field().compareDocumentPosition(screen.getByText(copy.project.queueMissing)) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it("treats a blank edit as empty", async () => {
    const calls = renderWithApi(<QueuedChanges queued={[queuedChange]} />, {
      "builds.editQueued": () => aBuild(),
    });

    await userEvent.click(
      await screen.findByRole("button", { name: copy.project.queueEditLabel(1) })
    );
    await userEvent.clear(field());
    await userEvent.type(field(), "   ");
    await userEvent.click(save());

    expect(field()).toHaveAccessibleDescription(copy.project.queueMissing);
    expect(calls).toEqual([]);
  });

  it("saves a written edit and disables the button while that request is in flight", async () => {
    let release: (value: unknown) => void = () => {};
    const calls = renderWithApi(<QueuedChanges queued={[queuedChange]} />, {
      "builds.editQueued": (input) =>
        new Promise((resolve) => {
          release = () => resolve(aBuild({ request: String(input.request) }));
        }),
    });

    await userEvent.click(
      await screen.findByRole("button", { name: copy.project.queueEditLabel(1) })
    );
    await userEvent.clear(field());
    await userEvent.type(field(), "Sort by date");
    await userEvent.click(save());

    expect(await screen.findByRole("button", { name: copy.project.saving })).toBeDisabled();
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "builds.editQueued",
        input: { buildId: 4, request: "Sort by date" },
      })
    );
    release(undefined);
  });
});
