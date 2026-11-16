import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { copy } from "../../data/copy";
import { ProjectList } from "../ProjectList";
import { aProject, renderWithApi } from "./fakeApi";

describe("ProjectList", () => {
  beforeEach(() => {
    window.location.hash = "";
  });

  it("explains what to do first when there are no projects", async () => {
    renderWithApi(<ProjectList />, { "projects.list": () => [] });
    expect(await screen.findByText(copy.list.empty)).toBeInTheDocument();
    expect(screen.getByText(copy.list.intro)).toBeInTheDocument();
  });

  it("lists projects with a plain status, linking to each", async () => {
    renderWithApi(<ProjectList />, {
      "projects.list": () => [
        aProject({ id: 2, name: "Recipes", status: "live" }),
        aProject({ id: 1, name: "Invoices", status: "spec_ready" }),
      ],
    });
    const links = await screen.findAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "#/projects/2",
      "#/projects/1",
    ]);
    expect(screen.getByText(copy.status.live.label)).toBeInTheDocument();
    expect(screen.getByText(copy.status.spec_ready.label)).toBeInTheDocument();
  });

  it("creates a project and opens it", async () => {
    const calls = renderWithApi(<ProjectList />, {
      "projects.list": () => [],
      "projects.create": (input) => aProject({ id: 12, name: String(input.name) }),
    });
    await userEvent.type(await screen.findByLabelText(copy.list.nameLabel), "Invoices");
    await userEvent.click(screen.getByRole("button", { name: copy.list.create }));
    expect(calls).toContainEqual({ path: "projects.create", input: { name: "Invoices" } });
    await waitFor(() => expect(window.location.hash).toBe("#/projects/12"));
  });
});
