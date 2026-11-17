import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { copy } from "../../data/copy";
import type {
  AuditEntry,
  BusinessEntry,
  HostedProject,
  PersonEntry,
  ProjectResources,
  UsageSummaryData,
} from "../../trpc";
import type { Session } from "../../utils/session";
import { AdminAuditPage } from "../AdminAuditPage";
import { AdminBusinessPage } from "../AdminBusinessPage";
import { AdminBusinessesPage } from "../AdminBusinessesPage";
import { AdminPage } from "../AdminPage";
import { AdminPeoplePage } from "../AdminPeoplePage";
import { AdminProjectsPage } from "../AdminProjectsPage";
import { AdminUsagePage } from "../AdminUsagePage";
import { ViewAsForm } from "../ViewAsForm";
import { renderWithApi } from "./fakeApi";

const admin: Session = {
  person: { name: "Grace", email: "grace@example.com", role: "admin" },
  businesses: [],
};

const anEntry = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  id: 1,
  admin: "grace@example.com",
  action: "admin.grant",
  targetEmail: null,
  targetBusiness: null,
  targetTenantId: null,
  detail: "",
  createdAt: new Date("2026-11-16T10:00:00Z"),
  ...overrides,
});

const noSummary = (): UsageSummaryData => ({
  businesses: [],
  projects: [],
  models: [],
  runKinds: [],
});

const filters = () => ({
  admins: ["command line", "grace@example.com"],
  businesses: [{ id: 4, name: "Ada's bakery", slug: "ada" }],
});

describe("AdminPage", () => {
  it("links to every admin section, and to no page for viewing as a customer", () => {
    renderWithApi(<AdminPage />, {}, admin);
    const nav = screen.getByRole("navigation", { name: copy.admin.sectionsNav });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")])
    ).toEqual([
      [copy.routes.adminBusinesses, "/admin/businesses"],
      [copy.routes.adminPeople, "/admin/people"],
      [copy.routes.adminProjects, "/admin/projects"],
      [copy.routes.adminUsage, "/admin/usage"],
      [copy.routes.adminAudit, "/admin/audit"],
    ]);
    expect(
      screen.getAllByRole("link").filter((link) => link.getAttribute("href") === "/admin/view-as")
    ).toEqual([]);
  });
});

describe("ViewAsForm", () => {
  it("asks only for a reason when it is given the person, and needs one before it starts", async () => {
    const calls = renderWithApi(<ViewAsForm email="ada@example.com" />, {}, admin);
    expect(screen.queryByLabelText(copy.viewAs.emailLabel)).toBeNull();
    await userEvent.type(screen.getByLabelText(copy.viewAs.reasonLabel), "   ");
    await userEvent.click(screen.getByRole("button", { name: copy.viewAs.action }));
    expect(await screen.findByRole("alert")).toHaveTextContent(copy.viewAs.reasonNeeded);
    expect(screen.getByLabelText(copy.viewAs.reasonLabel)).toHaveAttribute("aria-invalid", "true");
    expect(calls.filter(({ path }) => path === "admin.impersonation.start")).toEqual([]);
  });

  it("starts with the email it was given and the reason, then lands on the person's home", async () => {
    window.history.replaceState(null, "", "/admin");
    const calls = renderWithApi(
      <ViewAsForm email="ada@example.com" />,
      {
        "admin.impersonation.start": (input) => ({ name: "Ada", email: input.email }),
        "session.get": () => ({ ...admin, providers: [] }),
      },
      "server"
    );
    await userEvent.type(screen.getByLabelText(copy.viewAs.reasonLabel), "Ticket 42");
    await userEvent.click(screen.getByRole("button", { name: copy.viewAs.action }));
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(calls.find(({ path }) => path === "admin.impersonation.start")?.input).toEqual({
      email: "ada@example.com",
      reason: "Ticket 42",
    });
  });
});

