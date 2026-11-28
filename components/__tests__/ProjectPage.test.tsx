import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { copy } from "../../data/copy";
import type { Project } from "../../trpc";
import { ProjectPage } from "../ProjectPage";
import { Routes } from "../Routes";
import {
  aBuild,
  anEvent,
  aSummary,
  aProject,
  ApiFailure,
  demoOwner,
  noUsage,
  projectServer,
  renderWithApi,
} from "./fakeApi";

const SPEC = "## Features\n- Keep a list of clients\n\n## Screens\n- Client list";

// A new project opens on the questions; the request boxes are one press away.
const writeItMyself = async () =>
  userEvent.click(await screen.findByRole("button", { name: copy.interview.writeMyself }));

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
    await writeItMyself();
    await userEvent.type(
      screen.getByLabelText(copy.project.requestLabel(1)),
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

  it("takes one request per box: add, Enter, remove, and empty boxes are ignored", async () => {
    const calls = renderWithApi(<ProjectPage id={7} />, {
      ...projectServer({ project: aProject() }),
      "projects.setFeatures": (input) => aProject({ features: String(input.features) }),
      "projects.generateSpec": () => aProject({ status: "spec_generating" }),
    });
    await writeItMyself();
    await userEvent.type(await screen.findByLabelText(copy.project.requestLabel(1)), "Clients");
    expect(screen.queryByRole("button", { name: copy.project.removeRequestLabel(1) })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: copy.project.addRequest }));
    expect(screen.getByLabelText(copy.project.requestLabel(2))).toHaveFocus();
    await userEvent.keyboard("Invoices{Enter}");
    expect(screen.getByLabelText(copy.project.requestLabel(3))).toHaveFocus();
    expect(calls.some((call) => call.path === "projects.setFeatures")).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: copy.project.addRequest }));
    await userEvent.keyboard("Not this one");
    await userEvent.click(screen.getByRole("button", { name: copy.project.removeRequestLabel(4) }));
    expect(screen.queryByLabelText(copy.project.requestLabel(4))).toBeNull();
    expect(screen.getByLabelText(copy.project.requestLabel(3))).toHaveFocus();

    await userEvent.click(screen.getByRole("button", { name: copy.project.writeSpec }));
    await waitFor(() =>
      expect(calls).toContainEqual({ path: "projects.generateSpec", input: { id: 7 } })
    );
    expect(calls).toContainEqual({
      path: "projects.setFeatures",
      input: { id: 7, features: "Clients\nInvoices" },
    });
  });

  it("asks for a request when every box is empty", async () => {
    const calls = renderWithApi(<ProjectPage id={7} />, projectServer({ project: aProject() }));
    await writeItMyself();
    await userEvent.click(await screen.findByRole("button", { name: copy.project.addRequest }));
    await userEvent.type(screen.getByLabelText(copy.project.requestLabel(2)), "   ");
    await userEvent.click(screen.getByRole("button", { name: copy.project.writeSpec }));
    const request = screen.getByLabelText(copy.project.requestLabel(1));
    expect(request).toBeInvalid();
    expect(request).toHaveAccessibleDescription(copy.project.needFeatures);
    expect(request).toHaveFocus();
    expect(calls.map((call) => call.path)).not.toContain("projects.setFeatures");
  });

  it("splits a pasted list into one box per line", async () => {
    renderWithApi(<ProjectPage id={7} />, projectServer({ project: aProject() }));
    await writeItMyself();
    await userEvent.click(await screen.findByLabelText(copy.project.requestLabel(1)));
    await userEvent.paste("Clients\r\n\n  Invoices  \nTax\n");
    expect(screen.getByLabelText(copy.project.requestLabel(1))).toHaveValue("Clients");
    expect(screen.getByLabelText(copy.project.requestLabel(2))).toHaveValue("Invoices");
    expect(screen.getByLabelText(copy.project.requestLabel(3))).toHaveValue("Tax");
    expect(screen.queryByLabelText(copy.project.requestLabel(4))).toBeNull();
    expect(screen.getByLabelText(copy.project.requestLabel(3))).toHaveFocus();
  });

  it("says why the last spec run failed on a fresh load, and points at make doctor for the login", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({ project: aProject({ features: "Clients", specError: "claude_login" }) })
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(copy.project.specFailed.claude_login);
    expect(alert).toHaveTextContent("make doctor");
    expect(alert).not.toHaveTextContent("Check your requests");
  });

  it("says nothing about a spec run when the last one did not fail", async () => {
    renderWithApi(<ProjectPage id={7} />, projectServer({ project: aProject({ features: "a" }) }));
    expect(await screen.findByText(copy.status.draft.hint)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    // Nothing is being worked on, so the status line has no spinner.
    expect(within(screen.getByRole("status")).queryByTestId("working")).toBeNull();
  });

  it("says the spec is being written while it is", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({ project: aProject({ status: "spec_generating" }) })
    );
    const writing = await screen.findByText(copy.project.specWriting);
    expect(within(writing).getByTestId("working")).toHaveAttribute("aria-hidden", "true");
    // The status line moves too while the page polls, and still announces its words.
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(copy.status.spec_generating.label);
    expect(within(status).getByTestId("working")).toHaveAttribute("aria-hidden", "true");
  });

  it.each(["spec_ready", "live"] as const)(
    "shows the prompt the project was started with next to the spec (%s)",
    async (status) => {
      const need = "Track my clients\nand their invoices";
      renderWithApi(
        <ProjectPage id={7} />,
        projectServer({ project: aProject({ status, need, spec: SPEC }) })
      );
      await userEvent.click(await screen.findByText(copy.project.showNeed));
      expect(
        screen.getByText((_, el) => el?.tagName === "P" && el.textContent === need)
      ).toBeVisible();
    }
  );

  it("warns that changing the features discards the spec", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({ project: aProject({ status: "spec_ready", features: "a\nb", spec: SPEC }) })
    );
    await userEvent.click(await screen.findByRole("button", { name: copy.project.changeFeatures }));
    expect(screen.getByText(copy.project.discardWarning)).toBeInTheDocument();
    expect(screen.getByLabelText(copy.project.requestLabel(1))).toHaveValue("a");
    expect(screen.getByLabelText(copy.project.requestLabel(2))).toHaveValue("b");
  });

  it("says when the page was out of date, and brings it up to date", async () => {
    const state = {
      project: aProject({ status: "live", previewUrl: "http://localhost:8100" }),
      latestBuild: aBuild({ status: "passed" }),
      hasBeenLive: true,
    };
    const stale =
      "This page was out of date: the app is “Offline” now, and this needs it to be “Live”, “Build failed” or “Offline”.";
    renderWithApi(<ProjectPage id={7} view="changes" />, {
      ...projectServer(state),
      // Someone took the app offline in another tab since this page loaded.
      "projects.requestChange": () => {
        state.project = aProject({ status: "stopped" });
        throw new ApiFailure("CONFLICT", stale);
      },
    });
    await userEvent.type(await screen.findByLabelText(copy.project.changeLabel), "Add a due date");
    await userEvent.click(screen.getByRole("button", { name: copy.project.requestChange }));

    expect(await screen.findByRole("alert")).toHaveTextContent(`${stale} ${copy.errors.refreshed}`);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(copy.status.stopped.label)
    );
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
        hasIcon: false,
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

  // Builds off, or builds for admins only and this person is not one.
  it("says building is not open yet in place of approving, when the server says this person may not build", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      {
        ...projectServer({
          project: aProject({ status: "spec_ready", features: "a", spec: SPEC }),
        }),
        "session.get": () => ({ ...demoOwner, providers: [], buildsOff: false, canBuild: false }),
      },
      "server"
    );
    expect(await screen.findByText(copy.project.buildsOff)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.project.approve })).toBeNull();
  });

  it("offers to approve when the server says this person may build", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      {
        ...projectServer({
          project: aProject({ status: "spec_ready", features: "a", spec: SPEC }),
        }),
        "session.get": () => ({ ...demoOwner, providers: [], buildsOff: false, canBuild: true }),
      },
      "server"
    );
    expect(await screen.findByRole("button", { name: copy.project.approve })).toBeInTheDocument();
    expect(screen.queryByText(copy.project.buildsOff)).toBeNull();
  });

  it("lets a change be requested while a build runs, and lists the waiting changes", async () => {
    const state = {
      project: aProject({ status: "building", spec: SPEC }),
      latestBuild: aBuild({ kind: "change", request: "Add a due date" }),
      queued: [aBuild({ id: 4, kind: "change", status: "queued", request: "Sort by date" })],
      hasBeenLive: true,
    };
    const calls = renderWithApi(<ProjectPage id={7} view="changes" />, {
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
      hasBeenLive: true,
    };
    const calls = renderWithApi(<ProjectPage id={7} view="changes" />, {
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
    await userEvent.click(
      await screen.findByRole("button", { name: copy.project.behindTheScenes })
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

  it("shows the summary first, and the log behind a real button that stays open as it runs", async () => {
    const events = [anEvent(1, "agent", "Editing frontend/src/Invoices.tsx")];
    const summaries = [aSummary(1, "Getting your project ready.")];
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({
        project: aProject({ status: "building" }),
        latestBuild: aBuild(),
        events,
        summaries,
      })
    );

    expect(await screen.findByText("Getting your project ready.")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: copy.project.behindTheScenes });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("log")).toBeNull();

    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const log = screen.getByRole("log");
    expect(await within(log).findByText("Editing frontend/src/Invoices.tsx")).toBeInTheDocument();

    // New events and a new summary arrive by polling; the log stays open and complete.
    events.push(anEvent(2, "check", "Running make test"));
    summaries.push(aSummary(2, "Adding the invoices screen."));
    expect(
      await screen.findByText("Adding the invoices screen.", {}, { timeout: 4000 })
    ).toBeInTheDocument();
    expect(await within(log).findByText("Running make test", {}, { timeout: 4000 })).toBeVisible();
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("log")).toBe(log);
    expect(within(log).getAllByRole("listitem")).toHaveLength(2);

    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("log")).toBeNull();
  });

  it("ends with the account of what changed, shown as plain text only", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({
        project: aProject({ status: "live", spec: SPEC, previewUrl: "http://localhost:8100" }),
        latestBuild: aBuild({ status: "passed", finishedAt: new Date() }),
        summaries: [
          aSummary(1, "Adding the invoices screen."),
          aSummary(2, 'Done. <img src="x" onerror="alert(1)"> [open](https://evil.example)', true),
        ],
      })
    );

    expect(
      await screen.findByText('Done. <img src="x" onerror="alert(1)"> [open](https://evil.example)')
    ).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("link", { name: "open" })).toBeNull();
  });

  it("says when a finished build has no summary", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({
        project: aProject({ status: "failed" }),
        latestBuild: aBuild({ status: "failed", error: "boom", finishedAt: new Date(0) }),
      })
    );
    expect(await screen.findByText(copy.project.summaryNone)).toBeInTheDocument();
  });

  it("shows the app in a frame, its link and usage once the app is live", async () => {
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
        time: {
          buildingMs: 400_000,
          failedBuildingMs: 0,
          builderMs: 250_000,
          builderUnrecorded: false,
        },
      })
    );
    const link = await screen.findByRole("link", { name: new RegExp(copy.project.openLive) });
    expect(link).toHaveAttribute("href", "http://localhost:8100");
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.getByText("$0.42")).toBeInTheDocument();
    expect(screen.getByText("1,200")).toBeInTheDocument();
    expect(screen.getByText("6 min 40 s")).toBeInTheDocument();
    expect(screen.getByText("4 min 10 s")).toBeInTheDocument();
    const frame = screen.getByTitle(copy.project.designer.frameTitle("Invoices"));
    expect(frame).toHaveAttribute("src", "http://localhost:8100");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(frame).toHaveAttribute("width");
    expect(frame).toHaveAttribute("height");
    expect(screen.getByText(copy.project.designer.frameHelp)).toBeVisible();
  });

  it("requests a change on a live app", async () => {
    const calls = renderWithApi(<ProjectPage id={7} view="changes" />, {
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

  it("saves the page title and icon, and goes back to the default icon", async () => {
    const state = { project: aProject({ status: "live" }), hasIcon: false };
    const calls = renderWithApi(<ProjectPage id={7} view="settings" />, {
      ...projectServer(state),
      "projects.setSite": (input) => {
        state.project = { ...state.project, pageTitle: String(input.title) || null };
        if (input.icon !== undefined) state.hasIcon = input.icon !== null;
        return state.project;
      },
    });
    const title = await screen.findByLabelText(copy.project.site.titleLabel);
    expect(title).toHaveValue("Invoices");
    expect(screen.getByText(copy.project.site.iconNone)).toBeInTheDocument();

    await userEvent.clear(title);
    await userEvent.type(title, "Acme invoices");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await userEvent.upload(
      screen.getByLabelText(copy.project.site.iconLabel),
      new File([png], "icon.png", { type: "image/png" })
    );
    await userEvent.click(screen.getByRole("button", { name: copy.project.site.save }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "projects.setSite",
        input: { id: 7, title: "Acme invoices", icon: "iVBORw0KGgo=" },
      })
    );
    await userEvent.click(
      await screen.findByRole("button", { name: copy.project.site.removeIcon })
    );
    expect(calls).toContainEqual({
      path: "projects.setSite",
      input: { id: 7, title: "Acme invoices", icon: null },
    });
    expect(await screen.findByText(copy.project.site.iconNone)).toBeInTheDocument();
  });

  it("refuses an icon file that is too big before sending it", async () => {
    const calls = renderWithApi(
      <ProjectPage id={7} view="settings" />,
      projectServer({ project: aProject({ status: "live" }) })
    );
    await userEvent.upload(
      await screen.findByLabelText(copy.project.site.iconLabel),
      new File([new Uint8Array(256 * 1024 + 1)], "huge.png", { type: "image/png" })
    );
    const icon = screen.getByLabelText(copy.project.site.iconLabel);
    expect(icon).toBeInvalid();
    expect(icon).toHaveAccessibleDescription(copy.project.site.iconTooBig);
    expect(icon).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: copy.project.site.save }));
    await waitFor(() =>
      expect(calls).toContainEqual({ path: "projects.setSite", input: { id: 7, title: "" } })
    );
  });

  it("says when the project no longer exists", async () => {
    renderWithApi(<ProjectPage id={7} />, {
      "projects.get": () => {
        throw new ApiFailure("NOT_FOUND", "Project 7 not found");
      },
    });
    expect(
      await screen.findByRole("heading", { level: 1, name: copy.problems.title })
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: copy.problems.action })).toHaveAttribute("href", "/");
  });

  it("says there is no access, and with which email, for a project of another business", async () => {
    renderWithApi(<ProjectPage id={7} />, {
      "projects.get": () => {
        throw new ApiFailure("FORBIDDEN", "Not a member");
      },
    });
    expect(
      await screen.findByRole("heading", { level: 1, name: copy.problems.title })
    ).toBeInTheDocument();
    expect(screen.getByText(copy.problems.signedInAs("owner@demo.example"))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: copy.problems.action })).toHaveAttribute("href", "/");
  });

  it("confirms before deleting, saying what goes, then returns to the list", async () => {
    window.history.replaceState(null, "", "/projects/7");
    const calls = renderWithApi(<ProjectPage id={7} view="settings" />, {
      ...projectServer({ project: aProject({ status: "stopped" }) }),
      "projects.delete": () => undefined,
    });
    await userEvent.click(await screen.findByRole("button", { name: copy.project.delete }));
    expect(screen.getByText(copy.project.deleteConfirm("Invoices"))).toBeInTheDocument();
    expect(calls.some((call) => call.path === "projects.delete")).toBe(false);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete project" }));
    expect(calls).toContainEqual({ path: "projects.delete", input: { id: 7 } });
    await waitFor(() => expect(window.location.pathname).toBe("/"));
  });
});

