// Where the API is. Empty (the default) is this site's own origin, as in `make serve`, where Vite
// proxies /api. The hosted site sets VITE_API_URL to the server's address at build time.
const base = String(import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");

// True when the build was told where its API is, so a slow answer is worth waiting for.
export const hasHostedApi = base !== "";

export const apiUrl = (path: string): string => `${base}${path}`;
