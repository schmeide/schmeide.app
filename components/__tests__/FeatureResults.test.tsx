import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { copy } from "../../data/copy";
import { ProjectPage } from "../ProjectPage";
import { Routes } from "../Routes";
import {
  aBuild,
  aCheckResult,
  aFeatureResult,
  aProject,
  projectServer,
  renderWithApi,
} from "./fakeApi";

const SPEC = "## Features\n- Show a profile's photos\n- Send a message\n\n## Screens\n- Profile";

const check = (id: string, expect: string) => ({
  id,
  given: "A profile with three photos.",
  steps: ["Open the profile.", "Tap Next photo."],
  expect,
});

describe("the spec, before it is approved", () => {
  const spec = aProject({ status: "spec_ready", features: "a", spec: SPEC });

  it("shows how we will know each feature works, under that feature", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({
        project: spec,
        checks: [
          { number: 1, name: "Photos", checks: [check("F1.1", "The second photo shows.")] },
          { number: 2, name: "Messages", checks: [check("F2.1", "The message is in the thread.")] },
        ],
      })
    );

    expect(await screen.findByText(copy.project.specChecks.intro)).toBeVisible();
    const photos = screen.getByText("Show a profile's photos").closest("li");
    const messages = screen.getByText("Send a message").closest("li");
    if (!photos || !messages) throw new Error("the features are not a list");
    await userEvent.click(within(photos).getByText(copy.project.specChecks.title));
    expect(within(photos).getByText("The second photo shows.")).toBeVisible();
    expect(within(photos).getByText("Tap Next photo.")).toBeVisible();
    expect(within(photos).queryByText("The message is in the thread.")).toBeNull();
    expect(within(messages).getByText("The message is in the thread.")).toBeInTheDocument();
  });

  it("lists the checks after the spec when they do not match its features one for one", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({
        project: spec,
        checks: [{ number: 1, name: "Photos", checks: [check("F1.1", "The second photo shows.")] }],
      })
    );

    expect(
      await screen.findByRole("heading", { name: copy.project.specChecks.listTitle })
    ).toBeVisible();
    expect(screen.getByText("Photos")).toBeVisible();
  });

  it("shows the spec alone when no checks were written", async () => {
    renderWithApi(<ProjectPage id={7} />, projectServer({ project: spec }));

    expect(await screen.findByText("Show a profile's photos")).toBeVisible();
    expect(screen.queryByText(copy.project.specChecks.intro)).toBeNull();
    expect(screen.queryByText(copy.project.specChecks.title)).toBeNull();
  });
});

