import { screen } from "@testing-library/react";

import { App } from "../../App";
import { copy } from "../../data/copy";
import { aProject, ApiFailure, renderWithApi } from "./fakeApi";

const unreachable = {
  "projects.list": () => {
    throw new ApiFailure(undefined);
  },
};

describe("App", () => {
  beforeEach(() => {
    window.location.hash = "";
  });

  it("shows the coming-soon hero on the public site, where there is no API", async () => {
    renderWithApi(<App isPublicSite />, unreachable);
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(copy.hero.headline);
    expect(screen.getByText(copy.hero.tagline)).toBeInTheDocument();
    expect(screen.queryByText(copy.errors.serverDownTitle)).not.toBeInTheDocument();
  });

  it("tells a developer how to start the server when it is down", async () => {
    renderWithApi(<App isPublicSite={false} />, unreachable);
    expect(await screen.findByText(copy.errors.serverDownTitle)).toBeInTheDocument();
    expect(screen.getByText(copy.errors.serverDown)).toHaveTextContent("make serve");
  });

  it("shows the project tool when the API answers, and opens a project from the hash", async () => {
    window.location.hash = "#/projects/7";
    renderWithApi(<App isPublicSite />, {
      "projects.list": () => [aProject()],
      "projects.get": () => ({ project: aProject(), latestBuild: null, usage: {} }),
    });
    expect(await screen.findByRole("heading", { level: 1, name: "Invoices" })).toBeInTheDocument();
  });
});
