import { and, count, eq, gt, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { ITEM_MAX, planSection, websiteReads } from "../db/schema.ts";
import type { Person } from "./auth.ts";
import { recordUsage, type RunUsage } from "./builds.ts";
import { ConflictError, ReaderUnavailableError } from "./errors.ts";
import type { PageDigest } from "./htmlText.ts";
import type { ReadFailure, SiteFetcher, Whose } from "./siteFetcher.ts";
import { NO_EXCEPTIONS, isOwnAddress, parseAddress } from "./webAddress.ts";

const MAX_FEATURES = 20;
const MAX_OFFERS = 10;
const MAX_COLORS = 5;
const NAME_MAX = 120;

const line = (max: number) => z.string().trim().min(1).max(max);

const featureSchema = z.strictObject({
  section: z.enum(planSection.enumValues),
  text: line(ITEM_MAX),
});

export const othersReadingSchema = z.strictObject({
  features: z.array(featureSchema).max(MAX_FEATURES),
});

export const mineReadingSchema = z.strictObject({
  businessName: line(NAME_MAX).nullable(),
  logo: z.number().int().min(0).nullable(),
  colors: z.array(z.string().trim().max(20)).max(MAX_COLORS),
  offers: z.array(line(ITEM_MAX)).max(MAX_OFFERS),
  features: z.array(featureSchema).max(MAX_FEATURES),
});

export type Feature = z.infer<typeof featureSchema>;
export type OthersReading = z.infer<typeof othersReadingSchema>;
export type MineReading = z.infer<typeof mineReadingSchema>;
export type Reading =
  ({ readonly whose: "mine" } & MineReading) | ({ readonly whose: "someone_else" } & OthersReading);

const unusable = (error: z.ZodError): ReaderUnavailableError =>
  new ReaderUnavailableError(`The model's reading was not usable: ${error.message}`);

export const parseReading = (whose: Whose, value: unknown): Reading => {
  if (whose === "mine") {
    const mine = mineReadingSchema.safeParse(value);
    if (!mine.success) throw unusable(mine.error);
    return { whose, ...mine.data };
  }
  const others = othersReadingSchema.safeParse(value);
  if (!others.success) throw unusable(others.error);
  return { whose, ...others.data };
};

export type WebsiteReader = (input: {
  readonly projectId: number;
  readonly whose: Whose;
  readonly pages: readonly PageDigest[];
}) => Promise<{ readonly reading: unknown; readonly usage: RunUsage | null }>;

export type Proposals =
  | {
      readonly whose: "mine";
      readonly businessName: string | null;
      readonly logoUrl: string | null;
      readonly colors: readonly string[];
      readonly offers: readonly string[];
      readonly features: readonly Feature[];
    }
  | { readonly whose: "someone_else"; readonly features: readonly Feature[] };

export type OwnedBy = "domain" | "claim";

export type WebsiteResult =
  | { readonly status: "ask_whose" }
  | { readonly status: "failed"; readonly reason: ReadFailure }
  | {
      readonly status: "read";
      readonly address: string;
      readonly ownedBy: OwnedBy | null;
      readonly proposals: Proposals;
    };

export type ReadLimits = {
  readonly windowMs: number;
  readonly perAccount: number;
  readonly perBusiness: number;
};

export const READ_LIMITS: ReadLimits = {
  windowMs: 60 * 60 * 1000,
  perAccount: 20,
  perBusiness: 60,
};

export type ConnectedDomains = (db: Db, tenantId: number) => Promise<readonly string[]>;

export type WebsiteDeps = {
  readonly db: Db;
  readonly siteFetcher: SiteFetcher;
  readonly websiteReader: WebsiteReader;
  readonly websiteLimits?: ReadLimits;
  readonly connectedDomains?: ConnectedDomains;
  readonly addressExceptions?: ReadonlySet<string>;
};

const noConnectedDomains: ConnectedDomains = async () => [];

const LOCK_SPACE = 79;

export const TOO_MANY_FOR_ACCOUNT =
  "You have read a lot of websites in the last hour. Wait a while and try again, or describe it in your own words.";
export const TOO_MANY_FOR_BUSINESS =
  "Your business has read a lot of websites in the last hour. Wait a while and try again, or describe it in your own words.";

export const claimRead = (
  db: Db,
  { userId, tenantId }: { readonly userId: string; readonly tenantId: number },
  limits: ReadLimits = READ_LIMITS
): Promise<void> =>
  db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_SPACE}, ${tenantId})`);
    const since = new Date(Date.now() - limits.windowMs);
    await tx.delete(websiteReads).where(lt(websiteReads.at, since));
    const recent = (by: ReturnType<typeof eq>) =>
      tx
        .select({ reads: count() })
        .from(websiteReads)
        .where(and(by, gt(websiteReads.at, since)));
    const [byAccount] = await recent(eq(websiteReads.userId, userId));
    if (byAccount.reads >= limits.perAccount) throw new ConflictError(TOO_MANY_FOR_ACCOUNT);
    const [byBusiness] = await recent(eq(websiteReads.tenantId, tenantId));
    if (byBusiness.reads >= limits.perBusiness) throw new ConflictError(TOO_MANY_FOR_BUSINESS);
    await tx.insert(websiteReads).values({ userId, tenantId });
  });

const tidy = (text: string): string =>
  text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const HAS_ADDRESS = /https?:\/\/|www\.|\S+@\S+\.\S+/i;
const COPIED_WORDS = 6;

const words = (text: string): readonly string[] =>
  text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

const isCopied = (text: string, pageWords: string): boolean => {
  const own = words(text);
  return own.length >= COPIED_WORDS && pageWords.includes(` ${own.join(" ")} `);
};

const distinct = <Item>(items: readonly Item[], key: (item: Item) => string): readonly Item[] =>
  items.filter((item, index) => items.findIndex((other) => key(other) === key(item)) === index);

const featuresFrom = (features: readonly Feature[]): readonly Feature[] =>
  distinct(
    features
      .map(({ section, text }) => ({ section, text: tidy(text) }))
      .filter(({ text }) => text !== "" && !HAS_ADDRESS.test(text)),
    ({ section, text }) => `${section}:${text.toLowerCase()}`
  );

export const proposalsFrom = (reading: Reading, pages: readonly PageDigest[]): Proposals => {
  if (reading.whose === "someone_else") {
    const pageWords = ` ${pages
      .flatMap(({ title, description, headings, linkTexts, text }) => [
        title,
        description,
        ...headings,
        ...linkTexts,
        text,
      ])
      .flatMap(words)
      .join(" ")} `;
    return {
      whose: "someone_else",
      features: featuresFrom(reading.features).filter(({ text }) => !isCopied(text, pageWords)),
    };
  }
  const brand = pages.flatMap((page) => (page.brand ? [page.brand] : []));
  const logos = brand.flatMap(({ logos: found }) => found);
  const colors = new Set(brand.flatMap(({ colors: found }) => found));
  const name = reading.businessName === null ? "" : tidy(reading.businessName);
  return {
    whose: "mine",
    businessName: name || null,
    logoUrl: reading.logo === null ? null : (logos[reading.logo] ?? null),
    colors: distinct(
      reading.colors.map((color) => color.toLowerCase()).filter((color) => colors.has(color)),
      (color) => color
    ),
    offers: distinct(
      reading.offers.map(tidy).filter((offer) => offer !== "" && !HAS_ADDRESS.test(offer)),
      (offer) => offer.toLowerCase()
    ),
    features: featuresFrom(reading.features),
  };
};

const foundNothing = (proposals: Proposals): boolean =>
  proposals.features.length === 0 &&
  (proposals.whose === "someone_else" ||
    (proposals.businessName === null &&
      proposals.logoUrl === null &&
      proposals.colors.length === 0 &&
      proposals.offers.length === 0));

export const readWebsite = async (
  deps: WebsiteDeps,
  input: { readonly id: number; readonly address: string; readonly whose?: Whose },
  caller: { readonly person: Person; readonly tenantId: number }
): Promise<WebsiteResult> => {
  const start = parseAddress(input.address, deps.addressExceptions ?? NO_EXCEPTIONS);
  if (!start.ok) return { status: "failed", reason: "refused_address" };
  const connected = await (deps.connectedDomains ?? noConnectedDomains)(deps.db, caller.tenantId);
  const byDomain = isOwnAddress(start.url.hostname, caller.person.email, connected);
  const whose = input.whose ?? (byDomain ? "mine" : null);
  if (!whose) return { status: "ask_whose" };

  await claimRead(
    deps.db,
    { userId: caller.person.id, tenantId: caller.tenantId },
    deps.websiteLimits
  );
  const site = await deps.siteFetcher({ address: start.url.href, whose });
  if (!site.ok) return { status: "failed", reason: site.reason };

  const { reading, usage } = await deps.websiteReader({
    projectId: input.id,
    whose,
    pages: site.pages,
  });
  await recordUsage(deps.db, usage);
  const proposals = proposalsFrom(parseReading(whose, reading), site.pages);
  if (foundNothing(proposals)) return { status: "failed", reason: "nothing_found" };
  return {
    status: "read",
    address: site.url,
    ownedBy: whose === "mine" ? (byDomain ? "domain" : "claim") : null,
    proposals,
  };
};
