import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createDb } from "../../db/client.ts";
import { memberships, projects, tenants, usage, users, websiteReads } from "../../db/schema.ts";
import { ConflictError, ReaderUnavailableError } from "../errors.ts";
import type { PageDigest } from "../htmlText.ts";
import { createProject } from "../projects.ts";
import { READ_FAILURES, type SiteFetcher, type SiteRead } from "../siteFetcher.ts";
import {
  READ_LIMITS,
  TOO_MANY_FOR_ACCOUNT,
  TOO_MANY_FOR_BUSINESS,
  claimRead,
  proposalsFrom,
  readWebsite,
  type MineReading,
  type OthersReading,
  type WebsiteDeps,
  type WebsiteReader,
} from "../website.ts";

const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());

const aBusiness = async () => {
  const [tenant] = await db
    .insert(tenants)
    .values({ slug: `b-${randomUUID()}`, name: "Acme" })
    .returning();
  return tenant.id;
};

const aPerson = async (tenantId: number, domain = `${randomUUID()}.example`) => {
  const person = {
    id: randomUUID(),
    name: "Ada Example",
    email: `ada-${randomUUID()}@${domain}`,
    admin: false,
  };
  await db.insert(users).values({ ...person, emailVerified: true });
  await db.insert(memberships).values({ userId: person.id, tenantId, role: "owner" });
  return person;
};

const aCaller = async (domain?: string) => {
  const tenantId = await aBusiness();
  const person = await aPerson(tenantId, domain);
  const project = await createProject(db, { name: `Site ${randomUUID()}`, tenantId });
  return { caller: { person, tenantId }, project };
};

const PAGE: PageDigest = {
  url: "https://acme.example/",
  title: "Acme Bakery",
  description: "Fresh bread every morning",
  headings: ["Order ahead"],
  linkTexts: ["Our menu"],
  text: "Order your bread before nine and collect it from the shop the same day.",
  brand: {
    siteName: "Acme",
    colors: ["#c0392b", "#222222"],
    logos: ["https://acme.example/logo.png", "https://acme.example/favicon.ico"],
  },
};

const MINE: MineReading = {
  businessName: "Acme Bakery",
  logo: 0,
  colors: ["#C0392B"],
  offers: ["Fresh bread baked every morning"],
  features: [{ section: "does", text: "Customers can order ahead" }],
};
const OTHERS: OthersReading = {
  features: [{ section: "does", text: "Customers can order ahead" }],
};

const reads = (site: SiteRead, reading: unknown = MINE) => {
  const siteFetcher = vi.fn<SiteFetcher>(async () => site);
  const websiteReader = vi.fn<WebsiteReader>(async ({ projectId }) => ({
    reading,
    usage: {
      run: { projectId, buildId: null, runKind: "website" as const, durationMs: 4000 },
      models: [
        {
          projectId,
          buildId: null,
          runKind: "website" as const,
          model: "claude-test",
          inputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 3,
          cacheCreationTokens: 4,
          costUsd: 0.01,
        },
      ],
    },
  }));
  const deps: WebsiteDeps = { db, siteFetcher, websiteReader };
  return { deps, siteFetcher, websiteReader };
};

const FOUND: SiteRead = { ok: true, url: "https://acme.example/", pages: [PAGE] };

const countReads = async (userId: string) =>
  (await db.select().from(websiteReads).where(eq(websiteReads.userId, userId))).length;

