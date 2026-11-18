import { useState } from "react";

import { useSession } from "./SessionProvider";

// Text typed and not yet sent, kept in this tab's sessionStorage so it survives the page giving
// way (signed out, offline) and a sign-in that leaves the site and comes back. It is keyed by the
// person, so nobody else who signs in on this tab sees it. Setting "" forgets it.
export function useDraft(scope: string): readonly [string, (text: string) => void] {
  const { session } = useSession();
  const key = session.person && `schmeide:draft:${session.person.email}:${scope}`;
  const [text, setText] = useState(() => (key && read(key)) ?? "");
  const update = (next: string) => {
    setText(next);
    if (key) write(key, next);
  };
  return [text, update] as const;
}

// A blocked store (private windows) keeps the text for this page only.
const read = (key: string): string | null => {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, text: string) => {
  try {
    if (text) sessionStorage.setItem(key, text);
    else sessionStorage.removeItem(key);
  } catch {
    // Not kept; the text still holds on this page.
  }
};
