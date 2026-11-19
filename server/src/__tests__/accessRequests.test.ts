import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import { accessRequests } from "../db/schema.ts";
import type { AppContext } from "../router.ts";
import { approveAccess } from "../services/access.ts";
import {
  ACCESS_BUSINESS_MAX,
  ACCESS_MESSAGE_MAX,
  ACCESS_NAME_MAX,
  ACCESS_REQUEST_LIMITS,
  ACCESS_REQUEST_PATH,
  MARKETING_ORIGIN,
  declineAccessRequest,
  submitAccessRequest,
  type AccessRequestInput,
} from "../services/accessRequests.ts";
import { COMMAND_LINE, withAudit } from "../services/audit.ts";
import { isApproved } from "../services/access.ts";
import { aSignedInPerson, anEmail, testAuth } from "./testAuth.ts";

const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());

const APP_ORIGIN = "https://schmeide.app";
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
const app = buildApp(deps, { allowOrigin: APP_ORIGIN });
afterAll(() => app.close());

const MARKETING = MARKETING_ORIGIN;
let addressCount = 0;
const nextAddress = () => `198.51.100.${(addressCount += 1)}-${randomUUID()}`;

const requestFor = (email: string, over: Partial<AccessRequestInput> = {}): AccessRequestInput => ({
  name: "Ada Lovelace",
  email,
  business: "Analytical Engines",
  who: "owner",
  message: "A short note",
  ...over,
});

const post = (
  body: object,
  headers: Readonly<Record<string, string>> = {},
  address = nextAddress()
) =>
  app.inject({
    method: "POST",
    url: ACCESS_REQUEST_PATH,
    headers: {
      origin: MARKETING,
      "content-type": "application/json",
      "x-forwarded-for": address,
      ...headers,
    },
    payload: body,
  });

const rowFor = async (email: string) => {
  const [row] = await db.select().from(accessRequests).where(eq(accessRequests.email, email));
  return row;
};

