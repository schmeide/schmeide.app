import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent, type ReactNode } from "react";

import { copy } from "../data/copy";
import { useTRPC, useTRPCClient, type ReviewItem } from "../trpc";
import { ageOf, reportOverdue } from "../utils/reviewAge";
import { pathTo } from "../utils/routes";
import { ErrorNote } from "./ErrorNote";
import { Link } from "./Link";

import errorStyles from "./ErrorNote.module.css";
import styles from "./AdminReviewPage.module.css";

const when = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

const carriedReason = (item: ReviewItem): string => {
  const basis = (item.rule ?? item.requestText ?? item.cause ?? item.fileName ?? item.id)
    .replace(/\s+/g, " ")
    .trim();
  return `Review ${item.id}: ${basis}`.slice(0, 500);
};

const withReason = (path: string, reason: string, extra: Readonly<Record<string, string>>) => {
  const search = new URLSearchParams({ reason, ...extra });
  return `${path}?${search}`;
};

// Where an admin goes to act, with the item's reason already in the address.
const actionLinks = (item: ReviewItem): readonly { href: string; label: string }[] => {
  const reason = carriedReason(item);
  const links: { href: string; label: string }[] = [];
  if (item.projectId !== null)
    links.push({
      href: withReason(pathTo("adminProjects"), reason, { project: String(item.projectId) }),
      label: copy.review.changeTier,
    });
  if (item.tenantId !== null && item.projectId !== null)
    links.push({
      href: withReason(pathTo("adminBusiness", { id: item.tenantId }), reason, {
        action: "offline",
        project: String(item.projectId),
      }),
      label: copy.review.takeOffline,
    });
  if (item.tenantId !== null)
    links.push({
      href: withReason(pathTo("adminBusiness", { id: item.tenantId }), reason, {
        action: "suspend",
      }),
      label: copy.review.suspend,
    });
  if (item.tenantId !== null && item.customerEmail)
    links.push({
      href: withReason(pathTo("adminBusiness", { id: item.tenantId }), reason, {
        action: "view",
        email: item.customerEmail,
      }),
      label: copy.review.viewAs,
    });
  return links;
};

const Fact = ({ term, children }: { readonly term: string; readonly children: ReactNode }) => (
  <div>
    <dt>{term}</dt>
    <dd>{children}</dd>
  </div>
);