const primaryButtons = () => document.querySelectorAll('[data-variant="primary"]');
const currentStep = () =>
  within(screen.getByRole("list", { name: copy.project.setup.label }))
    .getAllByRole("listitem")
    .find((step) => step.getAttribute("aria-current") === "step")?.textContent;

describe("ProjectPage setup", () => {
  const setup = (project: Partial<Project>, latestBuild: ReturnType<typeof aBuild> | null = null) =>
    renderWithApi(
      <ProjectPage id={7} view="settings" />,
      projectServer({ project: aProject(project), latestBuild })
    );

  it("shows only the describe step in a new project, with one primary button", async () => {
    setup({});
    expect(await screen.findByRole("heading", { name: copy.project.featuresTitle })).toBeVisible();
    expect(currentStep()).toBe("Describe");
    expect(screen.queryByRole("heading", { name: copy.project.specTitle })).toBeNull();
    expect(screen.queryByLabelText(copy.project.site.titleLabel)).toBeNull();
    expect(screen.queryByLabelText(copy.project.changeLabel)).toBeNull();
    expect(screen.queryByRole("navigation", { name: copy.project.views.label })).toBeNull();
    expect(primaryButtons()).toHaveLength(1);
    expect(screen.getByRole("button", { name: copy.project.delete })).toBeInTheDocument();
  });

  it("moves the stepper to the spec, then back to describing while the requests are changed", async () => {
    setup({ status: "spec_ready", features: "a", spec: SPEC });
    expect(await screen.findByRole("heading", { name: copy.project.specTitle })).toBeVisible();
    expect(currentStep()).toBe("Spec");
    expect(screen.queryByRole("heading", { name: copy.project.featuresTitle })).toBeNull();
    expect(primaryButtons()).toHaveLength(1);
    expect(
      within(screen.getByRole("list", { name: copy.project.setup.label })).getAllByRole("listitem")
    ).toHaveLength(4);

    await userEvent.click(screen.getByRole("button", { name: copy.project.changeFeatures }));
    expect(currentStep()).toBe("Describe");
    expect(screen.queryByRole("button", { name: copy.project.approve })).toBeNull();
    expect(primaryButtons()).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: copy.project.cancelEdit }));
    expect(screen.getByRole("button", { name: copy.project.approve })).toBeInTheDocument();
  });

  it("shows only the build during the first build: no change box, no primary button", async () => {
    const calls = renderWithApi(<ProjectPage id={7} />, {
      ...projectServer({
        project: aProject({ status: "building", spec: SPEC }),
        latestBuild: aBuild(),
      }),
      "projects.stop": () => aProject({ status: "failed" }),
    });
    expect(await screen.findByRole("heading", { name: copy.project.buildTitle })).toBeVisible();
    expect(currentStep()).toBe("Build");
    expect(screen.queryByLabelText(copy.project.changeLabel)).toBeNull();
    expect(screen.queryByLabelText(copy.project.site.titleLabel)).toBeNull();
    expect(screen.queryByRole("button", { name: copy.project.delete })).toBeNull();
    expect(primaryButtons()).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: copy.project.cancelBuild }));
    expect(calls).toContainEqual({ path: "projects.stop", input: { id: 7 } });
  });

  it("keeps a canceled first build in setup, with no app to go back to", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({
        project: aProject({ status: "failed", spec: SPEC }),
        latestBuild: aBuild({
          kind: "initial",
          status: "canceled",
          error: null,
          finishedAt: new Date(),
        }),
        hasBeenLive: false,
      })
    );

    expect(await screen.findByText(copy.project.canceledHint)).toBeInTheDocument();
    expect(screen.getByText(copy.project.buildStatus.canceled)).toBeInTheDocument();
    expect(screen.queryByText(copy.status.failed.label)).toBeNull();
    expect(screen.queryByText(copy.project.failureTitle)).toBeNull();
    expect(screen.queryByRole("navigation", { name: copy.project.views.label })).toBeNull();
    expect(screen.queryByTitle(copy.project.designer.frameTitle("Invoices"))).toBeNull();
    expect(screen.queryByRole("link", { name: new RegExp(copy.project.openLive) })).toBeNull();
    expect(currentStep()).toBe("Build");
    expect(screen.getByRole("heading", { name: copy.project.buildTitle })).toBeVisible();
    expect(screen.getByLabelText(copy.project.changeLabel)).toBeInTheDocument();
  });

  it("keeps a project whose first build failed in setup, where it can be retried or deleted", async () => {
    const calls = renderWithApi(<ProjectPage id={7} />, {
      ...projectServer({
        project: aProject({ status: "failed", spec: SPEC }),
        // A retry is a change build, but nothing has passed yet.
        latestBuild: aBuild({
          kind: "change",
          request: "try again",
          status: "failed",
          error: "boom",
        }),
        hasBeenLive: false,
      }),
      "projects.requestChange": () => ({ project: aProject(), build: aBuild() }),
    });
    expect(await screen.findByText(copy.status.failed.hint)).toBeInTheDocument();
    expect(currentStep()).toBe("Build");
    expect(screen.getByRole("heading", { name: copy.project.retryBuildTitle })).toBeVisible();
    expect(screen.queryByRole("navigation", { name: copy.project.views.label })).toBeNull();
    expect(screen.getByRole("button", { name: copy.project.delete })).toBeInTheDocument();
    expect(primaryButtons()).toHaveLength(1);

    await userEvent.type(screen.getByLabelText(copy.project.changeLabel), "try again");
    await userEvent.click(screen.getByRole("button", { name: copy.project.requestChange }));
    expect(calls).toContainEqual({
      path: "projects.requestChange",
      input: { id: 7, request: "try again" },
    });
  });
});