describe("AdminAuditPage", () => {
  it("says when nothing has been recorded", async () => {
    renderWithApi(
      <AdminAuditPage />,
      {
        "admin.audit.list": () => ({ entries: [], nextCursor: null }),
        "admin.audit.filters": () => ({ admins: [], businesses: [] }),
      },
      admin
    );
    expect(await screen.findByText(copy.audit.empty)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("lists what admins did, newest first as the server sends it", async () => {
    renderWithApi(
      <AdminAuditPage />,
      {
        "admin.audit.list": () => ({
          entries: [
            anEntry({
              id: 2,
              action: "business.suspend",
              targetBusiness: "Ada's bakery",
              targetTenantId: 4,
              detail: "unpaid",
            }),
            anEntry({ id: 1, admin: "command line", targetEmail: "grace@example.com" }),
          ],
          nextCursor: null,
        }),
        "admin.audit.filters": filters,
      },
      admin
    );
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell")[2].textContent)).toEqual([
      "business.suspend",
      "admin.grant",
    ]);
    expect(within(rows[0]).getByText("Ada's bakery")).toBeInTheDocument();
    expect(within(rows[0]).getByText("unpaid")).toBeInTheDocument();
    expect(within(rows[1]).getByText("command line")).toBeInTheDocument();
  });

  it("filters by admin and by business", async () => {
    const calls = renderWithApi(
      <AdminAuditPage />,
      {
        "admin.audit.list": () => ({ entries: [anEntry()], nextCursor: null }),
        "admin.audit.filters": filters,
      },
      admin
    );
    await screen.findByRole("table");
    await userEvent.selectOptions(
      await screen.findByLabelText(copy.audit.adminLabel),
      "grace@example.com"
    );
    await userEvent.selectOptions(screen.getByLabelText(copy.audit.businessLabel), "Ada's bakery");
    expect(calls.filter(({ path }) => path === "admin.audit.list").at(-1)?.input).toMatchObject({
      admin: "grace@example.com",
      tenantId: 4,
    });
  });

  it("loads older entries a page at a time", async () => {
    const calls = renderWithApi(
      <AdminAuditPage />,
      {
        "admin.audit.list": (input) =>
          input.cursor
            ? { entries: [anEntry({ id: 1, action: "older" })], nextCursor: null }
            : { entries: [anEntry({ id: 2, action: "newer" })], nextCursor: 2 },
        "admin.audit.filters": filters,
      },
      admin
    );
    await userEvent.click(await screen.findByRole("button", { name: copy.audit.more }));
    expect(await screen.findByText("older")).toBeInTheDocument();
    expect(screen.getByText("newer")).toBeInTheDocument();
    expect(calls.at(-1)?.input).toMatchObject({ cursor: 2 });
    expect(screen.queryByRole("button", { name: copy.audit.more })).toBeNull();
  });
});

const created = new Date("2026-11-01T10:00:00Z");

const aBusiness = (overrides: Partial<BusinessEntry> = {}): BusinessEntry => ({
  id: 4,
  name: "Ada's bakery",
  slug: "ada",
  members: 2,
  projects: 3,
  createdAt: created,
  ...overrides,
});

const aPerson = (overrides: Partial<PersonEntry> = {}): PersonEntry => ({
  name: "Ada",
  email: "ada@example.com",
  approved: true,
  admin: false,
  businesses: [{ id: 4, name: "Ada's bakery" }],
  ...overrides,
});

const cellsOf = (row: HTMLElement) =>
  within(row)
    .getAllByRole("cell")
    .map((cell) => cell.textContent);

describe("AdminBusinessesPage", () => {
  it("lists every business with its counts, linking to its page", async () => {
    renderWithApi(
      <AdminBusinessesPage />,
      { "admin.businesses.list": () => ({ entries: [aBusiness()], nextCursor: null }) },
      admin
    );
    const table = await screen.findByRole("table", { name: copy.businesses.caption });
    const [row] = within(table).getAllByRole("row").slice(1);
    expect(cellsOf(row)).toEqual(["Ada's bakery", "ada", "2", "3", "Nov 1, 2026"]);
    expect(within(row).getByRole("link", { name: "Ada's bakery" })).toHaveAttribute(
      "href",
      "/admin/businesses/4"
    );
  });

  it("says when nothing matches", async () => {
    renderWithApi(
      <AdminBusinessesPage />,
      { "admin.businesses.list": () => ({ entries: [], nextCursor: null }) },
      admin
    );
    expect(await screen.findByText(copy.businesses.empty)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("searches by what is typed", async () => {
    const calls = renderWithApi(
      <AdminBusinessesPage />,
      { "admin.businesses.list": () => ({ entries: [aBusiness()], nextCursor: null }) },
      admin
    );
    await screen.findByRole("table");
    await userEvent.type(screen.getByRole("searchbox"), "ada@example.com");
    await userEvent.click(screen.getByRole("button", { name: copy.adminSearch.action }));
    await waitFor(() =>
      expect(
        calls.filter(({ path }) => path === "admin.businesses.list").at(-1)?.input
      ).toMatchObject({ search: "ada@example.com" })
    );
  });

  it("loads more a page at a time", async () => {
    renderWithApi(
      <AdminBusinessesPage />,
      {
        "admin.businesses.list": (input) =>
          input.cursor
            ? { entries: [aBusiness({ id: 5, name: "Older" })], nextCursor: null }
            : { entries: [aBusiness()], nextCursor: 1 },
      },
      admin
    );
    await userEvent.click(await screen.findByRole("button", { name: copy.adminSearch.more }));
    expect(await screen.findByText("Older")).toBeInTheDocument();
  });
});

describe("AdminBusinessPage", () => {
  it("shows the members with their roles and the apps with their state", async () => {
    renderWithApi(
      <AdminBusinessPage id={4} />,
      {
        "admin.businesses.get": () => ({
          business: { id: 4, name: "Ada's bakery", slug: "ada", createdAt: created },
          members: [{ name: "Ada", email: "ada@example.com", role: "owner", admin: false }],
          projects: [{ id: 7, name: "Invoices", status: "live" }],
        }),
        "admin.projects.resources": () => [figures()],
        "admin.usage.summary": noSummary,
      },
      admin
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: "Ada's bakery" })
    ).toBeInTheDocument();
    const members = screen.getByRole("table", { name: copy.business.membersTitle });
    expect(cellsOf(within(members).getAllByRole("row")[1]).slice(0, 3)).toEqual([
      "Ada",
      "ada@example.com",
      copy.business.roles.owner,
    ]);
    const apps = screen.getByRole("table", { name: copy.business.projectsTitle });
    expect(cellsOf(within(apps).getAllByRole("row")[1])).toEqual([
      "Invoices",
      copy.status.live.label,
    ]);
  });

  it("says when it has nobody and no apps", async () => {
    renderWithApi(
      <AdminBusinessPage id={4} />,
      {
        "admin.businesses.get": () => ({
          business: { id: 4, name: "", slug: "ada", createdAt: created },
          members: [],
          projects: [],
        }),
        "admin.usage.summary": noSummary,
      },
      admin
    );
    expect(await screen.findByText(copy.business.noMembers)).toBeInTheDocument();
    expect(screen.getByText(copy.business.noProjects)).toBeInTheDocument();
    // A business with no name goes by its slug.
    expect(screen.getByRole("heading", { level: 1, name: "ada" })).toBeInTheDocument();
  });

  const withMembers = () => ({
    business: { id: 4, name: "Ada's bakery", slug: "ada", createdAt: created },
    members: [
      { name: "Ada", email: "ada@example.com", role: "owner", admin: false },
      { name: "Stella", email: "stella@example.com", role: "editor", admin: true },
      { name: "Grace", email: admin.person?.email ?? "", role: "editor", admin: false },
      { name: "Eddie", email: "eddie@example.com", role: "editor", admin: false },
    ],
    projects: [],
  });

  it("offers viewing as a member only to customers who are not the admin", async () => {
    renderWithApi(<AdminBusinessPage id={4} />, { "admin.businesses.get": withMembers }, admin);
    const members = await screen.findByRole("table", { name: copy.business.membersTitle });
    const offers = within(members)
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).queryByText(copy.people.viewAs(cellsOf(row)[0] ?? "")) !== null);
    // Ada and Eddie, but not another admin, nor yourself.
    expect(offers).toEqual([true, false, false, true]);
  });

  it("needs a reason, and starts with the member's email", async () => {
    const calls = renderWithApi(
      <AdminBusinessPage id={4} />,
      {
        "admin.businesses.get": withMembers,
        "admin.impersonation.start": (input) => ({ name: "Eddie", email: input.email }),
        "session.get": () => ({ ...admin, providers: [] }),
      },
      admin
    );
    await userEvent.click(await screen.findByText(copy.people.viewAs("Eddie")));
    const form = screen.getByText(copy.people.viewAs("Eddie")).closest("details") as HTMLElement;
    expect(within(form).queryByLabelText(copy.viewAs.emailLabel)).toBeNull();
    await userEvent.click(within(form).getByRole("button", { name: copy.viewAs.action }));
    expect(await within(form).findByRole("alert")).toHaveTextContent(copy.viewAs.reasonNeeded);
    expect(calls.filter(({ path }) => path === "admin.impersonation.start")).toEqual([]);
    await userEvent.type(within(form).getByLabelText(copy.viewAs.reasonLabel), "Ticket 42");
    await userEvent.click(within(form).getByRole("button", { name: copy.viewAs.action }));
    await waitFor(() =>
      expect(calls.find(({ path }) => path === "admin.impersonation.start")?.input).toEqual({
        email: "eddie@example.com",
        reason: "Ticket 42",
      })
    );
  });
});