describe("a public access request", () => {
  it("refuses a request from any origin but the marketing site", async () => {
    const email = anEmail();
    for (const origin of [
      "https://evil.example",
      "https://schmeide.com.evil.example",
      "http://schmeide.com",
      "https://www.schmeide.com",
      APP_ORIGIN,
      "null",
    ]) {
      const response = await post(requestFor(email), { origin });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ ok: false });
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
    }
    expect(await rowFor(email)).toBeUndefined();

    const asked = await app.inject({
      method: "OPTIONS",
      url: ACCESS_REQUEST_PATH,
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(asked.statusCode).not.toBe(204);
    expect(asked.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows the marketing site on this request only, without the session cookie", async () => {
    const allowed = await app.inject({
      method: "OPTIONS",
      url: ACCESS_REQUEST_PATH,
      headers: {
        origin: MARKETING,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe(MARKETING);
    expect(allowed.headers["access-control-allow-methods"]).toContain("POST");
    expect(allowed.headers["access-control-allow-headers"]).toContain("content-type");
    expect(allowed.headers["access-control-allow-credentials"]).toBeUndefined();

    const elsewhere = await app.inject({
      method: "GET",
      url: "/trpc/session.get",
      headers: { origin: MARKETING },
    });
    expect(elsewhere.headers["access-control-allow-origin"]).toBeUndefined();

    const appSite = await app.inject({
      method: "GET",
      url: "/trpc/session.get",
      headers: { origin: APP_ORIGIN },
    });
    expect(appSite.headers["access-control-allow-origin"]).toBe(APP_ORIGIN);
    expect(appSite.headers["access-control-allow-credentials"]).toBe("true");

    const email = anEmail();
    const withCookie = await post(requestFor(email), {
      cookie: "schmeide.session_token=not-a-session",
    });
    const without = await post(requestFor(anEmail()));
    expect(withCookie.statusCode).toBe(200);
    expect(withCookie.body).toBe(without.body);
    expect(withCookie.headers["set-cookie"]).toBeUndefined();
    expect(withCookie.headers["access-control-allow-origin"]).toBe(MARKETING);
    expect(withCookie.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(await rowFor(email)).toMatchObject({ email, state: "waiting" });
  });

  it("answers the same way for a new email, a known one, an approved one, and an account", async () => {
    const freshEmail = anEmail();
    const fresh = await post(requestFor(freshEmail));
    const again = await post(requestFor(freshEmail, { name: "Ada Again", message: "Updated" }));

    const approvedEmail = anEmail();
    await withAudit(db, COMMAND_LINE, "access.approve", (tx, audit) =>
      approveAccess(tx, audit, approvedEmail)
    );
    const approved = await post(requestFor(approvedEmail));

    const person = await aSignedInPerson(app, deps);
    const account = await post(requestFor(person.email), { cookie: person.cookie });

    expect(fresh.statusCode).toBe(200);
    expect(fresh.json()).toEqual({ ok: true });
    for (const response of [again, approved, account]) {
      expect(response.statusCode).toBe(fresh.statusCode);
      expect(response.body).toBe(fresh.body);
      expect(response.headers["access-control-allow-origin"]).toBe(
        fresh.headers["access-control-allow-origin"]
      );
    }
    expect(await rowFor(freshEmail)).toMatchObject({
      name: "Ada Again",
      message: "Updated",
      state: "waiting",
    });
    expect(await rowFor(approvedEmail)).toMatchObject({ state: "approved" });
    expect(await rowFor(person.email)).toMatchObject({ state: "approved" });
    expect(
      await db.select().from(accessRequests).where(eq(accessRequests.email, freshEmail))
    ).toHaveLength(1);
  });

  it("keeps one row per email and does not store a filled hidden field", async () => {
    const email = anEmail();
    expect((await post(requestFor(email, { website: "" }))).statusCode).toBe(200);
    expect(
      (await post(requestFor(email, { who: "investor", business: "A fund" }))).statusCode
    ).toBe(200);
    const [row] = await db.select().from(accessRequests).where(eq(accessRequests.email, email));
    expect(row).toMatchObject({ who: "investor", business: "A fund", state: "waiting" });

    const hidden = anEmail();
    const decoy = await post(requestFor(hidden, { website: "http://spam.test" }));
    const real = await post(requestFor(anEmail(), { website: "   " }));
    expect(decoy.statusCode).toBe(real.statusCode);
    expect(decoy.body).toBe(real.body);
    expect(await rowFor(hidden)).toBeUndefined();

    await declineAccessRequest(db, email);
    expect((await post(requestFor(email, { name: "Ada Returned" }))).statusCode).toBe(200);
    expect(await rowFor(email)).toMatchObject({ name: "Ada Returned", state: "waiting" });

    await withAudit(db, COMMAND_LINE, "access.approve", (tx, audit) =>
      approveAccess(tx, audit, email)
    );
    expect((await post(requestFor(email, { name: "Still Ada" }))).statusCode).toBe(200);
    expect(await rowFor(email)).toMatchObject({ name: "Still Ada", state: "approved" });
  });

  it("holds the limits, and a refused field is the same for a new email and a known one", async () => {
    const email = anEmail();
    const address = nextAddress();
    const body = requestFor(email);
    for (let i = 0; i < ACCESS_REQUEST_LIMITS.perEmail; i++)
      expect((await post(body, {}, address)).statusCode).toBe(200);
    const overEmail = await post(requestFor(email, { name: "Once more" }), {}, address);
    expect(overEmail.statusCode).toBe(429);
    expect(overEmail.json()).toEqual({ ok: false });
    expect(await rowFor(email)).toMatchObject({ name: "Ada Lovelace" });
    expect((await post(requestFor(anEmail()))).statusCode).toBe(200);

    const shared = nextAddress();
    for (let i = 0; i < ACCESS_REQUEST_LIMITS.perAddress; i++)
      expect((await post(requestFor(anEmail()), {}, shared)).statusCode).toBe(200);
    const overAddress = await post(requestFor(anEmail()), {}, shared);
    expect(overAddress.statusCode).toBe(429);
    expect(overAddress.body).toBe(overEmail.body);
    expect((await post(requestFor(anEmail()))).statusCode).toBe(200);

    const hidden = nextAddress();
    for (let i = 0; i < ACCESS_REQUEST_LIMITS.perAddress; i++)
      expect(
        (await post(requestFor(anEmail(), { website: "http://spam.test" }), {}, hidden)).statusCode
      ).toBe(200);
    expect(
      (await post(requestFor(anEmail(), { website: "http://spam.test" }), {}, hidden)).statusCode
    ).toBe(429);
    expect(
      await db.select().from(accessRequests).where(eq(accessRequests.business, "http://spam.test"))
    ).toEqual([]);

    const known = anEmail();
    await post(requestFor(known));
    const tooLong = {
      ...requestFor(anEmail()),
      name: "n".repeat(ACCESS_NAME_MAX + 1),
      business: "b".repeat(ACCESS_BUSINESS_MAX + 1),
      message: "m".repeat(ACCESS_MESSAGE_MAX + 1),
      who: "friend",
    };
    const forNew = await post(tooLong);
    const forKnown = await post({ ...tooLong, email: known });
    expect(forNew.statusCode).toBe(400);
    expect(forNew.json()).toEqual({ ok: false });
    expect(forKnown.statusCode).toBe(forNew.statusCode);
    expect(forKnown.body).toBe(forNew.body);
    expect(await rowFor(known)).toMatchObject({ name: "Ada Lovelace" });
  });

  it("lets the email try again once the hour has passed", async () => {
    const email = anEmail();
    const address = nextAddress();
    const body = requestFor(email);
    const start = new Date("2026-04-01T00:00:00.000Z");
    for (let i = 0; i < ACCESS_REQUEST_LIMITS.perEmail; i++)
      expect(await submitAccessRequest(db, body, address, start)).toBe("saved");
    expect(await submitAccessRequest(db, body, address, start)).toBe("limited");
    const later = new Date(start.getTime() + ACCESS_REQUEST_LIMITS.windowMs);
    expect(await submitAccessRequest(db, body, address, later)).toBe("saved");
  });
});

describe("make access/requests, access/approve, and access/decline", () => {
  const server = new URL("../..", import.meta.url).pathname;
  const run = (...args: readonly string[]) =>
    spawnSync(process.execPath, ["src/cli/access.ts", ...args], {
      cwd: server,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: process.env.DATABASE_URL,
        SCHMEIDE_PUBLIC_URL: "http://localhost:5173",
      },
    });

  it("lists who is waiting, newest first, and approve and decline mark that row", async () => {
    const older = anEmail();
    const newer = anEmail();
    const note = "line one\nline two";
    await submitAccessRequest(
      db,
      requestFor(older),
      nextAddress(),
      new Date("2026-01-02T00:00:00.000Z")
    );
    await submitAccessRequest(
      db,
      requestFor(newer, { message: note, who: "other" }),
      nextAddress(),
      new Date("2026-03-04T05:06:07.000Z")
    );

    const listed = run("requests");
    expect(listed.status).toBe(0);
    const lines = listed.stdout.trim().split("\n");
    const newerLine = `2026-03-04T05:06:07.000Z\t${newer}\tAda Lovelace\tAnalytical Engines\tsomething else\tline one line two`;
    const olderLine = `2026-01-02T00:00:00.000Z\t${older}\tAda Lovelace\tAnalytical Engines\tbusiness owner\tA short note`;
    expect(lines).toContain(newerLine);
    expect(lines).toContain(olderLine);
    expect(lines.indexOf(newerLine)).toBeLessThan(lines.indexOf(olderLine));

    const approved = run("approve", newer);
    expect(approved.status).toBe(0);
    expect(approved.stdout).toContain(`${newer} is approved.`);
    expect(approved.stdout).toContain("/set-password?token=");
    expect(await rowFor(newer)).toMatchObject({ state: "approved" });
    expect(await isApproved(db, newer)).toBe(true);
    expect(run("requests").stdout).not.toContain(newer);

    const declined = run("decline", older);
    expect(declined.status).toBe(0);
    expect(declined.stdout).toContain(`${older} is declined.`);
    expect(declined.stdout).not.toContain("http");
    expect(declined.stdout).not.toContain("token");
    expect(await rowFor(older)).toMatchObject({ state: "declined" });
    expect(await isApproved(db, older)).toBe(false);
    expect(run("requests").stdout).not.toContain(older);

    const missing = run("decline", anEmail());
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("No access request");

    const direct = anEmail();
    const printed = run("approve", direct);
    expect(printed.status).toBe(0);
    expect(printed.stdout).toContain("/set-password?token=");
    expect(await rowFor(direct)).toBeUndefined();
    expect(await isApproved(db, direct)).toBe(true);
  }, 20_000);
});
