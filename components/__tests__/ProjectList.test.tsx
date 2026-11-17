import { screen } from "@testing-library/react";

import { copy } from "../../data/copy";
import { ProjectList } from "../ProjectList";
import { aProject, renderWithApi } from "./fakeApi";

describe("ProjectList", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("is the start page for someone with no apps yet", async () => {
    renderWithApi(<ProjectList />, { "projects.list": () => [] });

    expect(await screen.findByRole("heading", { level: 1, name: copy.start.title })).toBeVisible();
  });

  it("lists apps with a plain status, linking to each, and leads to a new one", async () => {
    renderWithApi(<ProjectList />, {
      "projects.list": () => [
        aProject({ id: 2, name: "Recipes", status: "live" }),
        aProject({ id: 1, name: "Invoices", status: "spec_ready" }),
      ],
    });

    expect(await screen.findByRole("link", { name: "Recipes" })).toHaveAttribute(
      "href",
      "/projects/2"
    );
    expect(screen.getByRole("link", { name: "Invoices" })).toHaveAttribute("href", "/projects/1");
    expect(screen.getByRole("link", { name: copy.list.newApp })).toHaveAttribute("href", "/new");
    expect(screen.getByText(copy.status.live.label)).toBeInTheDocument();
    expect(screen.getByText(copy.status.spec_ready.label)).toBeInTheDocument();
  });

  it("shows a canceled build apart from one that failed", async () => {
    renderWithApi(<ProjectList />, {
      "projects.list": () => [
        {
          ...aProject({ id: 2, name: "Recipes", status: "failed" }),
          latestBuildStatus: "canceled",
        },
        {
          ...aProject({ id: 1, name: "Invoices", status: "failed" }),
          latestBuildStatus: "failed",
        },
      ],
    });

    expect(await screen.findByText(copy.project.buildStatus.canceled)).toBeInTheDocument();
    expect(screen.getByText(copy.status.failed.label)).toBeInTheDocument();
    expect(
      screen.getByText(copy.project.buildStatus.canceled).closest("[data-status]")
    ).toHaveAttribute("data-status", "canceled");
  });
});