describe("AdminPeoplePage", () => {
  const people = () => ({
    entries: [
      aPerson(),
      aPerson({ name: "Grace", email: "grace@example.com", admin: true, businesses: [] }),
      aPerson({ name: "Ed", email: "ed@example.com", approved: false, businesses: [] }),
    ],
    nextCursor: null,
  });

  it("lists every person with their businesses, approval, and role", async () => {
    renderWithApi(<AdminPeoplePage />, { "admin.people.list": people }, admin);
    const table = await screen.findByRole("table", { name: copy.people.caption });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(cellsOf(rows[0]).slice(0, 5)).toEqual([
      "Ada",
      "ada@example.com",
      "Ada's bakery",
      copy.people.yes,
      copy.people.no,
    ]);
    expect(within(rows[0]).getByRole("link", { name: "Ada's bakery" })).toHaveAttribute(
      "href",
      "/admin/businesses/4"
    );
    expect(cellsOf(rows[1])[4]).toBe(copy.people.yes);
    expect(cellsOf(rows[2])[3]).toBe(copy.people.no);
  });

  it("says when nobody matches, and searches by what is typed", async () => {
    const calls = renderWithApi(
      <AdminPeoplePage />,
      { "admin.people.list": () => ({ entries: [], nextCursor: null }) },
      admin
    );
    expect(await screen.findByText(copy.people.empty)).toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox"), "Ada");
    await userEvent.click(screen.getByRole("button", { name: copy.adminSearch.action }));
    await waitFor(() => expect(calls.at(-1)?.input).toMatchObject({ search: "Ada" }));
  });

  it("offers viewing as a person only to customers who are not the admin", async () => {
    renderWithApi(
      <AdminPeoplePage />,
      {
        "admin.people.list": () => ({
          entries: [
            ...people().entries,
            aPerson({ name: "Grace", email: admin.person?.email ?? "", admin: false }),
          ],
          nextCursor: null,
        }),
      },
      admin
    );
    const rows = within(await screen.findByRole("table"))
      .getAllByRole("row")
      .slice(1);
    const offers = rows.map(
      (row) => within(row).queryByText(copy.people.viewAs(cellsOf(row)[0] ?? "")) !== null
    );
    // Ada and Ed (unapproved, which still works) but not another admin, nor yourself.
    expect(offers).toEqual([true, false, true, false]);
  });

  it("needs a reason, and starts with the row's email", async () => {
    const calls = renderWithApi(
      <AdminPeoplePage />,
      {
        "admin.people.list": () => ({ entries: [aPerson()], nextCursor: null }),
        "admin.impersonation.start": (input) => ({ name: "Ada", email: input.email }),
        "session.get": () => ({ ...admin, providers: [] }),
      },
      admin
    );
    await userEvent.click(await screen.findByText(copy.people.viewAs("Ada")));
    // The email is the row's; only the reason is asked.
    expect(screen.queryByLabelText(copy.viewAs.emailLabel)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: copy.viewAs.action }));
    expect(await screen.findByRole("alert")).toHaveTextContent(copy.viewAs.reasonNeeded);
    expect(calls.filter(({ path }) => path === "admin.impersonation.start")).toEqual([]);
    await userEvent.type(screen.getByLabelText(copy.viewAs.reasonLabel), "Ticket 42");
    await userEvent.click(screen.getByRole("button", { name: copy.viewAs.action }));
    await waitFor(() =>
      expect(calls.find(({ path }) => path === "admin.impersonation.start")?.input).toEqual({
        email: "ada@example.com",
        reason: "Ticket 42",
      })
    );
  });
});

