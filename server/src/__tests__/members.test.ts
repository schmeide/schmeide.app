import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import { approvedEmails, invites, memberships } from "../db/schema.ts";
import { BUSINESS_HEADER, type AppContext } from "../router.ts";
import { approveEmail, isApproved, removeApproval } from "../services/access.ts";
import { createProject } from "../services/projects.ts";
import {
  anEmail,
  aSignedInPerson,
  callApi,
  PASSWORD,
  procedurePaths,
  signIn,
  testAuth,
} from "./testAuth.ts";

const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());

const deps: AppContext = {
  db,
  workflows: { start: vi.fn(), getHandle: vi.fn() as never },
  taskQueue: "test",
  interviewer: vi.fn(),
  siteFetcher: vi.fn(),
  websiteReader: vi.fn(),
  files: {} as never,
  reader: vi.fn(),
  resources: {} as never,
  auth: testAuth(db),
  providers: [],
};
const app = buildApp(deps);
afterAll(() => app.close());

type Member = {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly role: "owner" | "editor";
  readonly isYou: boolean;
};
type Someone = { readonly email: string; readonly cookie: string; readonly tenantId: number };

const inBusiness = (tenantId: number) => ({ [BUSINESS_HEADER]: String(tenantId) });
const call = (who: Someone, path: string, input?: unknown, tenantId = who.tenantId) =>
  callApi(app, path, input, who.cookie, inBusiness(tenantId));
const business = async (who: Someone, tenantId = who.tenantId) =>
  (await call(who, "business.get", undefined, tenantId)).data;
const memberOf = async (who: Someone, email: string): Promise<Member> => {
  const { members } = await business(who);
  return members.find((member: Member) => member.email === email);
};
const roles = async (who: Someone) =>
  Object.fromEntries(
    (await business(who)).members.map((member: Member) => [member.email, member.role])
  );
const businessIds = async (who: Someone): Promise<readonly number[]> =>
  (await callApi(app, "session.get", undefined, who.cookie)).data.businesses.map(
    (each: { readonly id: number }) => each.id
  );
const tenantOfApproval = async (email: string) =>
  (await db.select().from(approvedEmails).where(eq(approvedEmails.email, email)))[0]?.tenantId;

const anOwner = (name = "Olive Owner") => aSignedInPerson(app, deps, { name });
const anEditorOf = (owner: Someone, name = "Eddie Editor") =>
  aSignedInPerson(app, deps, { name, joins: owner.tenantId });
const invited = async (owner: Someone, email = anEmail()) =>
  (await call(owner, "business.invite", { email })).data as {
    readonly email: string;
    readonly token: string;
  };

const OWNER_ONLY = [
  "business.update",
  "business.invite",
  "business.reissueInvitation",
  "business.withdrawInvitation",
  "business.removeMember",
  "business.setRole",
  "business.transferOwnership",
];

describe("the business a person works in", () => {
  it("shows an owner its name, country, members, and waiting invitations", async () => {
    const owner = await anOwner();
    const { email } = await invited(owner);
    expect(await business(owner)).toMatchObject({
      id: owner.tenantId,
      name: "Olive Owner’s business",
      country: null,
      role: "owner",
      members: [{ name: "Olive Owner", email: owner.email, role: "owner", isYou: true }],
      invitations: [{ email, expired: false }],
    });
  });

  it("shows an editor the members, but not the invitations", async () => {
    const owner = await anOwner();
    const editor = await anEditorOf(owner);
    await invited(owner);
    const seen = await business(editor);
    expect(seen.role).toBe("editor");
    expect(seen.members.map((member: Member) => [member.email, member.role, member.isYou])).toEqual(
      [
        [owner.email, "owner", false],
        [editor.email, "editor", true],
      ]
    );
    expect(seen.invitations).toEqual([]);
  });

  it("takes a new name and country from an owner, and only a real country", async () => {
    const owner = await anOwner();
    const saved = await call(owner, "business.update", { name: " Olive & Sons ", country: "DE" });
    expect(saved.data).toEqual({ id: owner.tenantId, name: "Olive & Sons", country: "DE" });
    const session = await callApi(app, "session.get", undefined, owner.cookie);
    expect(session.data.businesses).toEqual([
      { id: owner.tenantId, name: "Olive & Sons", suspended: false },
    ]);

    for (const input of [
      { name: "Olive", country: "ZZ" },
      { name: "Olive", country: "de" },
      { name: "  ", country: "DE" },
    ])
      expect((await call(owner, "business.update", input)).code).toBe("BAD_REQUEST");
    expect((await call(owner, "business.update", { name: "Olive", country: null })).data).toEqual({
      id: owner.tenantId,
      name: "Olive",
      country: null,
    });
  });
});