describe("ProjectPage designer", () => {
  const live = aProject({ status: "live", spec: SPEC, previewUrl: "http://localhost:8100" });
  const passed = aBuild({ status: "passed", finishedAt: new Date() });

  const links = (nav: HTMLElement) =>
    within(nav)
      .getAllByRole("link")
      .map((link) => [
        link.textContent,
        link.getAttribute("href"),
        link.getAttribute("aria-current"),
      ]);

  it("links the designer and settings, and the two tabs of the designer, marking the one shown", async () => {
    renderWithApi(
      <ProjectPage id={7} view="changes" />,
      projectServer({ project: live, latestBuild: passed, hasBeenLive: true })
    );
    const views = await screen.findByRole("navigation", { name: copy.project.views.label });
    expect(links(views)).toEqual([
      ["Designer", "/projects/7", "true"],
      ["Settings", "/projects/7/settings", null],
    ]);
    expect(
      links(screen.getByRole("navigation", { name: copy.project.designer.tabsLabel }))
    ).toEqual([
      ["App", "/projects/7", null],
      ["Changes", "/projects/7/changes", "page"],
    ]);
    expect(screen.queryByRole("list", { name: copy.project.setup.label })).toBeNull();
  });

  it("marks the app tab on the app's own address, and has no tabs on settings", async () => {
    window.history.replaceState(null, "", "/projects/7");
    renderWithApi(
      <Routes />,
      projectServer({ project: live, latestBuild: passed, hasBeenLive: true })
    );
    const tabs = await screen.findByRole("navigation", { name: copy.project.designer.tabsLabel });
    expect(links(tabs)).toEqual([
      ["App", "/projects/7", "page"],
      ["Changes", "/projects/7/changes", null],
    ]);
    expect(links(screen.getByRole("navigation", { name: copy.project.views.label }))[0]).toEqual([
      "Designer",
      "/projects/7",
      "page",
    ]);

    await userEvent.click(within(tabs).getByRole("link", { name: copy.project.views.changes }));
    expect(window.location.pathname).toBe("/projects/7/changes");
    expect(
      within(screen.getByRole("navigation", { name: copy.project.designer.tabsLabel })).getByRole(
        "link",
        { name: copy.project.views.changes }
      )
    ).toHaveAttribute("aria-current", "page");

    await userEvent.click(screen.getByRole("link", { name: copy.project.views.settings }));
    expect(screen.queryByRole("navigation", { name: copy.project.designer.tabsLabel })).toBeNull();
    expect(screen.queryByTitle(copy.project.designer.frameTitle("Invoices"))).toBeNull();
  });

  it.each(["overview", "changes"] as const)(
    "shows the app and the way to change it together on %s, the request box saying a change is looked at before it goes live",
    async (view) => {
      renderWithApi(
        <ProjectPage id={7} view={view} />,
        projectServer({ project: live, latestBuild: passed, hasBeenLive: true })
      );
      const app = await screen.findByRole("region", { name: copy.project.designer.appTitle });
      expect(within(app).getByTitle(copy.project.designer.frameTitle("Invoices"))).toBeVisible();
      expect(screen.getByLabelText(copy.project.changeLabel)).toHaveAccessibleDescription(
        copy.project.designer.buildsToStaging
      );
      expect(screen.getByText(copy.project.designer.buildsToStaging)).toBeVisible();
    }
  );

  it("says the app is loading until the frame has loaded, and again after a reload", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({ project: live, latestBuild: passed, hasBeenLive: true })
    );
    const title = copy.project.designer.frameTitle("Invoices");
    const first = await screen.findByTitle(title);
    expect(screen.getByText(copy.project.designer.loading)).toBeVisible();
    fireEvent.load(first);
    expect(screen.queryByText(copy.project.designer.loading)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: copy.project.designer.reload }));
    expect(screen.getByText(copy.project.designer.loading)).toBeVisible();
    expect(screen.getByTitle(title)).not.toBe(first);
    expect(screen.getByTitle(title)).toHaveAttribute("src", "http://localhost:8100");
  });

  it("switches the frame between a computer and a phone width", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({ project: live, latestBuild: passed, hasBeenLive: true })
    );
    const widths = await screen.findByRole("group", { name: copy.project.designer.widthLabel });
    const computer = within(widths).getByRole("radio", {
      name: copy.project.designer.width.computer,
    });
    const phone = within(widths).getByRole("radio", { name: copy.project.designer.width.phone });
    const frame = screen.getByTitle(copy.project.designer.frameTitle("Invoices"));
    expect(computer).toBeChecked();
    const wide = Number(frame.getAttribute("width"));

    await userEvent.click(phone);
    expect(phone).toBeChecked();
    expect(computer).not.toBeChecked();
    expect(screen.getByTitle(copy.project.designer.frameTitle("Invoices"))).toBe(frame);
    expect(Number(frame.getAttribute("width"))).toBeLessThan(wide);
  });

  it("shows the live app while a change is built when asked, saying so, and loads the new version after when asked to", async () => {
    const state = {
      project: aProject({ status: "building", spec: SPEC, previewUrl: "http://localhost:8100" }),
      latestBuild: aBuild({ id: 8, kind: "change", request: "Add a logo" }),
      hasBeenLive: true,
    };
    renderWithApi(<ProjectPage id={7} />, projectServer(state));
    await userEvent.click(
      await screen.findByRole("button", { name: copy.project.designer.showApp })
    );
    const app = await screen.findByRole("region", { name: copy.project.designer.appTitle });
    const title = copy.project.designer.frameTitle("Invoices");
    const before = within(app).getByTitle(title);
    expect(within(app).getByText(copy.project.designer.building)).toBeVisible();
    expect(
      within(within(app).getByText(copy.project.designer.building)).getByTestId("working")
    ).toHaveAttribute("aria-hidden", "true");
    expect(
      within(app).getByRole("link", { name: new RegExp(copy.project.openLive) })
    ).toHaveAttribute("href", "http://localhost:8100");
    fireEvent.load(before);
    await userEvent.click(
      within(app).getByRole("checkbox", { name: copy.project.designer.reloadOnBuild })
    );

    state.project = { ...state.project, status: "live" };
    state.latestBuild = { ...state.latestBuild, status: "passed", finishedAt: new Date() };
    await waitFor(
      () => expect(within(app).queryByText(copy.project.designer.building)).toBeNull(),
      { timeout: 4000 }
    );
    expect(within(app).getByTitle(title)).not.toBe(before);
    expect(within(app).getByText(copy.project.designer.loading)).toBeVisible();
  });

  it("shows a building change's progress in place of the app, and the app as it is now on request", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({
        project: aProject({ status: "building", spec: SPEC, previewUrl: "http://localhost:8100" }),
        latestBuild: aBuild({ id: 8, kind: "change", request: "Add a logo" }),
        summaries: [aSummary(1, "Adding the logo.")],
        hasBeenLive: true,
      })
    );
    const progress = await screen.findByRole("heading", { name: copy.project.changeTitle });
    expect(progress).toBeVisible();
    // One copy of the running build: the side column no longer repeats it.
    expect(screen.getAllByRole("heading", { name: copy.project.changeTitle })).toHaveLength(1);
    expect(await screen.findByText("Adding the logo.")).toBeVisible();
    expect(screen.getByText("Add a logo")).toBeVisible();
    expect(screen.queryByRole("region", { name: copy.project.designer.appTitle })).toBeNull();
    expect(screen.queryByTitle(copy.project.designer.frameTitle("Invoices"))).not.toBeVisible();
    // The page's one status line says a change is being built; nothing else announces it.
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent(copy.project.appBuildingHint);

    await userEvent.click(screen.getByRole("button", { name: copy.project.designer.showApp }));
    const app = screen.getByRole("region", { name: copy.project.designer.appTitle });
    expect(within(app).getByTitle(copy.project.designer.frameTitle("Invoices"))).toBeVisible();
    expect(screen.queryByRole("heading", { name: copy.project.changeTitle })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: copy.project.designer.showBuild }));
    expect(screen.getByRole("heading", { name: copy.project.changeTitle })).toBeVisible();
  });

  it("goes back to the app when the change is built, its final summary above until dismissed", async () => {
    const state = {
      project: aProject({ status: "building", spec: SPEC, previewUrl: "http://localhost:8100" }),
      latestBuild: aBuild({ id: 8, kind: "change", request: "Add a logo" }),
      summaries: [aSummary(1, "Adding the logo.")],
      hasBeenLive: true,
    };
    renderWithApi(<ProjectPage id={7} />, projectServer(state));
    expect(await screen.findByRole("heading", { name: copy.project.changeTitle })).toBeVisible();

    state.project = { ...state.project, status: "live" };
    state.latestBuild = { ...state.latestBuild, status: "passed", finishedAt: new Date() };
    state.summaries = [...state.summaries, aSummary(2, "The logo is on every screen.", true)];
    const app = await screen.findByRole(
      "region",
      { name: copy.project.designer.appTitle },
      { timeout: 4000 }
    );
    expect(within(app).getByTitle(copy.project.designer.frameTitle("Invoices"))).toBeVisible();
    // The new version is loaded, not offered: the page's status line is the one announcement.
    expect(within(app).queryByText(copy.project.designer.newVersion)).toBeNull();
    expect(within(app).getByText(copy.project.designer.loading)).toBeVisible();
    expect(screen.getByText(copy.status.live.hint)).toBeInTheDocument();
    const built = screen.getByText(copy.project.designer.built);
    expect(built).toBeVisible();
    await waitFor(() =>
      expect(built.closest("p")).toHaveTextContent("The logo is on every screen.")
    );
    // Nothing took the focus as the build ended.
    expect(document.body).toHaveFocus();

    await userEvent.click(screen.getByRole("button", { name: copy.project.designer.dismiss }));
    expect(screen.queryByText(copy.project.designer.built)).toBeNull();
  });

  it("shows a failed change's result in place of the app, with a way to try it again", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({
        project: aProject({ status: "failed", spec: SPEC, previewUrl: "http://localhost:8100" }),
        latestBuild: aBuild({
          kind: "change",
          request: "Add a logo",
          status: "failed",
          error: "boom",
          finishedAt: new Date(),
        }),
        hasBeenLive: true,
      })
    );
    expect(await screen.findByRole("heading", { name: copy.project.changeTitle })).toBeVisible();
    expect(screen.getByText("boom")).toBeVisible();
    expect(screen.queryByRole("region", { name: copy.project.designer.appTitle })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: copy.project.retryTitle }));
    expect(screen.getByLabelText(copy.project.changeLabel)).toHaveValue("Add a logo");
    await waitFor(() => expect(screen.getByLabelText(copy.project.changeLabel)).toHaveFocus());

    await userEvent.click(screen.getByRole("button", { name: copy.project.designer.showApp }));
    expect(screen.getByRole("region", { name: copy.project.designer.appTitle })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: copy.project.designer.showResult }));
    expect(screen.getByText("boom")).toBeVisible();
  });

  it("says a rebuilt app appears when its build finishes, when there is no live version to show", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({
        project: aProject({ status: "building", spec: SPEC }),
        latestBuild: aBuild({ kind: "change", request: "Bring it back" }),
        hasBeenLive: true,
      })
    );
    await userEvent.click(
      await screen.findByRole("button", { name: copy.project.designer.showApp })
    );
    const app = await screen.findByRole("region", { name: copy.project.designer.appTitle });
    expect(within(app).getByText(copy.project.designer.buildingNoApp)).toBeVisible();
    expect(screen.queryByTitle(copy.project.designer.frameTitle("Invoices"))).toBeNull();
  });

  it("says there are no changes yet until one is requested", async () => {
    const state = {
      project: live,
      latestBuild: passed,
      hasBeenLive: true,
      queued: [] as ReturnType<typeof aBuild>[],
    };
    renderWithApi(<ProjectPage id={7} view="changes" />, {
      ...projectServer(state),
      "projects.requestChange": (input) => {
        const build = aBuild({ id: 5, status: "queued", request: String(input.request) });
        state.queued = [build];
        return { project: state.project, build };
      },
    });
    expect(await screen.findByText(copy.project.designer.noChanges)).toBeVisible();
    expect(screen.queryByRole("region", { name: copy.project.queueTitle })).toBeNull();

    await userEvent.type(screen.getByLabelText(copy.project.changeLabel), "Add a logo");
    await userEvent.click(screen.getByRole("button", { name: copy.project.requestChange }));
    await screen.findByRole("region", { name: copy.project.queueTitle });
    expect(screen.queryByText(copy.project.designer.noChanges)).toBeNull();
  });

  it("says which look the app has and why, and restyles it with another the person picks", async () => {
    const looks = [
      { id: "calm", name: "Calm", summary: "Calm and spacious." },
      { id: "ledger", name: "Ledger", summary: "Dense and orderly." },
    ];
    const server = projectServer({
      project: live,
      latestBuild: passed,
      hasBeenLive: true,
      design: {
        enabled: true,
        current: {
          style: "ledger",
          name: "Ledger",
          summary: "Dense and orderly.",
          chosenBy: "lead",
          reason: "Staff work through many orders a day.",
        },
        styles: looks,
      },
    });
    const calls = renderWithApi(<ProjectPage id={7} />, {
      ...server,
      "design.pick": () => null,
    });

    const section = await screen.findByRole("region", { name: copy.project.look.title });
    expect(
      within(section).getByText(copy.project.look.current("Ledger"), { exact: false })
    ).toBeVisible();
    expect(
      within(section).getByText(copy.project.look.why.lead("Staff work through many orders a day."))
    ).toBeVisible();
    const use = within(section).getByRole("button", { name: copy.project.look.use });
    expect(within(section).getByRole("radio", { name: /Ledger/ })).toBeChecked();
    expect(use).toBeDisabled();

    await userEvent.click(within(section).getByRole("radio", { name: /Calm/ }));
    await userEvent.click(use);

    await waitFor(() =>
      expect(calls).toContainEqual({ path: "design.pick", input: { id: 7, style: "calm" } })
    );
  });

  it("shows nothing about looks while the design team is off", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({ project: live, latestBuild: passed, hasBeenLive: true })
    );

    await screen.findByRole("region", { name: copy.project.builtFrom });
    expect(screen.queryByRole("region", { name: copy.project.look.title })).toBeNull();
  });

  it("calls the spec the one the app started from, and says nothing changed since", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({ project: live, latestBuild: passed, hasBeenLive: true })
    );

    const section = await screen.findByRole("region", { name: copy.project.builtFrom });
    expect(within(section).getByText(copy.project.builtFromUnchanged)).toBeVisible();
    expect(within(section).queryByRole("list", { name: copy.project.changesSince })).toBeNull();
  });

  it("lists the changes built since the spec, oldest first, so the spec is not read as current", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({
        project: live,
        latestBuild: passed,
        hasBeenLive: true,
        changes: [
          { id: 4, request: "Add a due date to each invoice", finishedAt: new Date() },
          { id: 5, request: "Send invoices by email", finishedAt: new Date() },
        ],
      })
    );

    const section = await screen.findByRole("region", { name: copy.project.builtFrom });
    expect(within(section).getByText(copy.project.builtFromChanged)).toBeVisible();
    const changes = within(section).getByRole("list", { name: copy.project.changesSince });
    expect(
      within(changes)
        .getAllByRole("listitem")
        .map((item) => item.textContent)
    ).toEqual(["Add a due date to each invoice", "Send invoices by email"]);
    expect(within(section).queryByText(copy.project.builtFromUnchanged)).toBeNull();
  });

  it.each(["overview", "changes", "settings"] as const)(
    "has at most one primary button on %s, and no numbered step",
    async (view) => {
      renderWithApi(
        <ProjectPage id={7} view={view} />,
        projectServer({ project: live, latestBuild: passed, hasBeenLive: true })
      );
      await screen.findByRole("navigation", { name: copy.project.views.label });
      expect(primaryButtons()).toHaveLength(view === "settings" ? 0 : 1);
      expect(
        screen
          .getAllByRole("heading", { level: 2 })
          .filter((heading) => /^\d/.test(heading.textContent))
      ).toEqual([]);
    }
  );

  it("keeps the designer to the app and its changes: no title or delete there", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({
        project: live,
        latestBuild: aBuild({ kind: "change", request: "Add a logo", status: "passed" }),
        hasBeenLive: true,
      })
    );
    await screen.findByRole("link", { name: new RegExp(copy.project.openLive) });
    expect(screen.getByLabelText(copy.project.changeLabel)).toBeInTheDocument();
    expect(screen.queryByLabelText(copy.project.site.titleLabel)).toBeNull();
    expect(screen.queryByRole("button", { name: copy.project.delete })).toBeNull();
    expect(screen.queryByText(copy.project.designer.noChanges)).toBeNull();
  });

  it("stays in the designer when a later change fails, showing the app from before it and what went wrong", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({
        project: aProject({ status: "failed", spec: SPEC, previewUrl: "http://localhost:8100" }),
        latestBuild: aBuild({
          kind: "change",
          request: "Add a logo",
          status: "failed",
          error: "boom",
        }),
        hasBeenLive: true,
      })
    );
    expect(await screen.findByText(copy.project.appFailedHint)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: copy.project.changeTitle })).toBeVisible();
    expect(screen.getByText(copy.project.failureTitle)).toBeVisible();
    expect(screen.getByText("boom")).toBeVisible();
    expect(screen.getByText(copy.project.changeRetryIntro)).toBeVisible();
    expect(primaryButtons()).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: copy.project.designer.showApp }));
    const app = screen.getByRole("region", { name: copy.project.designer.appTitle });
    expect(within(app).getByText(copy.project.designer.failed)).toBeVisible();
    expect(within(app).getByTitle(copy.project.designer.frameTitle("Invoices"))).toBeVisible();
  });

  it("stays in the designer when a later change is canceled, still showing the app from before it", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({
        project: aProject({ status: "failed", spec: SPEC, previewUrl: "http://localhost:8100" }),
        latestBuild: aBuild({
          kind: "change",
          request: "Add a logo",
          status: "canceled",
          error: null,
          finishedAt: new Date(),
        }),
        hasBeenLive: true,
        queued: [aBuild({ id: 9, status: "queued", request: "Add a due date" })],
      })
    );

    expect(await screen.findByText(copy.project.canceledHint)).toBeInTheDocument();
    expect(screen.queryByText(copy.project.appFailedHint)).toBeNull();
    expect(screen.queryByText(copy.status.failed.label)).toBeNull();
    expect(screen.getByText(copy.project.buildStatus.canceled)).toBeInTheDocument();
    expect(screen.queryByText(copy.project.failureTitle)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: copy.project.designer.showApp }));
    const app = screen.getByRole("region", { name: copy.project.designer.appTitle });
    expect(within(app).getByText(copy.project.designer.canceled)).toBeVisible();
    expect(within(app).queryByText(copy.project.designer.failed)).toBeNull();
    expect(within(app).getByTitle(copy.project.designer.frameTitle("Invoices"))).toBeVisible();
    expect(screen.getByText(copy.project.changeRetryIntro)).toBeVisible();
    expect(screen.getByText("Add a due date")).toBeVisible();
  });

  it("shows no frame for an offline app, saying why and how to bring it back", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({
        project: aProject({ status: "stopped", spec: SPEC }),
        latestBuild: passed,
        hasBeenLive: true,
      })
    );
    const app = await screen.findByRole("region", { name: copy.project.designer.appTitle });
    expect(within(app).getByText(copy.project.designer.offline)).toBeVisible();
    expect(screen.queryByTitle(copy.project.designer.frameTitle("Invoices"))).toBeNull();
    expect(screen.queryByRole("link", { name: new RegExp(copy.project.openLive) })).toBeNull();
    expect(screen.queryByRole("group", { name: copy.project.designer.widthLabel })).toBeNull();
    expect(screen.getByLabelText(copy.project.changeLabel)).toBeInTheDocument();
    expect(primaryButtons()).toHaveLength(1);
  });

  it("stays in the workspace when the app is offline", async () => {
    renderWithApi(
      <ProjectPage id={7} view="settings" />,
      projectServer({ project: aProject({ status: "stopped" }), hasBeenLive: true })
    );
    expect(await screen.findByLabelText(copy.project.site.titleLabel)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.project.takeOffline })).toBeNull();
    expect(screen.getByRole("button", { name: copy.project.delete })).toBeInTheDocument();
  });

  it("takes a live app offline from settings", async () => {
    const state = { project: live, latestBuild: passed, hasBeenLive: true };
    const calls = renderWithApi(<ProjectPage id={7} view="settings" />, {
      ...projectServer(state),
      "projects.stop": () => state.project,
    });
    await userEvent.click(await screen.findByRole("button", { name: copy.project.takeOffline }));
    expect(calls).toContainEqual({ path: "projects.stop", input: { id: 7 } });
  });

  it("offers to cancel a running change beside its log, and says why delete is not there", async () => {
    const building = {
      project: aProject({ status: "building", spec: SPEC }),
      latestBuild: aBuild({ kind: "change", request: "Add a logo" }),
      hasBeenLive: true,
    };
    window.history.replaceState(null, "", "/projects/7/changes");
    renderWithApi(<Routes />, projectServer(building));
    expect(await screen.findByRole("button", { name: copy.project.cancelBuild })).toBeVisible();
    expect(screen.getByRole("heading", { name: copy.project.changeTitle })).toBeVisible();
    expect(screen.getByText(copy.project.appBuildingHint)).toBeInTheDocument();
    expect(screen.getByText(copy.project.changeQueueIntro)).toBeVisible();

    await userEvent.click(screen.getByRole("link", { name: copy.project.views.settings }));
    expect(window.location.pathname).toBe("/projects/7/settings");
    expect(screen.getByText(copy.project.manageBusy)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.project.delete })).toBeNull();
    expect(screen.queryByRole("button", { name: copy.project.cancelBuild })).toBeNull();
  });

  it("heads the page and names the tab with the name the owner gave the app", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({ project: aProject({ name: "Invoices", pageTitle: "Billing Desk" }) })
    );

    expect(await screen.findByRole("heading", { level: 1, name: "Billing Desk" })).toBeVisible();
    await waitFor(() => expect(document.title).toBe(copy.pageTitle("Billing Desk")));
  });

  it("keeps a half-typed change while moving between views, and names the tab after the view", async () => {
    window.history.replaceState(null, "", "/projects/7/changes");
    renderWithApi(
      <Routes />,
      projectServer({ project: live, latestBuild: passed, hasBeenLive: true })
    );
    await userEvent.type(await screen.findByLabelText(copy.project.changeLabel), "Add a due");
    await waitFor(() =>
      expect(document.title).toBe(copy.pageTitle(copy.project.viewTitle("Changes", "Invoices")))
    );

    await userEvent.click(screen.getByRole("link", { name: copy.project.views.overview }));
    expect(window.location.pathname).toBe("/projects/7");
    expect(screen.getByLabelText(copy.project.changeLabel)).toHaveValue("Add a due");
    await waitFor(() => expect(document.title).toBe(copy.pageTitle("Invoices")));

    await userEvent.click(screen.getByRole("link", { name: copy.project.views.settings }));
    expect(screen.queryByLabelText(copy.project.changeLabel)).toBeNull();
    await userEvent.click(screen.getByRole("link", { name: copy.project.views.designer }));
    expect(screen.getByLabelText(copy.project.changeLabel)).toHaveValue("Add a due");
  });
});