const figures = (overrides: Partial<ProjectResources> = {}): ProjectResources => ({
  id: 7,
  containers: 2,
  memoryBytes: 3 * 1024 ** 2,
  cpuPercent: 1.5,
  workspaceBytes: 2 * 1024 ** 3,
  ...overrides,
});

const aHostedProject = (overrides: Partial<HostedProject> = {}): HostedProject => ({
  id: 7,
  name: "Invoices",
  slug: "invoices",
  status: "live",
  webPort: 8101,
  business: { id: 4, name: "Ada's bakery" },
  lastBuild: { kind: "change", status: "passed", startedAt: created },
  ...overrides,
});

describe("AdminProjectsPage", () => {
  it("lists every project with its business, port, last build, and what it takes up", async () => {
    const calls = renderWithApi(
      <AdminProjectsPage />,
      {
        "admin.projects.list": () => ({ entries: [aHostedProject()], nextCursor: null }),
        "admin.projects.resources": () => [figures()],
      },
      admin
    );
    const table = await screen.findByRole("table", { name: copy.hosting.caption });
    const [row] = within(table).getAllByRole("row").slice(1);
    expect(await within(row).findByText("3.0 MiB")).toBeInTheDocument();
    expect(cellsOf(row)).toEqual([
      "Invoices",
      "Ada's bakery",
      copy.status.live.label,
      "8101",
      `${copy.project.buildStatus.passed}Nov 1, 2026`,
      "2",
      "3.0 MiB",
      "1.5%",
      "2.0 GiB",
    ]);
    expect(within(row).getByRole("link", { name: "Ada's bakery" })).toHaveAttribute(
      "href",
      "/admin/businesses/4"
    );
    expect(calls.find(({ path }) => path === "admin.projects.resources")?.input).toEqual({
      ids: [7],
    });
  });

  it("says unknown for figures that could not be read", async () => {
    renderWithApi(
      <AdminProjectsPage />,
      {
        "admin.projects.list": () => ({
          entries: [aHostedProject({ lastBuild: null })],
          nextCursor: null,
        }),
        "admin.projects.resources": () => [
          figures({ containers: null, memoryBytes: null, cpuPercent: null }),
        ],
      },
      admin
    );
    const table = await screen.findByRole("table");
    const [row] = within(table).getAllByRole("row").slice(1);
    expect(await within(row).findAllByText(copy.resources.unknown)).toHaveLength(3);
    expect(cellsOf(row)[4]).toBe(copy.hosting.neverBuilt);
  });

  it("says when nothing matches, and searches by what is typed", async () => {
    const calls = renderWithApi(
      <AdminProjectsPage />,
      { "admin.projects.list": () => ({ entries: [], nextCursor: null }) },
      admin
    );
    expect(await screen.findByText(copy.hosting.empty)).toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox"), "bakery");
    await userEvent.click(screen.getByRole("button", { name: copy.adminSearch.action }));
    await waitFor(() =>
      expect(
        calls.filter(({ path }) => path === "admin.projects.list").at(-1)?.input
      ).toMatchObject({ search: "bakery" })
    );
    // Nothing listed, nothing to read.
    expect(calls.filter(({ path }) => path === "admin.projects.resources")).toEqual([]);
  });
});