describe("an owner-only procedure", () => {
  it("is every business procedure but reading it and leaving it", () => {
    expect(
      procedurePaths
        .filter((path) => path.startsWith("business."))
        .filter((path) => !["business.get", "business.leave"].includes(path))
        .sort()
    ).toEqual([...OWNER_ONLY].sort());
  });

  it("answers FORBIDDEN to an editor, and changes nothing", async () => {
    const owner = await anOwner();
    const editor = await anEditorOf(owner);
    const waitingEmail = (await invited(owner)).email;
    const { userId } = await memberOf(owner, owner.email);
    const before = await business(owner);
    const calls: Readonly<Record<string, unknown>> = {
      "business.update": { name: "Taken over", country: "DE" },
      "business.invite": { email: anEmail() },
      "business.reissueInvitation": { email: waitingEmail },
      "business.withdrawInvitation": { email: waitingEmail },
      "business.removeMember": { userId },
      "business.setRole": { userId, role: "editor" },
      "business.transferOwnership": { userId: (await memberOf(owner, editor.email)).userId },
    };
    for (const path of OWNER_ONLY)
      expect([path, (await call(editor, path, calls[path])).code]).toEqual([path, "FORBIDDEN"]);
    expect((await call(editor, "business.update", calls["business.update"])).message).toContain(
      "Ask an owner"
    );
    expect(await business(owner)).toEqual(before);
  });
});

describe("a person from another business", () => {
  it("can neither see nor change this one, even when they name it", async () => {
    const owner = await anOwner();
    const editor = await anEditorOf(owner);
    const waitingEmail = (await invited(owner)).email;
    const ownerId = (await memberOf(owner, owner.email)).userId;
    const editorId = (await memberOf(owner, editor.email)).userId;
    const before = await business(owner);
    const mallory = await anOwner("Mallory");

    const seen = await business(mallory, owner.tenantId);
    expect(seen.id).toBe(mallory.tenantId);
    expect(JSON.stringify(seen)).not.toContain(owner.email);

    const calls: readonly (readonly [string, unknown])[] = [
      ["business.reissueInvitation", { email: waitingEmail }],
      ["business.withdrawInvitation", { email: waitingEmail }],
      ["business.removeMember", { userId: editorId }],
      ["business.setRole", { userId: editorId, role: "owner" }],
      ["business.setRole", { userId: ownerId, role: "editor" }],
      ["business.transferOwnership", { userId: editorId }],
    ];
    for (const [path, input] of calls)
      expect([path, (await call(mallory, path, input, owner.tenantId)).code]).toEqual([
        path,
        "NOT_FOUND",
      ]);
    await call(
      mallory,
      "business.update",
      { name: "Mallory’s now", country: "FR" },
      owner.tenantId
    );
    expect((await call(mallory, "business.leave", undefined, owner.tenantId)).code).toBe(
      "CONFLICT"
    );
    expect(await business(owner)).toEqual(before);
    expect((await business(mallory)).name).toBe("Mallory’s now");
  });
});

