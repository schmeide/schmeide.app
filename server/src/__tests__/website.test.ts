import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.ts";
import { createDb } from "../db/client.ts";
import type { AppContext } from "../router.ts";
import { ReaderUnavailableError } from "../services/errors.ts";
import { createProject } from "../services/projects.ts";
import type { SiteFetcher, SiteRead } from "../services/siteFetcher.ts";
import { READ_LIMITS, TOO_MANY_FOR_ACCOUNT, type WebsiteReader } from "../services/website.ts";
import { aSignedInPerson, callApi, testAuth } from "./testAuth.ts";

const db = createDb(process.env.DATABASE_URL ?? "");
afterAll(() => db.$client.end());

const FOUND: SiteRead = {
  ok: true,
  url: "https://www.example.com/",
  pages: [
    {
      url: "https://www.example.com/",
      title: "Example Bakery",
      description: "",
      headings: ["Order ahead"],
      linkTexts: [],
      text: "Order your bread before nine and collect it from the shop the same day.",
    },
  ],
};
const FEATURES = [{ section: "does", text: "Customers can order ahead" }];

const siteFetcher = vi.fn<SiteFetcher>();
const websiteReader = vi.fn<WebsiteReader>();
const deps: AppContext = {
  db,
  workflows: { start: vi.fn(), getHandle: vi.fn() as never },
  taskQueue: "test",
  interviewer: vi.fn(),
  siteFetcher,
  websiteReader,
  websiteLimits: { ...READ_LIMITS, perAccount: 3 },
  auth: testAuth(db),
  providers: [],
};
const app = buildApp(deps);
afterAll(() => app.close());
beforeEach(() => {
  siteFetcher.mockReset().mockResolvedValue(FOUND);
  websiteReader.mockReset().mockResolvedValue({ reading: { features: FEATURES }, usage: [] });
});

const aPersonWithAProject = async (name?: string) => {
  const person = await aSignedInPerson(app, deps, { name });
  const project = await createProject(db, { name: "Orders", tenantId: person.tenantId });
  return { ...person, id: project.id };
};

describe("website.read", () => {
  it("asks whose a site is, then returns what was read for the person to tick", async () => {
    const { cookie, id } = await aPersonWithAProject();
    const address = "https://bakery.example/";

    const asked = await callApi(app, "website.read", { id, address }, cookie);
    const read = await callApi(app, "website.read", { id, address, whose: "someone_else" }, cookie);

    expect(asked.data).toEqual({ status: "ask_whose" });
    expect(read.status).toBe(200);
    expect(read.data).toEqual({
      status: "read",
      address: "https://www.example.com/",
      ownedBy: null,
      proposals: { whose: "someone_else", features: FEATURES },
    });
    expect(siteFetcher).toHaveBeenCalledTimes(1);
  });

  it("does not ask about a site on the domain of the person's sign-in email", async () => {
    const { cookie, id } = await aPersonWithAProject();
    websiteReader.mockResolvedValue({
      reading: { businessName: "Example Bakery", logo: null, colors: [], offers: [], features: [] },
      usage: [],
    });

    const read = await callApi(app, "website.read", { id, address: "www.example.com" }, cookie);

    expect(read.data).toMatchObject({
      status: "read",
      ownedBy: "domain",
      proposals: { whose: "mine", businessName: "Example Bakery" },
    });
  });

  it.each([
    "unreachable",
    "needs_sign_in",
    "blocks_readers",
    "nothing_found",
    "refused_address",
  ] as const)(
    "answers a read that failed as %s with data the screen can show, not an error",
    async (reason) => {
      const { cookie, id } = await aPersonWithAProject();
      siteFetcher.mockResolvedValue({ ok: false, reason });

      const read = await callApi(
        app,
        "website.read",
        { id, address: "bakery.example", whose: "mine" },
        cookie
      );

      expect(read.status).toBe(200);
      expect(read.data).toEqual({ status: "failed", reason });
    }
  );

  it("answers a private address as refused, without fetching", async () => {
    const { cookie, id } = await aPersonWithAProject();

    const read = await callApi(
      app,
      "website.read",
      { id, address: "http://169.254.169.254/latest/meta-data/", whose: "mine" },
      cookie
    );

    expect(read.data).toEqual({ status: "failed", reason: "refused_address" });
    expect(siteFetcher).not.toHaveBeenCalled();
  });

  it("answers CONFLICT, with what to do, once the person is over their limit", async () => {
    const { cookie, id } = await aPersonWithAProject();
    const input = { id, address: "bakery.example", whose: "someone_else" };

    const read = () => callApi(app, "website.read", input, cookie);

    const within = [await read(), await read(), await read()];
    const over = await read();

    expect(within.map(({ status }) => status)).toEqual([200, 200, 200]);
    expect(over.code).toBe("CONFLICT");
    expect(over.message).toBe(TOO_MANY_FOR_ACCOUNT);
    expect(siteFetcher).toHaveBeenCalledTimes(3);
  });

  it("answers SERVICE_UNAVAILABLE when the model's answer cannot be used", async () => {
    const { cookie, id } = await aPersonWithAProject();
    const input = { id, address: "bakery.example", whose: "someone_else" };

    websiteReader.mockResolvedValue({ reading: { features: FEATURES, text: "copied" }, usage: [] });
    expect((await callApi(app, "website.read", input, cookie)).code).toBe("SERVICE_UNAVAILABLE");

    websiteReader.mockRejectedValue(new ReaderUnavailableError("The model run failed"));
    expect((await callApi(app, "website.read", input, cookie)).code).toBe("SERVICE_UNAVAILABLE");
  });

  it("answers NOT_FOUND for a project in another business, and reads nothing", async () => {
    const owner = await aPersonWithAProject();
    const other = await aSignedInPerson(app, deps, { name: "Mallory" });
    const input = { id: owner.id, address: "bakery.example", whose: "mine" };

    const theirs = await callApi(app, "website.read", input, other.cookie);
    const missing = await callApi(
      app,
      "website.read",
      { ...input, id: 2_000_000_000 },
      other.cookie
    );

    expect(theirs.code).toBe("NOT_FOUND");
    expect(theirs.message).toBe(missing.message?.replace("2000000000", String(owner.id)));
    expect((await callApi(app, "website.read", input)).code).toBe("UNAUTHORIZED");
    expect(siteFetcher).not.toHaveBeenCalled();
    expect(websiteReader).not.toHaveBeenCalled();
  });

  it.each([
    ["no address", { address: "" }],
    ["an address that is too long", { address: `https://bakery.example/${"a".repeat(2000)}` }],
    ["an answer other than mine or someone else's", { address: "bakery.example", whose: "ours" }],
  ])("answers BAD_REQUEST to %s", async (_, input) => {
    const { cookie, id } = await aPersonWithAProject();

    expect((await callApi(app, "website.read", { id, ...input }, cookie)).code).toBe("BAD_REQUEST");
    expect(siteFetcher).not.toHaveBeenCalled();
  });
});