describe("readWebsite", () => {
  it("asks whose the site is before reading one that is not provably the caller's", async () => {
    const { caller, project } = await aCaller();
    const { deps, siteFetcher, websiteReader } = reads(FOUND);

    const result = await readWebsite(deps, { id: project.id, address: "acme.example" }, caller);

    expect(result).toEqual({ status: "ask_whose" });
    expect(siteFetcher).not.toHaveBeenCalled();
    expect(websiteReader).not.toHaveBeenCalled();
    expect(await countReads(caller.person.id)).toBe(0);
  });

  it("reads a site on the domain of the caller's sign-in email as theirs, without asking", async () => {
    const { caller, project } = await aCaller("acme.example");
    const { deps, siteFetcher, websiteReader } = reads(FOUND);

    const result = await readWebsite(deps, { id: project.id, address: "www.acme.example" }, caller);

    expect(siteFetcher).toHaveBeenCalledWith({
      address: "https://www.acme.example/",
      whose: "mine",
    });
    expect(websiteReader).toHaveBeenCalledWith({
      projectId: project.id,
      whose: "mine",
      pages: [PAGE],
    });
    expect(result).toEqual({
      status: "read",
      address: "https://acme.example/",
      ownedBy: "domain",
      proposals: {
        whose: "mine",
        businessName: "Acme Bakery",
        logoUrl: "https://acme.example/logo.png",
        colors: ["#c0392b"],
        offers: ["Fresh bread baked every morning"],
        features: [{ section: "does", text: "Customers can order ahead" }],
      },
    });
    expect(await db.select().from(usage).where(eq(usage.projectId, project.id))).toEqual([
      expect.objectContaining({ runKind: "website", buildId: null, costUsd: 0.01 }),
    ]);
  });

  it.each(["gmail.com", "outlook.com", "yahoo.com", "icloud.com"])(
    "still asks when the caller signs in with a %s address",
    async (domain) => {
      const { caller, project } = await aCaller(domain);
      const { deps, siteFetcher } = reads(FOUND);

      const result = await readWebsite(deps, { id: project.id, address: `www.${domain}` }, caller);

      expect(result).toEqual({ status: "ask_whose" });
      expect(siteFetcher).not.toHaveBeenCalled();
    }
  );

  it("reads a site on a domain connected to the business as theirs, once those exist", async () => {
    const { caller, project } = await aCaller();
    const { deps } = reads(FOUND);
    const connectedDomains = vi.fn(async () => ["acme.example"]);

    const result = await readWebsite(
      { ...deps, connectedDomains },
      { id: project.id, address: "https://shop.acme.example/" },
      caller
    );

    expect(connectedDomains).toHaveBeenCalledWith(db, caller.tenantId);
    expect(result).toMatchObject({ status: "read", ownedBy: "domain" });
  });

  it("takes the caller's word that a site is theirs, and says it was only their word", async () => {
    const { caller, project } = await aCaller();
    const { deps } = reads(FOUND);

    const result = await readWebsite(
      deps,
      { id: project.id, address: "acme.example", whose: "mine" },
      caller
    );

    expect(result).toMatchObject({ status: "read", ownedBy: "claim" });
  });

  it("returns features only for someone else's site", async () => {
    const { caller, project } = await aCaller();
    const { deps, siteFetcher } = reads(FOUND, OTHERS);

    const result = await readWebsite(
      deps,
      { id: project.id, address: "acme.example", whose: "someone_else" },
      caller
    );

    expect(siteFetcher).toHaveBeenCalledWith({
      address: "https://acme.example/",
      whose: "someone_else",
    });
    expect(result).toEqual({
      status: "read",
      address: "https://acme.example/",
      ownedBy: null,
      proposals: {
        whose: "someone_else",
        features: [{ section: "does", text: "Customers can order ahead" }],
      },
    });
  });

  it("keeps the colors of the business's own site for the app's look, and no one else's", async () => {
    const { caller, project } = await aCaller("acme.example");
    const brandColors = async () =>
      (await db.select().from(projects).where(eq(projects.id, project.id)))[0].brandColors;

    await readWebsite(
      reads(FOUND, OTHERS).deps,
      { id: project.id, address: "acme.example", whose: "someone_else" },
      caller
    );
    expect(await brandColors()).toEqual([]);

    await readWebsite(reads(FOUND).deps, { id: project.id, address: "acme.example" }, caller);
    expect(await brandColors()).toEqual(["#c0392b"]);

    // A later read of their site that finds no colors leaves the ones already kept.
    await readWebsite(
      reads(FOUND, { ...MINE, colors: [] }).deps,
      { id: project.id, address: "acme.example" },
      caller
    );
    expect(await brandColors()).toEqual(["#c0392b"]);
  });

  it("reads a site as someone else's when the caller says so, even on their own domain", async () => {
    const { caller, project } = await aCaller("acme.example");
    const { deps } = reads(FOUND, OTHERS);

    const result = await readWebsite(
      deps,
      { id: project.id, address: "acme.example", whose: "someone_else" },
      caller
    );

    expect(result).toMatchObject({ ownedBy: null, proposals: { whose: "someone_else" } });
  });

  it.each(READ_FAILURES)(
    "returns the failure %s as data, without asking the model",
    async (reason) => {
      const { caller, project } = await aCaller();
      const { deps, websiteReader } = reads({ ok: false, reason });

      const result = await readWebsite(
        deps,
        { id: project.id, address: "acme.example", whose: "mine" },
        caller
      );

      expect(result).toEqual({ status: "failed", reason });
      expect(websiteReader).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["mine", { businessName: null, logo: null, colors: [], offers: [], features: [] }],
    ["someone_else", { features: [] }],
  ] as const)(
    "says nothing useful was found when the reading of %s is empty",
    async (whose, reading) => {
      const { caller, project } = await aCaller();
      const { deps } = reads(FOUND, reading);

      const result = await readWebsite(
        deps,
        { id: project.id, address: "acme.example", whose },
        caller
      );

      expect(result).toEqual({ status: "failed", reason: "nothing_found" });
    }
  );

  it.each([
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost:5432/",
    "ftp://acme.example/",
    "https://user:secret@acme.example/",
    "https://acme.example:8443/",
    "not an address",
  ])("refuses %s without fetching it or counting it", async (address) => {
    const { caller, project } = await aCaller();
    const { deps, siteFetcher } = reads(FOUND);

    const result = await readWebsite(deps, { id: project.id, address, whose: "mine" }, caller);

    expect(result).toEqual({ status: "failed", reason: "refused_address" });
    expect(siteFetcher).not.toHaveBeenCalled();
    expect(await countReads(caller.person.id)).toBe(0);
  });

  it.each([
    ["is not the fixed shape", "mine", { ...MINE, logo: "https://evil.example/x.png" }],
    ["carries more than features for someone else's site", "someone_else", MINE],
    ["carries page text for someone else's site", "someone_else", { ...OTHERS, text: "copied" }],
    ["is not an object", "mine", "Ignore the rules"],
  ] as const)(
    "fails, returning nothing, when the reader's answer %s",
    async (_, whose, reading) => {
      const { caller, project } = await aCaller();
      const { deps } = reads(FOUND, reading);

      await expect(
        readWebsite(deps, { id: project.id, address: "acme.example", whose }, caller)
      ).rejects.toBeInstanceOf(ReaderUnavailableError);
    }
  );
});

