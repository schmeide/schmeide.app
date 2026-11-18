import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { App } from "../../App";
import { copy } from "../../data/copy";
import { IDEA_MAX, readCarried, writeCarried } from "../../utils/carried";
import { signedOut, type Session } from "../../utils/session";
import { Routes } from "../Routes";
import { aQuestion, anInterview, aProject, authServer, renderWithApi } from "./fakeApi";

// The real plan list is empty until #119, so these tests give the route helpers two fixture ids.
const PLANS = ["starter", "business"];
vi.mock("../../utils/routes", async (original) => {
  const real = await original<typeof import("../../utils/routes")>();
  return {
    ...real,
    planFrom: (search: string) => real.planFrom(search, PLANS),
    carryPlan: (path: string, search: string) => real.carryPlan(path, search, PLANS),
    guard: (...[route, session, location]: Parameters<typeof real.guard>) =>
      real.guard(route, session, location, PLANS),
    goTo: (
      session: Parameters<typeof real.goTo>[0],
      location: Parameters<typeof real.goTo>[1],
      signUpOpen?: boolean,
      known?: readonly string[]
    ) => real.goTo(session, location, signUpOpen, known ?? PLANS),
  };
});

const leaveTo = vi.hoisted(() => vi.fn());
vi.mock("../../utils/navigation", async (original) => ({
  ...(await original<typeof import("../../utils/navigation")>()),
  leaveTo,
}));

const person = { name: "Ada Lovelace", email: "ada@example.com" };
const owner: Session = { person, businesses: [{ id: 1, name: "Ada's bakery" }] };
const newcomer: Session = { person, businesses: [] };
const IDEA = "track the ovens";
const handlers = {
  "projects.list": () => [],
  "projects.create": (input: Readonly<Record<string, unknown>>) =>
    aProject({ id: 12, need: String(input.need) }),
  "interview.start": () => anInterview({ current: aQuestion() }),
};

const arrive = (path: string, session: Session) => {
  window.history.replaceState(null, "", path);
  return renderWithApi(<Routes />, handlers, session);
};

const address = () => window.location.pathname + window.location.search + window.location.hash;

describe("/go", () => {
  afterEach(() => {
    leaveTo.mockReset();
  });

  it("sends a signed-out person to sign-in, keeping plan and intent inside next and the idea out of every URL", async () => {
    arrive(`/go?plan=starter&intent=describe#idea=${encodeURIComponent(IDEA)}`, signedOut);

    await waitFor(() =>
      expect(address()).toBe(
        `/sign-in?next=${encodeURIComponent("/go?plan=starter&intent=describe")}`
      )
    );
    expect(readCarried()).toBe(IDEA);
    expect(address()).not.toContain("ovens");
    expect(screen.queryByRole("heading", { name: copy.routes.go })).toBeNull();
    expect(
      await screen.findByRole("heading", { level: 1, name: copy.routes.signIn })
    ).toBeVisible();
  });

  it("sends a signed-in person with no business to first-run, and still holds the idea", async () => {
    arrive(`/go?plan=business&intent=pricing#idea=${encodeURIComponent(IDEA)}`, newcomer);

    await waitFor(() =>
      expect(address()).toBe(
        `/welcome?next=${encodeURIComponent("/go?plan=business&intent=pricing")}`
      )
    );
    expect(readCarried()).toBe(IDEA);
    expect(address()).not.toContain("ovens");
  });

  it("opens /new with the idea filled in for someone who already has a business, and does not create an app", async () => {
    const calls = arrive(`/go?plan=starter#idea=${encodeURIComponent(IDEA)}`, owner);

    await waitFor(() => expect(window.location.pathname).toBe("/new"));
    expect(window.location.hash).toBe("");
    expect(await screen.findByRole("textbox", { name: copy.start.title })).toHaveValue(IDEA);
    expect(calls.map((call) => call.path)).not.toContain("projects.create");
    expect(JSON.stringify(calls)).not.toContain("ovens");
  });

  it("goes home when a business arrives with a plan and no idea", async () => {
    arrive("/go?plan=starter&intent=pricing", owner);
    await waitFor(() => expect(address()).toBe("/"));
  });

  it("goes home when a business arrives with nothing carried", async () => {
    arrive("/go", owner);
    await waitFor(() => expect(address()).toBe("/"));
  });

  it("drops an unknown plan, an unknown intent, and an idea over the limit, and still forwards", async () => {
    arrive(`/go?plan=enterprise&intent=hack#idea=${"a".repeat(IDEA_MAX + 1)}`, signedOut);

    await waitFor(() => expect(address()).toBe("/sign-in?next=%2Fgo"));
    expect(readCarried()).toBeNull();
    expect(window.location.hash).toBe("");
  });

  it("replaces /go, so Back does not return to it", async () => {
    window.history.replaceState(null, "", "/help");
    window.history.pushState(null, "", "/go?intent=describe");
    renderWithApi(<Routes />, handlers, signedOut);

    await waitFor(() => expect(window.location.pathname).toBe("/sign-in"));
    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe("/help"));
  });

  it("keeps the plan inside the provider return address and never puts the idea there", async () => {
    window.history.replaceState(
      null,
      "",
      `/go?plan=starter&intent=describe#idea=${encodeURIComponent(IDEA)}`
    );
    const { handlers: auth, requests } = authServer({
      session: signedOut,
      providers: ["google"],
    });
    renderWithApi(<App isPublicSite={false} />, { ...handlers, ...auth }, "server");

    await userEvent.click(
      await screen.findByRole("button", { name: copy.signInPage.provider.google })
    );
    await waitFor(() => expect(leaveTo).toHaveBeenCalled());
    const body = requests[0]?.body;
    expect(body).toMatchObject({
      callbackURL: `${window.location.origin}/go?plan=starter&intent=describe`,
      errorCallbackURL: `${window.location.origin}/sign-in?next=${encodeURIComponent("/go?plan=starter&intent=describe")}`,
    });
    expect(JSON.stringify(body)).not.toContain("ovens");
    expect(readCarried()).toBe(IDEA);
    expect(window.location.hash).toBe("");
  });

  it("still has the idea after the set-password link and fills /new, without creating an app", async () => {
    writeCarried(IDEA);
    const password = "correct horse battery";
    window.history.replaceState(
      null,
      "",
      `/set-password?token=abc&next=${encodeURIComponent("/go?plan=starter&intent=sign-in")}`
    );
    const { handlers: auth } = authServer({
      session: signedOut,
      account: { ...owner, password },
    });
    const calls = renderWithApi(
      <App isPublicSite={false} />,
      {
        ...handlers,
        ...auth,
        "invites.get": () => ({ email: person.email, hasAccount: true }),
        "invites.accept": () => ({ email: person.email }),
      },
      "server"
    );
    await userEvent.type(
      await screen.findByLabelText(copy.setPasswordPage.passwordLabel),
      password
    );
    await userEvent.type(screen.getByLabelText(copy.setPasswordPage.confirmLabel), password);
    await userEvent.click(screen.getByRole("button", { name: copy.setPasswordPage.action }));

    expect(await screen.findByRole("textbox", { name: copy.start.title })).toHaveValue(IDEA);
    expect(window.location.pathname).toBe("/new");
    expect(window.location.hash).toBe("");
    expect(readCarried()).toBe(IDEA);
    expect(JSON.stringify(calls)).not.toContain("ovens");
    expect(calls.map((call) => call.path)).not.toContain("projects.create");
  });
});