describe("ProjectPage, the version being worked on", () => {
  const LIVE = "http://localhost:8100";
  const STAGING = "http://localhost:18100";
  const COMMIT = "a".repeat(40);
  const app = aProject({
    status: "live",
    spec: SPEC,
    previewUrl: LIVE,
    stagingUrl: STAGING,
    productionCommit: COMMIT,
    stagingCommit: "b".repeat(40),
  });
  const passed = aBuild({ kind: "change", status: "passed", finishedAt: new Date() });
  const region = () => screen.findByRole("region", { name: copy.project.designer.appTitle });

  it("frames the version being worked on, says customers see the same, and opens either copy", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({
        project: { ...app, stagingCommit: COMMIT },
        latestBuild: passed,
        hasBeenLive: true,
      })
    );
    const shown = await region();
    expect(within(shown).getByTitle(copy.project.designer.frameTitle("Invoices"))).toHaveAttribute(
      "src",
      STAGING
    );
    expect(within(shown).getByText(copy.project.release.showing)).toBeVisible();
    expect(within(shown).getByText(copy.project.release.same)).toBeVisible();
    expect(
      within(shown).getByRole("link", { name: new RegExp(copy.project.openStaging) })
    ).toHaveAttribute("href", STAGING);
    expect(
      within(shown).getByRole("link", { name: new RegExp(copy.project.openLive) })
    ).toHaveAttribute("href", LIVE);
    expect(screen.queryByRole("button", { name: copy.project.release.promote })).toBeNull();
    expect(screen.queryByRole("button", { name: copy.project.release.discard })).toBeNull();
  });

  it("says how many changes customers do not see yet, and puts them live", async () => {
    const calls = renderWithApi(<ProjectPage id={7} />, {
      ...projectServer({ project: app, latestBuild: passed, hasBeenLive: true, unreleased: 2 }),
      "projects.promote": () => ({ project: app, build: aBuild({ kind: "promote" }) }),
    });
    const shown = await region();
    expect(within(shown).getByText(copy.project.release.ahead(2))).toBeVisible();

    await userEvent.click(
      within(shown).getByRole("button", { name: copy.project.release.promote })
    );

    expect(calls).toContainEqual({ path: "projects.promote", input: { id: 7 } });
    expect(primaryButtons()).toHaveLength(1);
  });

  it("asks before throwing changes away, saying what happens to each copy's information", async () => {
    const calls = renderWithApi(<ProjectPage id={7} />, {
      ...projectServer({ project: app, latestBuild: passed, hasBeenLive: true, unreleased: 1 }),
      "projects.discard": () => ({ project: app, build: aBuild({ kind: "discard" }) }),
    });
    const shown = await region();
    expect(within(shown).getByText(copy.project.release.ahead(1))).toBeVisible();

    await userEvent.click(
      within(shown).getByRole("button", { name: copy.project.release.discard })
    );
    const confirm = within(shown).getByRole("group", {
      name: copy.project.release.discardConfirm(1),
    });
    await userEvent.click(
      within(confirm).getByRole("button", { name: copy.project.release.discardNo })
    );
    expect(
      within(shown).queryByRole("group", { name: copy.project.release.discardConfirm(1) })
    ).toBeNull();
    expect(calls.map((call) => call.path)).not.toContain("projects.discard");

    await userEvent.click(
      within(shown).getByRole("button", { name: copy.project.release.discard })
    );
    await userEvent.click(
      within(shown).getByRole("button", { name: copy.project.release.discardYes })
    );

    expect(calls).toContainEqual({ path: "projects.discard", input: { id: 7 } });
  });

  it("says why changes cannot be thrown away for an app live before versions were recorded", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({
        project: { ...app, productionCommit: null },
        latestBuild: passed,
        hasBeenLive: true,
        unreleased: 1,
      })
    );
    const shown = await region();
    expect(within(shown).getByText(copy.project.release.noDiscardYet)).toBeVisible();
    expect(within(shown).queryByRole("button", { name: copy.project.release.discard })).toBeNull();
    expect(within(shown).getByRole("button", { name: copy.project.release.promote })).toBeVisible();
  });

  it("offers nothing to put live or throw away while a change is built", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({
        project: { ...app, status: "building" },
        latestBuild: aBuild({ kind: "change", request: "Add a logo" }),
        hasBeenLive: true,
        unreleased: 1,
      })
    );
    await userEvent.click(
      await screen.findByRole("button", { name: copy.project.designer.showApp })
    );
    const shown = await region();
    expect(within(shown).getByText(copy.project.release.ahead(1))).toBeVisible();
    expect(within(shown).queryByRole("button", { name: copy.project.release.promote })).toBeNull();
    expect(within(shown).queryByRole("button", { name: copy.project.release.discard })).toBeNull();
  });

  it("shows an app live before staging existed, and its one address, until its next build", async () => {
    renderWithApi(
      <ProjectPage id={7} />,
      projectServer({
        project: { ...app, stagingUrl: null, stagingCommit: null, productionCommit: null },
        latestBuild: passed,
        hasBeenLive: true,
      })
    );
    const shown = await region();
    expect(within(shown).getByTitle(copy.project.designer.frameTitle("Invoices"))).toHaveAttribute(
      "src",
      LIVE
    );
    expect(
      within(shown)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href"))
    ).toEqual([LIVE]);
  });

  it("puts an offline app back up from the version being worked on", async () => {
    const calls = renderWithApi(<ProjectPage id={7} />, {
      ...projectServer({
        project: { ...app, status: "stopped", previewUrl: null, stagingUrl: null },
        latestBuild: passed,
        hasBeenLive: true,
      }),
      "projects.promote": () => ({ project: app, build: aBuild({ kind: "promote" }) }),
    });
    const shown = await region();
    expect(within(shown).getByText(copy.project.designer.offline)).toBeVisible();

    await userEvent.click(
      within(shown).getByRole("button", { name: copy.project.release.promote })
    );

    expect(calls).toContainEqual({ path: "projects.promote", input: { id: 7 } });
  });

  // The page polls while a build runs; each case moves the latest build from running to passed.
  const afterRelease = async (kind: "promote" | "discard") => {
    const state = {
      project: aProject({ ...app, status: "building" }),
      latestBuild: aBuild({ id: 9, kind, status: "running" }),
      hasBeenLive: true,
    };
    renderWithApi(<ProjectPage id={7} />, projectServer(state));
    const shown = await region();
    const before = within(shown).getByTitle(copy.project.designer.frameTitle("Invoices"));
    expect(within(shown).queryByText(copy.project.designer.newVersion)).toBeNull();

    state.project = { ...state.project, status: "live" };
    state.latestBuild = { ...state.latestBuild, status: "passed", finishedAt: new Date() };
    await waitFor(
      () =>
        expect(
          within(shown).queryByText(copy.project.designer.building, { exact: false })
        ).toBeNull(),
      { timeout: 4000 }
    );
    return { shown, before };
  };

  it("says nothing new is ready once a promote passes: the version being worked on is unchanged", async () => {
    const { shown, before } = await afterRelease("promote");
    expect(within(shown).getByTitle(copy.project.designer.frameTitle("Invoices"))).toBe(before);
    expect(within(shown).queryByText(copy.project.designer.newVersion)).toBeNull();
  });

  it("says a new version is ready once a discard passes, without reloading by itself", async () => {
    const { shown, before } = await afterRelease("discard");
    expect(await within(shown).findByText(copy.project.designer.newVersion)).toBeVisible();
    expect(within(shown).getByTitle(copy.project.designer.frameTitle("Invoices"))).toBe(before);

    await userEvent.click(
      within(shown).getByRole("button", { name: copy.project.designer.reloadNew })
    );
    expect(within(shown).getByTitle(copy.project.designer.frameTitle("Invoices"))).not.toBe(before);
    expect(within(shown).queryByText(copy.project.designer.newVersion)).toBeNull();
  });

  it("shows a promote as the latest change, with who asked for it", async () => {
    renderWithApi(
      <ProjectPage id={7} view="changes" />,
      projectServer({
        project: app,
        latestBuild: aBuild({ kind: "promote", request: "server words", status: "running" }),
        latestBuildBy: "Demo owner",
        hasBeenLive: true,
      })
    );
    expect(await screen.findByText(copy.project.release.promoteRequest)).toBeVisible();
    expect(screen.getByText(copy.project.release.askedBy("Demo owner"))).toBeVisible();
    expect(screen.queryByText("server words")).toBeNull();
  });
});