describe("AdminBusinessPage's resources", () => {
  const business = (projects: readonly { readonly id: number }[]) => () => ({
    business: { id: 4, name: "Ada's bakery", slug: "ada", createdAt: created },
    members: [],
    projects: projects.map(({ id }) => ({ id, name: `App ${id}`, status: "live" })),
  });
  const totals = async () =>
    within(await screen.findByRole("region", { name: copy.resources.title }));

  it("sums what its apps take up", async () => {
    renderWithApi(
      <AdminBusinessPage id={4} />,
      {
        "admin.businesses.get": business([{ id: 7 }, { id: 8 }]),
        "admin.projects.resources": () => [figures(), figures({ id: 8, containers: 1 })],
        "admin.usage.summary": noSummary,
      },
      admin
    );
    const region = await totals();
    expect(await region.findByText("6.0 MiB")).toBeInTheDocument();
    expect(region.getByText("3")).toBeInTheDocument();
    expect(region.getByText("4.0 GiB")).toBeInTheDocument();
  });

  it("says unknown rather than undercount when one app could not be read", async () => {
    renderWithApi(
      <AdminBusinessPage id={4} />,
      {
        "admin.businesses.get": business([{ id: 7 }, { id: 8 }]),
        "admin.projects.resources": () => [figures(), figures({ id: 8, memoryBytes: null })],
        "admin.usage.summary": noSummary,
      },
      admin
    );
    const region = await totals();
    expect(await region.findByText(copy.resources.unknown)).toBeInTheDocument();
    expect(region.getByText("4")).toBeInTheDocument();
  });
});