describe("an invitation", () => {
  it("lets a new person open an account as an editor of the business, once", async () => {
    const owner = await anOwner();
    const { email, token } = await invited(owner, ` ${anEmail().toUpperCase()} `);
    expect(email).toBe(email.toLowerCase().trim());
    expect((await callApi(app, "invites.get", { token })).data).toEqual({
      email,
      hasAccount: false,
      business: "Olive Owner’s business",
    });

    await callApi(app, "invites.accept", { token, name: "Nia New", password: PASSWORD });
    const { cookie } = await signIn(app, email);
    const nia = { email, cookie, tenantId: owner.tenantId };
    expect(await businessIds(nia)).toEqual([owner.tenantId]);
    expect(await roles(owner)).toEqual({ [owner.email]: "owner", [email]: "editor" });
    expect((await business(owner)).invitations).toEqual([]);
    expect((await callApi(app, "invites.get", { token })).code).toBe("NOT_FOUND");
  });

  it("cannot be made twice for one address, for a member, or for something that is no address", async () => {
    const owner = await anOwner();
    const editor = await anEditorOf(owner);
    const { email } = await invited(owner);
    expect((await call(owner, "business.invite", { email })).code).toBe("CONFLICT");
    const member = await call(owner, "business.invite", { email: editor.email });
    expect(member.code).toBe("CONFLICT");
    expect(member.message).toContain("Reload the page");
    expect((await call(owner, "business.invite", { email: owner.email })).code).toBe("CONFLICT");
    expect((await call(owner, "business.invite", { email: "not an address" })).code).toBe(
      "BAD_REQUEST"
    );
    expect((await business(owner)).invitations).toHaveLength(1);
  });

  it("gets a fresh link when made again, and the old link stops working", async () => {
    const owner = await anOwner();
    const first = await invited(owner);
    const second = await call(owner, "business.reissueInvitation", { email: first.email });
    expect(second.data.token).not.toBe(first.token);
    expect((await callApi(app, "invites.get", { token: first.token })).code).toBe("NOT_FOUND");
    expect((await callApi(app, "invites.get", { token: second.data.token })).data.email).toBe(
      first.email
    );
    expect((await business(owner)).invitations).toHaveLength(1);
    expect((await call(owner, "business.reissueInvitation", { email: anEmail() })).code).toBe(
      "NOT_FOUND"
    );
  });

  it("shows as expired after 7 days, until a new link is made", async () => {
    const owner = await anOwner();
    const { email, token } = await invited(owner);
    await db
      .update(invites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invites.email, email));
    expect((await business(owner)).invitations).toMatchObject([{ email, expired: true }]);
    expect((await callApi(app, "invites.get", { token })).code).toBe("NOT_FOUND");
    await call(owner, "business.reissueInvitation", { email });
    expect((await business(owner)).invitations).toMatchObject([{ email, expired: false }]);
  });

  it("is gone when withdrawn, and so is the approval it gave a person with no account", async () => {
    const owner = await anOwner();
    const { email, token } = await invited(owner);
    expect(await isApproved(db, email)).toBe(true);
    expect((await call(owner, "business.withdrawInvitation", { email })).status).toBe(200);
    expect((await callApi(app, "invites.get", { token })).code).toBe("NOT_FOUND");
    expect(await isApproved(db, email)).toBe(false);
    expect((await business(owner)).invitations).toEqual([]);
    expect((await call(owner, "business.withdrawInvitation", { email })).code).toBe("NOT_FOUND");
    expect((await invited(owner, email)).email).toBe(email);
  });

  it("keeps an approval that we gave ourselves when it is withdrawn", async () => {
    const owner = await anOwner();
    const ours = await approveEmail(db, anEmail());
    await invited(owner, ours.email);
    await call(owner, "business.withdrawInvitation", { email: ours.email });
    expect(await isApproved(db, ours.email)).toBe(true);
    expect((await callApi(app, "invites.get", { token: ours.token })).data).toMatchObject({
      business: null,
    });
  });

  it("joins the business when the invited person first signs in another way", async () => {
    const owner = await anOwner();
    const { email } = await invited(owner);
    const ours = await approveEmail(db, email);
    await callApi(app, "invites.accept", { token: ours.token, name: "Nia", password: PASSWORD });
    const { cookie } = await signIn(app, email);
    expect(await businessIds({ email, cookie, tenantId: owner.tenantId })).toEqual([
      owner.tenantId,
    ]);
    expect((await business(owner)).invitations).toEqual([]);
    expect(await roles(owner)).toMatchObject({ [email]: "editor" });
  });

  it("cannot bring back an address that was taken off the approved list", async () => {
    const owner = await anOwner();
    const gone = await anOwner("Gone Person");
    await removeApproval(db, gone.email);
    expect((await call(owner, "business.invite", { email: gone.email })).code).toBe("CONFLICT");
    expect(await isApproved(db, gone.email)).toBe(false);
    expect((await business(owner)).invitations).toEqual([]);
  });
});

