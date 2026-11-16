import { screen } from "@testing-library/react";

import { App } from "../../App";
import { copy } from "../../data/copy";
import { anInterview, aProject, ApiFailure, demoOwner, renderWithApi } from "./fakeApi";

const unreachable = {
  "session.get": () => {
    throw new ApiFailure(undefined);
  },
};

describe("App", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("shows the coming-soon hero on the public site, where there is no API", async () => {
    renderWithApi(<App isPublicSite />, unreachable, "server");
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(copy.hero.headline);
    expect(screen.getByText(copy.hero.tagline)).toBeInTheDocument();
    expect(screen.queryByText(copy.errors.serverDownTitle)).not.toBeInTheDocument();
  });

  it("tells a developer how to start the server when it is down", async () => {
    renderWithApi(<App isPublicSite={false} />, unreachable, "server");
    expect(await screen.findByText(copy.errors.serverDownTitle)).toBeInTheDocument();
    expect(screen.getByText(copy.errors.serverDown)).toHaveTextContent("make serve");
  });

  it("sends a signed-out visitor to sign in once the API answers", async () => {
    renderWithApi(
      <App isPublicSite />,
      { "session.get": () => ({ person: null, businesses: [], providers: [] }) },
      "server"
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: copy.routes.signIn })
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe("/sign-in");
  });

  it("shows the project tool when the API answers, and opens a project from its address", async () => {
    window.history.replaceState(null, "", "/projects/7");
    renderWithApi(
      <App isPublicSite />,
      {
        "session.get": () => ({ ...demoOwner, providers: [] }),
        "projects.list": () => [aProject()],
        "interview.get": () => anInterview(),
        "projects.get": () => ({
          project: aProject(),
          latestBuild: null,
          queued: [],
          hasIcon: false,
          hasBeenLive: false,
          usage: {},
        }),
      },
      "server"
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Invoices" })).toBeInTheDocument();
  });
});
