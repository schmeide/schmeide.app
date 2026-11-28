import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { copy } from "../../data/copy";
import type { Build } from "../../trpc";
import { ProjectPage } from "../ProjectPage";
import { aBuild, aProject, ApiFailure, projectServer, renderWithApi } from "./fakeApi";

const live = aProject({
  status: "live",
  previewUrl: "http://localhost:8100",
  stagingUrl: "http://localhost:8101",
  productionCommit: "2".repeat(40),
  stagingCommit: "3".repeat(40),
});
const day = (date: number) => new Date(`2026-11-${date}T10:00:00Z`);
const passed = (overrides: Partial<Build>) =>
  aBuild({ status: "passed", startedAt: day(10), finishedAt: day(10), ...overrides });

// Version 1, version 2 by Ann, put live by Ann, then version 3 by Ben: newest first.
const history = [
  { ...passed({ id: 4, kind: "change", request: "Add a photo gallery", version: 3 }), by: "Ben" },
  { ...passed({ id: 3, kind: "promote", startedAt: day(14) }), movedTo: 2, by: "Ann" },
  { ...passed({ id: 2, kind: "change", request: "Add a menu", version: 2 }), by: "Ann" },
  passed({ id: 1, kind: "initial", request: "spec", version: 1 }),
];
const server = (overrides: Partial<Parameters<typeof projectServer>[0]> = {}) =>
  projectServer({
    project: live,
    latestBuild: history[0],
    hasBeenLive: true,
    history,
    liveVersion: 2,
    workingVersion: 3,
    pictures: { 4: "data:image/webp;base64,UklGRg==" },
    ...overrides,
  });

const rows = async () =>
  within(await screen.findByRole("list", { name: copy.project.versions.title })).getAllByRole(
    "listitem"
  );
const putLive = (version: number) =>
  screen.getByRole("button", {
    name: copy.project.versions.putLive,
    description: copy.project.versions.version(version),
  });
const short = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

