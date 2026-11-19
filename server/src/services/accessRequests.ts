// Access requests posted from schmeide.com. One public route stores a row; the make targets
// list who is waiting and mark a row approved or declined. The answer never says whether the
// address was new, already requested, approved, or already an account.
import { and, asc, count, desc, eq, gt, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import {
  ACCESS_BUSINESS_MAX,
  ACCESS_MESSAGE_MAX,
  ACCESS_NAME_MAX,
  ACCESS_WHO,
  accessRequestHits,
  accessRequests,
  emailSchema,
} from "../db/schema.ts";
import { isApproved } from "./access.ts";

export { ACCESS_BUSINESS_MAX, ACCESS_MESSAGE_MAX, ACCESS_NAME_MAX } from "../db/schema.ts";

// The only browser origin allowed to post. Every other route keeps its own origin.
export const MARKETING_ORIGIN = "https://schmeide.com";
export const ACCESS_REQUEST_PATH = "/access-requests";

// A person fixing a typo can send a few times. A shared network can cover more than one person.
// Past either limit the refusal is the same, so it does not say which limit was hit.
export const ACCESS_REQUEST_LIMITS = {
  windowMs: 60 * 60 * 1000,
  perAddress: 20,
  perEmail: 5,
} as const;

const WHO_LABEL = {
  owner: "business owner",
  investor: "investor",
  other: "something else",
} as const;

// What the static site posts. `website` is read off the raw body by the route: real people leave
// it empty, and a filled one is not a field of this schema.
export const accessRequestBody = z.object({
  name: z.string().trim().min(1).max(ACCESS_NAME_MAX),
  email: emailSchema,
  business: z.string().trim().min(1).max(ACCESS_BUSINESS_MAX),
  who: z.enum(ACCESS_WHO),
  message: z
    .string()
    .trim()
    .max(ACCESS_MESSAGE_MAX)
    .nullish()
    .transform((value) => (value ? value : null)),
});

export type AccessRequestInput = z.input<typeof accessRequestBody> & {
  readonly website?: string | null;
};

export type AccessRequestResult = "saved" | "limited";

// The client address: the first hop of X-Forwarded-For when a proxy set it, otherwise the socket.
export const clientAddress = (
  forwarded: string | readonly string[] | undefined,
  fallback: string
): string => {
  const header = typeof forwarded === "string" ? forwarded : forwarded?.[0];
  const first = header?.split(",")[0]?.trim() ?? "";
  return (first.length > 0 ? first : fallback).slice(0, 128);
};

const since = (now: Date) => new Date(now.getTime() - ACCESS_REQUEST_LIMITS.windowMs);

// Takes one slot in the hour, or reports that the limit is already met. Old rows for this key go.
const takeSlot = async (
  db: Db,
  bucket: "address" | "email",
  key: string,
  limit: number,
  now: Date
): Promise<boolean> => {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`access-request ${bucket} ${key}`}))`
  );
  const windowStart = since(now);
  await db
    .delete(accessRequestHits)
    .where(
      and(
        eq(accessRequestHits.bucket, bucket),
        eq(accessRequestHits.key, key),
        lt(accessRequestHits.at, windowStart)
      )
    );
  const [row] = await db
    .select({ hits: count() })
    .from(accessRequestHits)
    .where(
      and(
        eq(accessRequestHits.bucket, bucket),
        eq(accessRequestHits.key, key),
        gt(accessRequestHits.at, windowStart)
      )
    );
  if ((row?.hits ?? 0) >= limit) return false;
  await db.insert(accessRequestHits).values({ bucket, key, at: now });
  return true;
};

// Counts a post that will not be stored (the hidden field was filled) against the address limit.
export const noteAccessAddress = async (
  db: Db,
  address: string,
  now = new Date()
): Promise<AccessRequestResult> =>
  db.transaction(async (tx) =>
    (await takeSlot(tx as unknown as Db, "address", address, ACCESS_REQUEST_LIMITS.perAddress, now))
      ? "saved"
      : "limited"
  );

// Stores the request, or updates the one row for that email. An address that is already approved
// stays approved, so it does not reappear on the waiting list. Anyone else, including someone
// declined earlier, is waiting again.
export const submitAccessRequest = async (
  db: Db,
  raw: AccessRequestInput,
  address: string,
  now = new Date()
): Promise<AccessRequestResult> => {
  const input = accessRequestBody.parse(raw);
  return db.transaction(async (tx) => {
    const conn = tx as unknown as Db;
    const addressOk = await takeSlot(
      conn,
      "address",
      address,
      ACCESS_REQUEST_LIMITS.perAddress,
      now
    );
    if (!addressOk) return "limited";
    const emailOk = await takeSlot(conn, "email", input.email, ACCESS_REQUEST_LIMITS.perEmail, now);
    if (!emailOk) return "limited";
    await conn.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`access-request row ${input.email}`}))`
    );
    const [existing] = await conn
      .select({ email: accessRequests.email })
      .from(accessRequests)
      .where(eq(accessRequests.email, input.email))
      .for("update");
    const state = (await isApproved(conn, input.email)) ? "approved" : "waiting";
    const values = {
      name: input.name,
      business: input.business,
      who: input.who,
      message: input.message,
      state,
      arrivedAt: now,
    } as const;
    if (existing) {
      await conn.update(accessRequests).set(values).where(eq(accessRequests.email, input.email));
    } else {
      await conn.insert(accessRequests).values({ email: input.email, ...values });
    }
    return "saved";
  });
};

export const listWaitingRequests = (db: Db) =>
  db
    .select()
    .from(accessRequests)
    .where(eq(accessRequests.state, "waiting"))
    .orderBy(desc(accessRequests.arrivedAt), asc(accessRequests.email));

const cell = (value: string) => value.replaceAll(/[\t\r\n]+/g, " ");

export const formatWaitingRequest = (
  row: Awaited<ReturnType<typeof listWaitingRequests>>[number]
): string =>
  [
    row.arrivedAt.toISOString(),
    row.email,
    cell(row.name),
    cell(row.business),
    WHO_LABEL[row.who],
    cell(row.message ?? ""),
  ].join("\t");

// Marks the request declined. Returns the address, or null when there is no such request.
// Does not write to the person, and does not take away access already given.
export const declineAccessRequest = async (db: Db, rawEmail: string): Promise<string | null> => {
  const email = emailSchema.parse(rawEmail);
  const [updated] = await db
    .update(accessRequests)
    .set({ state: "declined" })
    .where(eq(accessRequests.email, email))
    .returning({ email: accessRequests.email });
  return updated?.email ?? null;
};