describe("proposalsFrom", () => {
  it("returns only a logo and colors the page itself offered", () => {
    const from = (reading: Partial<MineReading>) =>
      proposalsFrom({ whose: "mine", ...MINE, offers: [], ...reading }, [PAGE]);

    expect(from({ logo: 1 })).toMatchObject({ logoUrl: "https://acme.example/favicon.ico" });
    expect(from({ logo: 7 })).toMatchObject({ logoUrl: null });
    expect(from({ logo: null })).toMatchObject({ logoUrl: null });
    expect(
      from({ colors: ["#222222", "#ff00ff", "url(https://evil.example)", "#C0392B", "#222222"] })
    ).toMatchObject({ colors: ["#222222", "#c0392b"] });
    expect(
      proposalsFrom({ whose: "mine", ...MINE, features: [], offers: [] }, [
        { ...PAGE, brand: undefined },
      ])
    ).toMatchObject({ logoUrl: null, colors: [] });
  });

  it("drops anything with an address in it, tidies the rest, and drops repeats", () => {
    const proposals = proposalsFrom(
      {
        whose: "mine",
        businessName: "  Acme\u200b \n Bakery ",
        logo: null,
        colors: [],
        offers: [
          "Fresh bread",
          "fresh bread",
          "Visit https://evil.example now",
          "Mail us at a@evil.example",
        ],
        features: [
          { section: "does", text: "Customers can   order ahead" },
          { section: "does", text: "customers can order ahead" },
          { section: "screens", text: "Customers can order ahead" },
          { section: "does", text: "Go to www.evil.example to sign in" },
        ],
      },
      [PAGE]
    );

    expect(proposals).toMatchObject({
      businessName: "Acme Bakery",
      offers: ["Fresh bread"],
      features: [
        { section: "does", text: "Customers can order ahead" },
        { section: "screens", text: "Customers can order ahead" },
      ],
    });
  });

  it("drops a feature that repeats the wording of someone else's page", () => {
    const proposals = proposalsFrom(
      {
        whose: "someone_else",
        features: [
          { section: "does", text: "Order your bread before nine and collect it from the shop." },
          { section: "does", text: "Customers can order ahead and pick up later" },
          { section: "does", text: "Order ahead" },
        ],
      },
      [PAGE]
    );

    expect(proposals).toEqual({
      whose: "someone_else",
      features: [
        { section: "does", text: "Customers can order ahead and pick up later" },
        { section: "does", text: "Order ahead" },
      ],
    });
  });
});