describe("Versions", () => {
  it("lists the versions newest first, with their badges and what happened between them", async () => {
    renderWithApi(<ProjectPage id={7} view="versions" />, server());

    const items = await rows();
    expect(items).toHaveLength(4);
    expect(within(items[0]).getByRole("heading")).toHaveTextContent("Version 3");
    expect(items[0]).toHaveTextContent("Add a photo gallery");
    expect(items[0]).toHaveTextContent(copy.project.release.askedBy("Ben"));
    expect(items[0]).toHaveTextContent(copy.project.versions.working);
    expect(items[0]).not.toHaveTextContent(copy.project.versions.live);
    expect(
      await within(items[0]).findByRole("img", { name: copy.project.versions.pictureAlt(3) })
    ).toHaveAttribute("width", "640");
    expect(items[1]).toHaveTextContent(
      copy.project.versions.event(
        copy.project.versions.putLiveEvent(2),
        "Ann",
        short.format(day(14))
      )
    );
    expect(within(items[2]).getByRole("heading")).toHaveTextContent("Version 2");
    expect(items[2]).toHaveTextContent(copy.project.versions.live);
    expect(within(items[3]).getByRole("heading")).toHaveTextContent("Version 1");
    expect(items[3]).toHaveTextContent(copy.project.history.firstBuild);
    // Version 3 has a picture; the others have none and show no image.
    expect(within(items[3]).queryByRole("img")).toBeNull();
    // The live version cannot be put live again.
    expect(
      within(items[2]).queryByRole("button", { name: copy.project.versions.putLive })
    ).toBeNull();
  });

  it("asks first, saying what customers will see and that the information stays, then puts the version live", async () => {
    const calls = renderWithApi(<ProjectPage id={7} view="versions" />, {
      ...server(),
      "projects.rollBack": () => ({ project: live, build: aBuild({ kind: "rollback" }) }),
    });
    await rows();
    await userEvent.click(putLive(1));

    const confirm = screen.getByRole("region", { name: copy.project.versions.confirmTitle(1) });
    expect(confirm).toHaveTextContent(copy.project.versions.customersTitle);
    expect(confirm).toHaveTextContent(copy.project.versions.goesBack(1));
    const leaving = within(confirm).getByRole("list");
    expect(
      within(leaving)
        .getAllByRole("listitem")
        .map((item) => item.textContent)
    ).toEqual(["Add a menu"]);
    expect(confirm).toHaveTextContent(copy.project.versions.informationTitle);
    expect(confirm).toHaveTextContent(copy.project.versions.keeps(1));
    expect(confirm).toHaveTextContent(copy.project.versions.undo(2));
    // Keeping the information needs no typed name.
    expect(within(confirm).queryByRole("textbox")).toBeNull();

    await userEvent.click(
      within(confirm).getByRole("button", { name: copy.project.versions.confirm(1) })
    );
    await waitFor(() =>
      expect(calls).toContainEqual({ path: "projects.rollBack", input: { id: 7, version: 1 } })
    );
  });

  it("offers a copy of the information when the server refuses to keep today's, and asks for the app's name", async () => {
    const takenAt = new Date("2026-11-12T14:02:00Z");
    const reason =
      "Version 2 changed how your app stores its information, so version 1 cannot read it.";
    const calls = renderWithApi(<ProjectPage id={7} view="versions" />, {
      ...server(),
      "projects.rollBack": (input) => {
        if (input.withInformationFrom === undefined)
          throw new ApiFailure("CONFLICT", `${reason} You can go back.`, {
            reason,
            copies: [{ id: 9, version: 1, takenAt }],
          });
        return { project: live, build: aBuild({ kind: "rollback" }) };
      },
    });
    await rows();
    await userEvent.click(putLive(1));
    const confirm = screen.getByRole("region", { name: copy.project.versions.confirmTitle(1) });
    await userEvent.click(
      within(confirm).getByRole("button", { name: copy.project.versions.confirm(1) })
    );

    expect(await within(confirm).findByText(reason)).toBeInTheDocument();
    expect(confirm).not.toHaveTextContent(copy.project.versions.keeps(1));
    const offer = within(confirm).getByRole("radio", {
      name: copy.project.versions.withCopy(1, copy.project.versions.when(takenAt)),
    });
    expect(offer).toBeChecked();
    expect(confirm).toHaveTextContent(copy.project.versions.loses);

    const withCopy = within(confirm).getByRole("button", {
      name: copy.project.versions.confirmWithCopy(1),
    });
    await userEvent.click(withCopy);
    const name = within(confirm).getByRole("textbox", {
      name: copy.project.versions.typeName("Invoices"),
    });
    expect(name).toBeInvalid();
    expect(calls.filter((call) => call.path === "projects.rollBack")).toHaveLength(1);

    await userEvent.type(name, "Invoices");
    await userEvent.click(withCopy);
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "projects.rollBack",
        input: { id: 7, version: 1, withInformationFrom: 9 },
      })
    );
  });

  it("says there is nothing to go back to with one version", async () => {
    renderWithApi(
      <ProjectPage id={7} view="versions" />,
      server({ history: [history[3]], latestBuild: history[3], liveVersion: 1, workingVersion: 1 })
    );
    expect(await screen.findByText(copy.project.versions.only)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.project.versions.putLive })).toBeNull();
  });

  it("disables putting a version live while a build runs, and says why", async () => {
    renderWithApi(
      <ProjectPage id={7} view="versions" />,
      server({ project: { ...live, status: "building" } })
    );
    await rows();
    expect(screen.getByText(copy.project.versions.building)).toBeInTheDocument();
    expect(putLive(1)).toBeDisabled();
  });

  it("explains why versions from before versions were kept cannot be chosen", async () => {
    const old = passed({ id: 1, kind: "initial", request: "spec", version: null });
    renderWithApi(
      <ProjectPage id={7} view="versions" />,
      server({ history: [old], latestBuild: old, liveVersion: null, workingVersion: null })
    );
    const [item] = await rows();
    expect(within(item).getByRole("heading")).toHaveTextContent(copy.project.versions.unnumbered);
    expect(item).toHaveTextContent(copy.project.versions.unnumberedWhy);
    expect(screen.queryByRole("button", { name: copy.project.versions.putLive })).toBeNull();
  });

  it("shows a failed roll back's message, saying the live app returned", async () => {
    const failed = aBuild({
      id: 5,
      kind: "rollback",
      request: "Put version 1 live",
      status: "failed",
      error: "Version could not start: boom. Your live app is back on the version it was running.",
    });
    renderWithApi(
      <ProjectPage id={7} view="versions" />,
      server({ project: { ...live, status: "failed" }, latestBuild: failed })
    );
    expect(
      await screen.findByText(
        "Version could not start: boom. Your live app is back on the version it was running."
      )
    ).toBeInTheDocument();
  });

  it("offers going back to the version live before the current one on the overview", async () => {
    renderWithApi(<ProjectPage id={7} view="overview" />, server());
    await userEvent.click(
      await screen.findByRole("button", { name: copy.project.versions.goBack(1) })
    );
    const confirm = screen.getByRole("region", { name: copy.project.versions.confirmTitle(1) });
    expect(within(within(confirm).getByRole("list")).getByRole("listitem")).toHaveTextContent(
      "Add a menu"
    );
  });

  it("names the view in the tab", async () => {
    renderWithApi(<ProjectPage id={7} view="versions" />, server());
    await waitFor(() =>
      expect(document.title).toBe(
        copy.pageTitle(copy.project.viewTitle(copy.project.views.versions, "Invoices"))
      )
    );
  });
});