describe("an invitation for a person who already has an account", () => {
  it("shows the owner nothing about them, and changes nothing for them, until they join", async () => {
    const owner = await anOwner();
    const bookkeeper = await anOwner("Bea Bookkeeper");
    const fresh = await invited(owner);
    const theirs = await invited(owner, bookkeeper.email);
    expect(Object.keys(theirs).sort()).toEqual(Object.keys(fresh).sort());
    expect(JSON.stringify(await business(owner))).not.toContain("Bea Bookkeeper");
    expect((await business(owner)).members).toHaveLength(1);
    expect(await businessIds(bookkeeper)).toEqual([bookkeeper.tenantId]);
    expect(await tenantOfApproval(bookkeeper.email)).toBeNull();
  });

  it("never sets a password: the link cannot be used to take the account over", async () => {
    const owner = await anOwner();
    const bookkeeper = await anOwner("Bea Bookkeeper");
    const { token } = await invited(owner, bookkeeper.email);
    const taken = await callApi(app, "invites.accept", {
      token,
      name: "Mallory",
      password: "a password of the owner",
    });
    expect(taken.code).toBe("CONFLICT");
    expect((await signIn(app, bookkeeper.email, "a password of the owner")).status).toBe(401);
    expect((await signIn(app, bookkeeper.email)).status).toBe(200);
    expect(await businessIds(bookkeeper)).toEqual([bookkeeper.tenantId]);
    expect((await callApi(app, "invites.get", { token })).data).toEqual({
      email: bookkeeper.email,
      hasAccount: true,
      business: "Olive Owner’s business",
    });
  });

  it("is accepted only by that person, signed in, and adds the business beside their own", async () => {
    const owner = await anOwner();
    const bookkeeper = await anOwner("Bea Bookkeeper");
    const mallory = await anOwner("Mallory");
    const { token } = await invited(owner, bookkeeper.email);

    expect((await callApi(app, "invites.join", { token })).code).toBe("UNAUTHORIZED");
    expect((await call(mallory, "invites.join", { token })).code).toBe("NOT_FOUND");
    expect(await businessIds(mallory)).toEqual([mallory.tenantId]);

    const joined = await call(bookkeeper, "invites.join", { token });
    expect(joined.data).toEqual({ businessId: owner.tenantId });
    expect(await businessIds(bookkeeper)).toEqual([bookkeeper.tenantId, owner.tenantId]);
    expect(await roles(owner)).toEqual({ [owner.email]: "owner", [bookkeeper.email]: "editor" });
    expect((await business(bookkeeper)).role).toBe("owner");
    expect((await call(bookkeeper, "invites.join", { token })).code).toBe("NOT_FOUND");
  });

  it("is not a way to join with a plain set-password link", async () => {
    const person = await anOwner();
    const { token } = await approveEmail(db, person.email);
    expect((await call(person, "invites.join", { token })).code).toBe("NOT_FOUND");
  });
});

describe("an address another business has already invited", () => {
  it("is invited here the same way, and nothing of the other business moves or shows", async () => {
    const first = await anOwner("First Owner");
    const second = await anOwner("Second Owner");
    const fresh = await invited(second);
    const theirs = await invited(first);
    const ours = await call(second, "business.invite", { email: theirs.email });

    expect(ours.status).toBe(200);
    expect(Object.keys(ours.data).sort()).toEqual(Object.keys(fresh).sort());
    expect(JSON.stringify(await business(second))).not.toContain("First Owner");
    expect(await tenantOfApproval(theirs.email)).toBe(first.tenantId);
    expect((await business(first)).invitations).toMatchObject([{ email: theirs.email }]);
    expect((await callApi(app, "invites.get", { token: theirs.token })).data).toMatchObject({
      business: "First Owner’s business",
    });

    await call(second, "business.withdrawInvitation", { email: theirs.email });
    expect(await tenantOfApproval(theirs.email)).toBe(first.tenantId);
    expect((await callApi(app, "invites.get", { token: theirs.token })).data).toBeDefined();
    expect((await business(first)).invitations).toHaveLength(1);
  });

  it("stays approved for the business still waiting when the first one withdraws", async () => {
    const first = await anOwner("First Owner");
    const second = await anOwner("Second Owner");
    const theirs = await invited(first);
    const ours = await invited(second, theirs.email);
    await call(first, "business.withdrawInvitation", { email: theirs.email });

    expect(await tenantOfApproval(theirs.email)).toBe(second.tenantId);
    await callApi(app, "invites.accept", { token: ours.token, name: "Nia", password: PASSWORD });
    const { cookie } = await signIn(app, ours.email);
    expect(await businessIds({ email: ours.email, cookie, tenantId: second.tenantId })).toEqual([
      second.tenantId,
    ]);
    expect((await business(first)).members).toHaveLength(1);
  });
});

