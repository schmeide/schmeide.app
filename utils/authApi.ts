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

// The provider page an /api/auth route answers with, to send the browser to.
const providerPage = async (path: string, body: unknown): Promise<string | null> => {
  try {
    const { status, data } = await post(path, body);
    const url = typeof data === "object" && data && "url" in data ? data.url : null;
    return status === 200 && typeof url === "string" ? url : null;
  } catch {
    return null;
  }
};

// The provider's own sign-in page. It returns the person to `next` on this site, or to the
// sign-in page with `error=<reason>` when they are refused.
export const providerSignInUrl = (provider: Provider, next: string): Promise<string | null> => {
  const here = window.location.origin;
  return providerPage("/sign-in/social", {
    provider,
    callbackURL: here + next,
    errorCallbackURL: `${here}/sign-in?next=${encodeURIComponent(next)}`,
  });
};

// The provider's page that adds it as a way to sign in to the signed-in person's account. It
// returns the person to `back`, with `error=<reason>` when the provider account was refused.
export const connectProviderUrl = (provider: Provider, back: string): Promise<string | null> => {
  const here = window.location.origin;
  return providerPage("/link-social", {
    provider,
    callbackURL: here + back,
    errorCallbackURL: here + back,
  });
};

export const signOut = async (): Promise<void> => {
  await post("/sign-out", {}).catch(() => undefined);
};
