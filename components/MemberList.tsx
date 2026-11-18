import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { copy } from "../data/copy";
import { useRefreshBusiness, useTRPC, type BusinessDetails, type Member } from "../trpc";
import { formatDate } from "../utils/formatDate";
import { navigate } from "../utils/navigation";
import { pathTo } from "../utils/routes";
import { ActionError } from "./ActionError";
import { useSession } from "./SessionProvider";

import styles from "./BusinessPage.module.css";

type Props = { readonly business: BusinessDetails };
type Asking = { readonly about: "owner" | "remove" | "leave"; readonly userId: string } | null;

export function MemberList({ business }: Props) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { refresh: refreshSession } = useSession();
  const refreshBusiness = useRefreshBusiness();
  const [asking, setAsking] = useState<Asking>(null);
  const settle = {
    onSuccess: () => {
      setAsking(null);
      return refreshBusiness();
    },
    onError: () => void refreshBusiness(),
  };
  const setRole = useMutation(trpc.business.setRole.mutationOptions(settle));
  const handOver = useMutation(trpc.business.transferOwnership.mutationOptions(settle));
  const remove = useMutation(trpc.business.removeMember.mutationOptions(settle));
  const leave = useMutation(
    trpc.business.leave.mutationOptions({
      onSuccess: async () => {
        await refreshSession();
        navigate(pathTo("apps"));
        await queryClient.invalidateQueries();
      },
      onError: () => void refreshBusiness(),
    })
  );
  const actions = [setRole, handOver, remove, leave];
  const busy = actions.some((action) => action.isPending);
  const failed = actions.find((action) => action.error)?.error ?? null;

  const copyOf = copy.businessPage.members;
  const isOwner = business.role === "owner";
  const owners = business.members.filter((member) => member.role === "owner");
  const onlyOwner = isOwner && owners.length === 1;
  const isAsking = (about: NonNullable<Asking>["about"], member: Member) =>
    asking?.about === about && asking.userId === member.userId;
  const ask = (about: NonNullable<Asking>["about"], member: Member) => () => {
    actions.forEach((action) => action.reset());
    setAsking({ about, userId: member.userId });
  };
  const cancel = () => setAsking(null);

  return (
    <section aria-labelledby="business-members" className={styles.card}>
      <h2 id="business-members">{copyOf.title(business.members.length)}</h2>
      <p className={styles.note}>{copyOf.roleHelp}</p>
      <ul className={styles.rows}>
        {business.members.map((member) => (
          <li key={member.userId} className={styles.row}>
            <div className={styles.who}>
              <span className={styles.name}>
                {member.name} {member.isYou && copyOf.you}
              </span>
              <span className={styles.detail}>{member.email}</span>
              <span className={styles.detail}>
                {copyOf.roles[member.role]} · {copyOf.joined(formatDate(member.joinedAt))}
              </span>
            </div>

            {isOwner && !member.isYou && !asking && (
              <div className={styles.actions}>
                {member.role === "editor" ? (
                  <button type="button" onClick={ask("owner", member)} disabled={busy}>
                    {copyOf.makeOwner(member.name)}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setRole.mutate({ userId: member.userId, role: "editor" })}
                    disabled={busy}
                  >
                    {copyOf.makeEditor(member.name)}
                  </button>
                )}
                <button
                  type="button"
                  data-variant="danger"
                  onClick={ask("remove", member)}
                  disabled={busy}
                >
                  {copyOf.remove(member.name)}
                </button>
              </div>
            )}

            {isAsking("owner", member) && (
              <div role="group" aria-labelledby="member-ask" className={styles.ask}>
                <p id="member-ask">{copyOf.makeOwnerConfirm(member.name)}</p>
                <div className={styles.actions}>
                  <button
                    type="button"
                    onClick={() => setRole.mutate({ userId: member.userId, role: "owner" })}
                    disabled={busy}
                  >
                    {copyOf.makeOwnerToo(member.name)}
                  </button>
                  <button
                    type="button"
                    data-variant="danger"
                    onClick={() => handOver.mutate({ userId: member.userId })}
                    disabled={busy}
                  >
                    {copyOf.handOver(member.name)}
                  </button>
                  <button type="button" onClick={cancel} disabled={busy} autoFocus>
                    {copyOf.changeNothing}
                  </button>
                </div>
              </div>
            )}

            {isAsking("remove", member) && (
              <div role="group" aria-labelledby="member-ask" className={styles.ask}>
                <p id="member-ask">{copyOf.removeConfirm(member.name, business.name)}</p>
                <div className={styles.actions}>
                  <button
                    type="button"
                    data-variant="danger"
                    onClick={() => remove.mutate({ userId: member.userId })}
                    disabled={busy}
                  >
                    {copyOf.remove(member.name)}
                  </button>
                  <button type="button" onClick={cancel} disabled={busy} autoFocus>
                    {copyOf.keep(member.name)}
                  </button>
                </div>
              </div>
            )}

            {member.isYou && !onlyOwner && !asking && (
              <div className={styles.actions}>
                <button
                  type="button"
                  data-variant="danger"
                  onClick={ask("leave", member)}
                  disabled={busy}
                >
                  {copyOf.leave(business.name)}
                </button>
              </div>
            )}

            {isAsking("leave", member) && (
              <div role="group" aria-labelledby="member-ask" className={styles.ask}>
                <p id="member-ask">{copyOf.leaveConfirm(business.name)}</p>
                <div className={styles.actions}>
                  <button
                    type="button"
                    data-variant="danger"
                    onClick={() => leave.mutate()}
                    disabled={busy}
                  >
                    {copyOf.leave(business.name)}
                  </button>
                  <button type="button" onClick={cancel} disabled={busy} autoFocus>
                    {copyOf.stay}
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      {onlyOwner && (
        <p className={styles.note}>
          {business.members.length === 1 ? copyOf.alone : copyOf.onlyOwner}
        </p>
      )}
      <p role="status" className={styles.note}>
        {busy ? copyOf.working : ""}
      </p>
      <ActionError error={failed} />
    </section>
  );
}