describe("a member", () => {
  it("who is removed loses the business at once, and keeps their own", async () => {
    const owner = await anOwner();
    const bookkeeper = await anOwner("Bea Bookkeeper");
    const { token } = await invited(owner, bookkeeper.email);
    await call(bookkeeper, "invites.join", { token });
    const project = await createProject(db, { name: "Invoices", tenantId: owner.tenantId });
    expect(
      (await call(bookkeeper, "projects.get", { id: project.id }, owner.tenantId)).status
    ).toBe(200);

    const { userId } = await memberOf(owner, bookkeeper.email);
    expect((await call(owner, "business.removeMember", { userId })).status).toBe(200);

    expect(await roles(owner)).toEqual({ [owner.email]: "owner" });
    expect(await businessIds(bookkeeper)).toEqual([bookkeeper.tenantId]);
    expect((await call(bookkeeper, "projects.get", { id: project.id }, owner.tenantId)).code).toBe(
      "NOT_FOUND"
    );
    expect((await business(bookkeeper, owner.tenantId)).id).toBe(bookkeeper.tenantId);
    expect((await call(owner, "business.removeMember", { userId })).code).toBe("NOT_FOUND");
  });

  it("whose only business it was is left with none to set up, not this one back", async () => {
    const owner = await anOwner();
    const editor = await anEditorOf(owner);
    const { userId } = await memberOf(owner, editor.email);
    await call(owner, "business.removeMember", { userId });
    expect(await businessIds(editor)).toEqual([]);
    expect((await business(owner)).members).toHaveLength(1);
  });

  it("who is the only owner cannot be removed, made an editor, or leave", async () => {
    const owner = await anOwner();
    const editor = await anEditorOf(owner);
    const { userId } = await memberOf(owner, owner.email);
    const before = await business(owner);
    expect((await call(owner, "business.removeMember", { userId })).code).toBe("CONFLICT");
    expect((await call(owner, "business.setRole", { userId, role: "editor" })).code).toBe(
      "CONFLICT"
    );
    expect((await call(owner, "business.leave")).code).toBe("CONFLICT");
    expect((await call(owner, "business.transferOwnership", { userId })).code).toBe("CONFLICT");
    expect(await business(owner)).toEqual(before);
    expect((await business(editor)).role).toBe("editor");
  });

  it("can be made an owner, after which the first owner may step down or leave", async () => {
    const owner = await anOwner();
    const editor = await anEditorOf(owner);
    const editorId = (await memberOf(owner, editor.email)).userId;
    const ownerId = (await memberOf(owner, owner.email)).userId;
    await call(owner, "business.setRole", { userId: editorId, role: "owner" });
    expect(await roles(owner)).toEqual({ [owner.email]: "owner", [editor.email]: "owner" });

    expect(
      (await call(editor, "business.setRole", { userId: ownerId, role: "editor" })).status
    ).toBe(200);
    expect((await call(owner, "business.update", { name: "No", country: null })).code).toBe(
      "FORBIDDEN"
    );
    expect((await call(owner, "business.leave")).status).toBe(200);
    expect(await roles(editor)).toEqual({ [editor.email]: "owner" });
    expect(await businessIds(owner)).not.toContain(editor.tenantId);
  });

  it("is handed the business: they become an owner and the one who handed it an editor", async () => {
    const owner = await anOwner();
    const editor = await anEditorOf(owner);
    const { userId } = await memberOf(owner, editor.email);
    expect((await call(owner, "business.transferOwnership", { userId })).status).toBe(200);
    expect(await roles(owner)).toEqual({ [owner.email]: "editor", [editor.email]: "owner" });
    expect((await call(owner, "business.transferOwnership", { userId })).code).toBe("FORBIDDEN");
    expect(
      (await call(editor, "business.transferOwnership", { userId: "no-such-person" })).code
    ).toBe("NOT_FOUND");
  });

  it("who is an editor can leave", async () => {
    const owner = await anOwner();
    const editor = await anEditorOf(owner);
    expect((await call(editor, "business.leave")).status).toBe(200);
    expect(await roles(owner)).toEqual({ [owner.email]: "owner" });
  });

  it("is never left without an owner when two owners step each other down at once", async () => {
    const owner = await anOwner();
    const editor = await anEditorOf(owner);
    const editorId = (await memberOf(owner, editor.email)).userId;
    const ownerId = (await memberOf(owner, owner.email)).userId;
    await call(owner, "business.setRole", { userId: editorId, role: "owner" });
    const answers = await Promise.all([
      call(owner, "business.setRole", { userId: editorId, role: "editor" }),
      call(editor, "business.setRole", { userId: ownerId, role: "editor" }),
      call(owner, "business.leave"),
      call(editor, "business.leave"),
    ]);
    expect(answers.map((answer) => answer.status)).toContain(200);
    const owners = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.tenantId, owner.tenantId), eq(memberships.role, "owner")));
    expect(owners).toHaveLength(1);
  });
});