const spent = {
  inputTokens: 1200,
  outputTokens: 340,
  cacheReadTokens: 5000,
  cacheCreationTokens: 60,
  costUsd: 2.5,
};

const aSummary = (): UsageSummaryData => ({
  businesses: [
    { id: 4, name: "Ada's bakery", ...spent },
    { id: 5, name: "Bea's books", ...spent, costUsd: 0.25 },
  ],
  projects: [{ id: 7, name: "Invoices", business: { id: 4, name: "Ada's bakery" }, ...spent }],
  models: [{ model: "claude-opus", ...spent }],
  runKinds: [{ runKind: "change", ...spent }],
});

describe("AdminUsagePage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("asks for the current month in UTC, and shows businesses as the server orders them", async () => {
    const calls = renderWithApi(<AdminUsagePage />, { "admin.usage.summary": aSummary }, admin);
    const table = await screen.findByRole("table", { name: copy.usage.businessesCaption });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(cellsOf(rows[0])).toEqual(["Ada's bakery", "1,200", "340", "5,000", "60", "$2.50"]);
    expect(cellsOf(rows[1])[0]).toBe("Bea's books");
    expect(within(rows[0]).getByRole("link", { name: "Ada's bakery" })).toHaveAttribute(
      "href",
      "/admin/businesses/4"
    );
    expect(calls[0].input).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(screen.getByLabelText(copy.usage.from)).toHaveValue("2026-11-01");
    expect(screen.getByRole("table", { name: copy.usage.projectsCaption })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: copy.usage.modelsCaption })).toHaveTextContent(
      "claude-opus"
    );
    expect(screen.getByRole("table", { name: copy.usage.runKindsCaption })).toHaveTextContent(
      "change"
    );
    // The timezone, and what happens to a deleted app's usage, are said on the page.
    expect(screen.getByText(copy.usage.timezone)).toBeInTheDocument();
    expect(screen.getByText(copy.usage.deletedProjects)).toBeInTheDocument();
  });

  it("asks again for the period chosen", async () => {
    const calls = renderWithApi(<AdminUsagePage />, { "admin.usage.summary": aSummary }, admin);
    await screen.findByRole("table", { name: copy.usage.businessesCaption });
    fireEvent.change(screen.getByLabelText(copy.usage.from), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText(copy.usage.to), { target: { value: "2026-10-15" } });
    await waitFor(() =>
      expect(calls.at(-1)?.input).toEqual({ from: "2026-10-01", to: "2026-10-15" })
    );
  });

  it("says when nothing was used in the period", async () => {
    renderWithApi(<AdminUsagePage />, { "admin.usage.summary": noSummary }, admin);
    expect(await screen.findByText(copy.usage.empty)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("AdminBusinessPage's usage", () => {
  it("shows the business's totals over all time", async () => {
    const calls = renderWithApi(
      <AdminBusinessPage id={4} />,
      {
        "admin.businesses.get": () => ({
          business: { id: 4, name: "Ada's bakery", slug: "ada", createdAt: created },
          members: [],
          projects: [],
        }),
        "admin.usage.summary": () => ({ ...noSummary(), businesses: [aSummary().businesses[0]] }),
      },
      admin
    );
    const region = within(await screen.findByRole("region", { name: copy.project.usageTitle }));
    expect(await region.findByText("$2.50")).toBeInTheDocument();
    expect(region.getByText("1,200")).toBeInTheDocument();
    expect(calls.find(({ path }) => path === "admin.usage.summary")?.input).toEqual({
      tenantId: 4,
    });
  });
});
