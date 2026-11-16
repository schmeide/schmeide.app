// Path routing on the History API, with no router library. `navigate` changes the address without
// a page load; `subscribe` tells a listener when it changed, by `navigate` or by Back and Forward.
const NAVIGATED = "schmeide:navigate";

export const currentLocation = (): string => window.location.pathname + window.location.search;

export const subscribe = (onChange: () => void): (() => void) => {
  window.addEventListener("popstate", onChange);
  window.addEventListener(NAVIGATED, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(NAVIGATED, onChange);
  };
};

// `replace` swaps the current history entry, so Back does not return to a redirect.
export const navigate = (to: string, { replace = false }: { readonly replace?: boolean } = {}) => {
  if (to === currentLocation()) return;
  if (replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  window.dispatchEvent(new Event(NAVIGATED));
};

// Leaves the app for another site (a provider's sign-in page) with a full page load.
export const leaveTo = (url: string) => window.location.assign(url);