describe("which features work in the version being worked on", () => {
  const app = aProject({
    status: "live",
    spec: SPEC,
    previewUrl: "http://localhost:8100",
    stagingUrl: "http://localhost:18100",
    productionCommit: "a".repeat(40),
    stagingCommit: "b".repeat(40),
  });
  const passed = aBuild({ kind: "change", status: "passed", finishedAt: new Date() });
  const BROKEN = aFeatureResult({
    number: 1,
    name: "Photo carousel",
    state: "broken",
    checks: [
      aCheckResult({ id: "F1.1" }),
      aCheckResult({
        id: "F1.2",
        expect: "The first photo shows again.",
        verdict: "broken",
        saw: "Tapped Next on the last photo; nothing happened.",
      }),
    ],
  });
  const WORKS = aFeatureResult({
    number: 2,
    name: "Messages",
    checks: [
      aCheckResult({ id: "F2.1", expect: "The message is in the thread.", saw: "It was there." }),
    ],
  });
  const staging = { buildId: passed.id, features: [BROKEN, WORKS] };
  const region = () => screen.findByRole("region", { name: copy.project.features.title });

  it("lists every feature as working or not yet, with each check and what the tester saw", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({ project: app, latestBuild: passed, hasBeenLive: true, staging })
    );

    const shown = await region();
    expect(within(shown).getByText(copy.project.features.summary(1, 2))).toBeVisible();
    const carousel = within(shown).getByRole("heading", { name: "Photo carousel" });
    const messages = within(shown).getByRole("heading", { name: "Messages" });
    expect(carousel.parentElement).toHaveTextContent(copy.project.features.state.broken);
    expect(messages.parentElement).toHaveTextContent(copy.project.features.state.works);
    // A feature not working yet shows its checks; one that works folds them away.
    expect(within(shown).getByText("The first photo shows again.")).toBeVisible();
    expect(
      within(shown).getByText(/Tapped Next on the last photo; nothing happened\./)
    ).toBeVisible();
    expect(within(shown).getByText("The message is in the thread.")).not.toBeVisible();
  });

  it("writes a change request from a broken feature for the owner to send, without sending it", async () => {
    // Through the routes: the request is on the Changes view, and moving there moves the focus.
    window.history.replaceState(null, "", "/projects/7");
    const calls = renderWithApi(
      <Routes />,
      projectServer({ project: app, latestBuild: passed, hasBeenLive: true, staging })
    );

    const shown = await region();
    await userEvent.click(
      within(shown).getByRole("button", { name: copy.project.features.askForFix })
    );

    const request = screen.getByLabelText(copy.project.changeLabel);
    expect(request).toHaveValue(
      copy.project.features.fixRequest("Photo carousel", [
        {
          expect: "The first photo shows again.",
          saw: "Tapped Next on the last photo; nothing happened.",
        },
      ])
    );
    await waitFor(() => expect(request).toHaveFocus());
    expect(window.location.pathname).toBe("/projects/7/changes");
    expect(calls.map(({ path }) => path)).not.toContain("projects.requestChange");
    // Only a broken feature offers it.
    expect(
      within(shown).getAllByRole("button", { name: copy.project.features.askForFix })
    ).toHaveLength(1);
  });

  it("names the features not working yet before putting the version live", async () => {
    const calls = renderWithApi(<ProjectPage id={7} />, {
      ...projectServer({
        project: app,
        latestBuild: passed,
        hasBeenLive: true,
        unreleased: 1,
        staging,
      }),
      "projects.promote": () => ({ project: app, build: aBuild({ kind: "promote" }) }),
    });
    await region();

    await userEvent.click(screen.getByRole("button", { name: copy.project.release.promote }));

    expect(screen.getByText(copy.project.release.notWorking(["Photo carousel"]))).toBeVisible();
    expect(calls.map(({ path }) => path)).not.toContain("projects.promote");
    await userEvent.click(screen.getByRole("button", { name: copy.project.release.notWorkingNo }));
    expect(screen.queryByText(copy.project.release.notWorking(["Photo carousel"]))).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: copy.project.release.promote }));
    await userEvent.click(screen.getByRole("button", { name: copy.project.release.notWorkingYes }));
    expect(calls).toContainEqual({ path: "projects.promote", input: { id: 7 } });
  });

  it("puts a version live at once when every feature works", async () => {
    const calls = renderWithApi(<ProjectPage id={7} />, {
      ...projectServer({
        project: app,
        latestBuild: passed,
        hasBeenLive: true,
        unreleased: 1,
        staging: { buildId: passed.id, features: [WORKS] },
      }),
      "projects.promote": () => ({ project: app, build: aBuild({ kind: "promote" }) }),
    });
    await region();

    await userEvent.click(screen.getByRole("button", { name: copy.project.release.promote }));

    expect(calls).toContainEqual({ path: "projects.promote", input: { id: 7 } });
  });

  it("shows nothing when no tester followed the version's checks", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({ project: app, latestBuild: passed, hasBeenLive: true })
    );

    await screen.findByRole("region", { name: copy.project.designer.appTitle });
    expect(screen.queryByRole("region", { name: copy.project.features.title })).toBeNull();
  });

  it("shows which features worked in a past version, once asked", async () => {
    const past = aBuild({ id: 2, kind: "change", status: "passed", request: "Add photos" });
    const calls = renderWithApi(
      <ProjectPage id={7} view="changes" />,
      projectServer({
        project: app,
        latestBuild: passed,
        hasBeenLive: true,
        history: [passed, past],
        results: { 2: [BROKEN] },
      })
    );

    const toggle = await screen.findByRole("button", {
      name: copy.project.features.showInHistory,
    });
    expect(calls.map(({ path }) => path)).not.toContain("builds.acceptance");
    await userEvent.click(toggle);

    expect(await screen.findByRole("heading", { name: "Photo carousel" })).toBeVisible();
    expect(calls).toContainEqual({ path: "builds.acceptance", input: { buildId: 2 } });
  });
});
