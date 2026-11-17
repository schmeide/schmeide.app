import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { copy } from "../../data/copy";
import type { AuditEntry } from "../../trpc";
import type { Session } from "../../utils/session";
import { AdminAuditPage } from "../AdminAuditPage";
import { AdminPage } from "../AdminPage";
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
    ).toEqual([[copy.routes.adminAudit, "/admin/audit"]]);
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