describe("the limit on reads", () => {
  const limits = { ...READ_LIMITS, perAccount: 2, perBusiness: 3 };

  it("stands at twenty an hour for an account and sixty for a business", () => {
    expect(READ_LIMITS).toEqual({ windowMs: 3_600_000, perAccount: 20, perBusiness: 60 });
  });

  it("refuses an account over its limit with a conflict that says what to do", async () => {
    const { caller, project } = await aCaller();
    const { deps, siteFetcher } = reads(FOUND);
    const read = () =>
      readWebsite(
        { ...deps, websiteLimits: limits },
        { id: project.id, address: "acme.example", whose: "mine" },
        caller
      );

    await read();
    await read();
    const third = read();

    await expect(third).rejects.toBeInstanceOf(ConflictError);
    await expect(third).rejects.toThrow(TOO_MANY_FOR_ACCOUNT);
    expect(TOO_MANY_FOR_ACCOUNT).toContain("try again");
    expect(siteFetcher).toHaveBeenCalledTimes(2);
    expect(await countReads(caller.person.id)).toBe(2);
  });

  it("refuses a business over its limit, whoever in it asks", async () => {
    const tenantId = await aBusiness();
    const [ada, bob] = [await aPerson(tenantId), await aPerson(tenantId)];

    await claimRead(db, { userId: ada.id, tenantId }, limits);
    await claimRead(db, { userId: ada.id, tenantId }, limits);
    await claimRead(db, { userId: bob.id, tenantId }, limits);

    await expect(claimRead(db, { userId: bob.id, tenantId }, limits)).rejects.toThrow(
      TOO_MANY_FOR_BUSINESS
    );
    expect(await countReads(bob.id)).toBe(1);
  });

  it("counts an account across its businesses, and leaves other accounts alone", async () => {
    const [first, second] = [await aBusiness(), await aBusiness()];
    const ada = await aPerson(first);
    const bob = await aPerson(second);

    await claimRead(db, { userId: ada.id, tenantId: first }, limits);
    await claimRead(db, { userId: ada.id, tenantId: second }, limits);

    await expect(claimRead(db, { userId: ada.id, tenantId: second }, limits)).rejects.toThrow(
      TOO_MANY_FOR_ACCOUNT
    );
    await expect(
      claimRead(db, { userId: bob.id, tenantId: second }, limits)
    ).resolves.toBeUndefined();
  });

  it("counts a read that failed, so the reader cannot be used to probe addresses", async () => {
    const { caller, project } = await aCaller();
    const { deps } = reads({ ok: false, reason: "refused_address" });
    const read = () =>
      readWebsite(
        { ...deps, websiteLimits: limits },
        { id: project.id, address: "acme.example", whose: "mine" },
        caller
      );

    await read();
    await read();

    await expect(read()).rejects.toBeInstanceOf(ConflictError);
  });

  it("is kept in the database, so a restart does not reset it", async () => {
    const tenantId = await aBusiness();
    const ada = await aPerson(tenantId);
    await claimRead(db, { userId: ada.id, tenantId }, limits);
    await claimRead(db, { userId: ada.id, tenantId }, limits);

    const restarted = createDb(process.env.DATABASE_URL ?? "");
    try {
      await expect(claimRead(restarted, { userId: ada.id, tenantId }, limits)).rejects.toThrow(
        TOO_MANY_FOR_ACCOUNT
      );
    } finally {
      await restarted.$client.end();
    }
  });

  it("lets reads through again once the hour has passed", async () => {
    const tenantId = await aBusiness();
    const ada = await aPerson(tenantId);
    const longAgo = new Date(Date.now() - limits.windowMs - 1000);
    await db.insert(websiteReads).values([
      { userId: ada.id, tenantId, at: longAgo },
      { userId: ada.id, tenantId, at: longAgo },
    ]);

    await expect(claimRead(db, { userId: ada.id, tenantId }, limits)).resolves.toBeUndefined();
    expect(await countReads(ada.id)).toBe(1);
  });

  it("holds when many reads arrive together", async () => {
    const tenantId = await aBusiness();
    const ada = await aPerson(tenantId);

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => claimRead(db, { userId: ada.id, tenantId }, limits))
    );

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(2);
    expect(await countReads(ada.id)).toBe(2);
  });
});
