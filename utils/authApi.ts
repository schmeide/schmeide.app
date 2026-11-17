import { apiUrl } from "./apiUrl";
import type { Provider } from "./session";

// Sign-in and sign-out are the server's own routes under /auth, not tRPC procedures: they set
// and clear the session cookie. Plain fetch, so no auth library ships to the browser.
const post = async (path: string, body: unknown) => {
  const response = await fetch(apiUrl(`/auth${path}`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  const data: unknown = await response.json().catch(() => null);
  return { status: response.status, data };
};

export type PasswordSignIn = "ok" | "wrong" | "notApproved" | "tooMany" | "failed";

export const signInWithPassword = async (
  email: string,
  password: string
): Promise<PasswordSignIn> => {
  try {
    const { status } = await post("/sign-in/email", { email, password });
    if (status === 200) return "ok";
    if (status === 401 || status === 400) return "wrong";
    if (status === 403) return "notApproved";
    if (status === 429) return "tooMany";
    return "failed";
  } catch {
    return "failed";
  }
};

// The provider's own sign-in page, to send the browser to. It returns the person to `next` on
// this site, or to the sign-in page with `error=<reason>` when they are refused.
export const providerSignInUrl = async (
  provider: Provider,
  next: string
): Promise<string | null> => {
  const here = window.location.origin;
  try {
    const { status, data } = await post("/sign-in/social", {
      provider,
      callbackURL: here + next,
      errorCallbackURL: `${here}/sign-in?next=${encodeURIComponent(next)}`,
    });
    const url = typeof data === "object" && data && "url" in data ? data.url : null;
    return status === 200 && typeof url === "string" ? url : null;
  } catch {
    return null;
  }
};

export const signOut = async (): Promise<void> => {
  await post("/sign-out", {}).catch(() => undefined);
};
