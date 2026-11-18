import { useQuery } from "@tanstack/react-query";

import { copy } from "../data/copy";
import { useTRPC } from "../trpc";
import { BusinessDetailsForm } from "./BusinessDetailsForm";
import { ErrorNote } from "./ErrorNote";
import { Invitations } from "./Invitations";
import { MemberList } from "./MemberList";

import styles from "./BusinessPage.module.css";

export function BusinessPage() {
  const trpc = useTRPC();
  const business = useQuery(trpc.business.get.queryOptions());

  return (
    <>
      <h1>{copy.routes.business}</h1>
      <ErrorNote error={business.error} />
      {business.isPending && <p>{copy.loading}</p>}
      {business.data && (
        <>
          {business.data.role !== "owner" && (
            <p className={styles.note}>{copy.businessPage.readOnly}</p>
          )}
          <BusinessDetailsForm key={business.data.id} business={business.data} />
          <MemberList business={business.data} />
          {business.data.role === "owner" && <Invitations business={business.data} />}
        </>
      )}
    </>
  );
}