function CloseReview({ id }: { readonly id: string }) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const field = useId();
  const [missingReason, setMissingReason] = useState(false);
  const [missingOutcome, setMissingOutcome] = useState(false);
  const close = useMutation({
    mutationFn: (input: {
      readonly disposition: ReviewItem["disposition"];
      readonly reason: string;
    }) => {
      if (!input.disposition) return Promise.resolve();
      return client.admin.review.close.mutate({
        id,
        disposition: input.disposition,
        reason: input.reason,
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.admin.pathKey() }),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const reason = String(form.get("reason") ?? "").trim();
    const disposition = String(form.get("disposition") ?? "");
    const outcome = copy.review.dispositions[disposition as keyof typeof copy.review.dispositions]
      ? (disposition as NonNullable<ReviewItem["disposition"]>)
      : null;
    setMissingReason(reason === "");
    setMissingOutcome(outcome === null);
    if (reason === "" || outcome === null) return;
    close.mutate({ disposition: outcome, reason });
  };

  return (
    <form onSubmit={onSubmit} noValidate className={styles.form}>
      <label htmlFor={`${field}-outcome`}>{copy.review.dispositionLabel}</label>
      <select id={`${field}-outcome`} name="disposition" defaultValue="">
        <option value="">{copy.review.dispositionChoose}</option>
        {Object.entries(copy.review.dispositions).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      {missingOutcome && (
        <p role="alert" className={errorStyles.error}>
          {copy.review.dispositionNeeded}
        </p>
      )}
      <label htmlFor={`${field}-reason`}>{copy.adminActions.reasonLabel}</label>
      <input
        id={`${field}-reason`}
        name="reason"
        required
        maxLength={500}
        aria-invalid={missingReason || undefined}
        aria-describedby={missingReason ? `${field}-reason-error` : undefined}
      />
      {missingReason && (
        <p id={`${field}-reason-error`} role="alert" className={errorStyles.error}>
          {copy.adminActions.reasonNeeded}
        </p>
      )}
      <button type="submit" data-variant="primary" disabled={close.isPending}>
        {close.isPending ? copy.adminActions.working : copy.review.close}
      </button>
      <ErrorNote error={close.error} />
    </form>
  );
}

function ReviewItemCard({ item }: { readonly item: ReviewItem }) {
  const heading = useId();
  const links = actionLinks(item);
  const overdue =
    item.kind === "report" && item.status === "open" && reportOverdue(item.at, new Date());
  return (
    <article className={styles.item} aria-labelledby={heading}>
      <h2 id={heading} className={styles.kind}>
        {copy.review.kinds[item.kind]}
      </h2>
      <p className={styles.when}>
        <time dateTime={item.at.toISOString()}>{when.format(item.at)}</time>
      </p>
      <dl className={styles.facts}>
        {item.businessName && <Fact term={copy.review.business}>{item.businessName}</Fact>}
        {item.projectName && <Fact term={copy.review.project}>{item.projectName}</Fact>}
        {item.requestText && <Fact term={copy.review.request}>{item.requestText}</Fact>}
        {item.rule && <Fact term={copy.review.rule}>{item.rule}</Fact>}
        {item.outcome === "refused" && (
          <Fact term={copy.review.kinds.request}>{copy.review.refused}</Fact>
        )}
        {item.outcome === "unclassified" && (
          <Fact term={copy.review.kinds.request}>{copy.review.unclassified}</Fact>
        )}
        {item.fromTier && item.toTier && (
          <Fact term={copy.review.kinds.tier}>
            {copy.review.tierChange(item.fromTier, item.toTier)}
          </Fact>
        )}
        {item.cause && <Fact term={copy.review.cause}>{item.cause}</Fact>}
        {item.fileName && (
          <Fact term={copy.review.file}>
            {item.fileType ? copy.review.fileNamed(item.fileName, item.fileType) : item.fileName}
          </Fact>
        )}
        {item.address && <Fact term={copy.review.address}>{item.address}</Fact>}
        {item.replyEmail && <Fact term={copy.review.reply}>{item.replyEmail}</Fact>}
        {item.count !== null && (
          <Fact term={copy.review.kinds.repeated}>{copy.review.repeated(item.count)}</Fact>
        )}
      </dl>
      {overdue && <p className={styles.overdue}>{copy.review.overdue}</p>}
      {item.status === "closed" && item.disposition && (
        <p>
          {copy.review.closed(copy.review.dispositions[item.disposition])} {item.closeReason}
        </p>
      )}
      {links.length > 0 && (
        <nav className={styles.actions} aria-label={copy.review.actions}>
          {links.map((link) => (
            <Link key={link.label} to={link.href}>
              {link.label}
            </Link>
          ))}
        </nav>
      )}
      {item.status === "open" && <CloseReview id={item.id} />}
    </article>
  );
}

// One list of what an operator still has to look at, newest first.
export function AdminReviewPage() {
  const trpc = useTRPC();
  const open = useQuery(trpc.admin.review.open.queryOptions());
  const list = useInfiniteQuery(
    trpc.admin.review.list.infiniteQueryOptions({}, { getNextPageParam: (page) => page.nextCursor })
  );
  const entries = list.data?.pages.flatMap((page) => page.entries) ?? [];
  const oldest = open.data?.oldestAt;
  const age = oldest ? ageOf(oldest, new Date()) : null;

  return (
    <>
      <header>
        <h1>{copy.routes.adminReview}</h1>
        <p className={styles.intro}>{copy.review.intro}</p>
        <p className={styles.intro}>{copy.review.lookedAt}</p>
        {open.data && open.data.count > 0 && age && (
          <p className={styles.status}>
            {copy.review.waiting(open.data.count, copy.review.age(age.amount, age.unit))}
          </p>
        )}
      </header>
      <ErrorNote error={list.error ?? open.error} />
      {list.isPending && <p>{copy.loading}</p>}
      {list.isSuccess && entries.length === 0 && <p>{copy.review.empty}</p>}
      {entries.length > 0 && (
        <ul className={styles.list} aria-label={copy.review.caption}>
          {entries.map((item) => (
            <li key={item.id}>
              <ReviewItemCard item={item} />
            </li>
          ))}
        </ul>
      )}
      {list.hasNextPage && (
        <button
          type="button"
          className={styles.more}
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {list.isFetchingNextPage ? copy.loading : copy.review.more}
        </button>
      )}
    </>
  );
}
