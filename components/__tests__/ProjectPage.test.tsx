import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { copy } from "../../data/copy";
import { ProjectPage } from "../ProjectPage";
import {
  aBuild,
  anEvent,
  aProject,
  ApiFailure,
  noUsage,
  projectServer,
  renderWithApi,
} from "./fakeApi";

const SPEC = "## Features\n- Keep a list of clients\n\n## Screens\n- Client list";

describe("ProjectPage", () => {
  it("saves the features and writes the spec, then shows it readably", async () => {
    const state = { project: aProject() };
    const calls = renderWithApi(<ProjectPage id={7} />, {
      ...projectServer(state),
      "projects.setFeatures": (input) => {
        state.project = aProject({ features: String(input.features) });
        return state.project;
      },
      "projects.generateSpec": () => {
        state.project = aProject({
          features: state.project.features,
          status: "spec_ready",
          spec: SPEC,
        });
        return state.project;
      },
    });

    expect(await screen.findByText(copy.status.draft.hint)).toBeInTheDocument();
    await userEvent.type(
      screen.getByLabelText(copy.project.featuresLabel),
      "Keep a list of clients"
    );
    await userEvent.click(screen.getByRole("button", { name: copy.project.writeSpec }));

    expect(await screen.findByRole("heading", { name: "Screens" })).toBeInTheDocument();
    expect(calls.map((call) => call.path)).toEqual(
      expect.arrayContaining(["projects.setFeatures", "projects.generateSpec"])
    );
    expect(calls.find((call) => call.path === "projects.setFeatures")?.input).toEqual({
      id: 7,
      features: "Keep a list of clients",
    });
    expect(screen.getByRole("button", { name: copy.project.approve })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(copy.status.spec_ready.label);
  });

  it("says the spec is being written while it is", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({ project: aProject({ status: "spec_generating" }) })
    );
    expect(await screen.findByText(copy.project.specWriting)).toBeInTheDocument();
  });

  it("warns that changing the features discards the spec", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({ project: aProject({ status: "spec_ready", features: "a", spec: SPEC }) })
    );
    await userEvent.click(await screen.findByRole("button", { name: copy.project.changeFeatures }));
    expect(screen.getByText(copy.project.discardWarning)).toBeInTheDocument();
    expect(screen.getByLabelText(copy.project.featuresLabel)).toHaveValue("a");
  });

  it("approves the spec and starts the build", async () => {
    const state = {
      project: aProject({ status: "spec_ready", features: "a", spec: SPEC }),
      latestBuild: null as ReturnType<typeof aBuild> | null,
    };
    const calls = renderWithApi(<ProjectPage id={7} />, {
      ...projectServer(state),
      "projects.get": () => ({
        project: state.project,
        latestBuild: state.latestBuild,
        queued: [],
        usage: noUsage,
      }),
      "projects.approveSpec": () => {
        state.project = { ...state.project, status: "building" };
        state.latestBuild = aBuild();
        return { project: state.project, build: state.latestBuild };
      },
    });
    await userEvent.click(await screen.findByRole("button", { name: copy.project.approve }));
    expect(calls).toContainEqual({ path: "projects.approveSpec", input: { id: 7 } });
    expect(await screen.findByText(copy.project.buildStatus.running)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(copy.status.building.label);
  });

  it("lets a change be requested while a build runs, and lists the waiting changes", async () => {
    const state = {
      project: aProject({ status: "building", spec: SPEC }),
      latestBuild: aBuild({ kind: "change", request: "Add a due date" }),
      queued: [aBuild({ id: 4, kind: "change", status: "queued", request: "Sort by date" })],
    };
    const calls = renderWithApi(<ProjectPage id={7} />, {
      ...projectServer(state),
      "projects.requestChange": (input) => {
        const build = aBuild({ id: 5, status: "queued", request: String(input.request) });
        state.queued = [...state.queued, build];
        return { project: state.project, build };
      },
    });

    expect(await screen.findByText(copy.project.changeQueueIntro)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(copy.project.changeLabel), "Add a logo");
    await userEvent.click(screen.getByRole("button", { name: copy.project.requestChange }));

    expect(calls).toContainEqual({
      path: "projects.requestChange",
      input: { id: 7, request: "Add a logo" },
    });
    const queue = await screen.findByRole("region", { name: copy.project.queueTitle });
    await within(queue).findByText("Add a logo");
    expect(
      within(queue)
        .getAllByRole("listitem")
        .map((item) => item.textContent)
    ).toEqual([expect.stringContaining("Sort by date"), expect.stringContaining("Add a logo")]);
  });

  it("edits and removes a waiting change", async () => {
    const state = {
      project: aProject({ status: "building" }),
      latestBuild: aBuild(),
      queued: [aBuild({ id: 4, kind: "change", status: "queued", request: "Sort by dat" })],
    };
    const calls = renderWithApi(<ProjectPage id={7} />, {
      ...projectServer(state),
      "builds.editQueued": (input) => {
        state.queued = [{ ...state.queued[0], request: String(input.request) }];
        return state.queued[0];
      },
      "builds.removeQueued": () => {
        const [removed] = state.queued;
        state.queued = [];
        return removed;
      },
    });

    await userEvent.click(
      await screen.findByRole("button", { name: copy.project.queueEditLabel(1) })
    );
    const field = screen.getByLabelText(copy.project.queueEditFieldLabel(1));
    await userEvent.clear(field);
    await userEvent.type(field, "Sort by date");
    await userEvent.click(screen.getByRole("button", { name: copy.project.queueSave }));
    expect(calls).toContainEqual({
      path: "builds.editQueued",
      input: { buildId: 4, request: "Sort by date" },
    });
    expect(await screen.findByText("Sort by date")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: copy.project.queueRemoveLabel(1) }));
    expect(calls).toContainEqual({ path: "builds.removeQueued", input: { buildId: 4 } });
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: copy.project.queueTitle })).toBeNull()
    );
  });

  it("appends new build events as they arrive, in plain words", async () => {
    const events = [anEvent(1, "step", "Copying the template into a fresh workspace")];
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({ project: aProject({ status: "building" }), latestBuild: aBuild(), events })
    );
    const log = await screen.findByRole("log");
    expect(
      await within(log).findByText("Copying the template into a fresh workspace")
    ).toBeInTheDocument();
    expect(within(log).getByText(copy.project.eventKind.step)).toBeInTheDocument();

    events.push(anEvent(2, "check", "Running make test"));
    expect(
      await within(log).findByText("Running make test", {}, { timeout: 4000 })
    ).toBeInTheDocument();
    expect(within(log).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText(copy.project.phase.check)).toBeInTheDocument();
  });

  it("shows the preview link and usage once the app is live", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({
        project: aProject({ status: "live", spec: SPEC, previewUrl: "http://localhost:8100" }),
        latestBuild: aBuild({ status: "passed", finishedAt: new Date() }),
        usage: {
          inputTokens: 1200,
          outputTokens: 300,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0.42,
        },
      })
    );
    const link = await screen.findByRole("link", { name: new RegExp(copy.project.open) });
    expect(link).toHaveAttribute("href", "http://localhost:8100");
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.getByText("$0.42")).toBeInTheDocument();
    expect(screen.getByText("1,200")).toBeInTheDocument();
    expect(screen.getByLabelText(copy.project.changeLabel)).toBeInTheDocument();
  });

  it("requests a change on a live app", async () => {
    const calls = renderWithApi(<ProjectPage id={7} />, {
      ...projectServer({
        project: aProject({ status: "live", previewUrl: "http://localhost:8100" }),
        latestBuild: aBuild({ status: "passed" }),
      }),
      "projects.requestChange": () => ({ project: aProject(), build: aBuild() }),
    });
    await userEvent.type(await screen.findByLabelText(copy.project.changeLabel), "Add a due date");
    await userEvent.click(screen.getByRole("button", { name: copy.project.requestChange }));
    expect(calls).toContainEqual({
      path: "projects.requestChange",
      input: { id: 7, request: "Add a due date" },
    });
  });

  it("shows why a build failed", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({
        project: aProject({ status: "failed" }),
        latestBuild: aBuild({
          status: "failed",
          error: "make test failed (exit 2)",
          finishedAt: new Date(),
        }),
      })
    );
    expect(await screen.findByText(copy.project.failureTitle)).toBeInTheDocument();
    expect(screen.getByText("make test failed (exit 2)")).toBeInTheDocument();
    expect(screen.getByText(copy.status.failed.hint)).toBeInTheDocument();
  });

  it("says when the project no longer exists", async () => {
    renderWithApi(<ProjectPage id={7} />, {
      "projects.get": () => {
        throw new ApiFailure("NOT_FOUND", "Project 7 not found");
      },
    });
    expect(await screen.findByText(copy.errors.notFound)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: copy.project.back })).toHaveAttribute("href", "#/");
  });

  it("confirms before deleting, saying what goes, then returns to the list", async () => {
    window.location.hash = "#/projects/7";
    const calls = renderWithApi(<ProjectPage id={7} />, {
      ...projectServer({ project: aProject({ status: "stopped" }) }),
      "projects.delete": () => undefined,
    });
    await userEvent.click(await screen.findByRole("button", { name: copy.project.delete }));
    expect(screen.getByText(copy.project.deleteConfirm("Invoices"))).toBeInTheDocument();
    expect(calls.some((call) => call.path === "projects.delete")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: copy.project.deleteYes }));
    expect(calls).toContainEqual({ path: "projects.delete", input: { id: 7 } });
    await waitFor(() => expect(window.location.hash).toBe("#/"));
  });
});
