import type { AnchorHTMLAttributes, MouseEvent } from "react";

import { navigate } from "../utils/navigation";

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { readonly to: string };

// A link to a page of this app: a real <a href>, so it opens in a new tab or copies like any link,
// but a plain click changes the view without loading the page again.
export function Link({ to, onClick, ...rest }: Props) {
  const onNavigate = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    const plain =
      event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
    if (event.defaultPrevented || !plain) return;
    event.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={onNavigate} {...rest} />;
}
