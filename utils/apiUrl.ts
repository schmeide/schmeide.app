// Where the API is. The hosted site sets VITE_API_URL to the server's address at build time;
// without it (`make serve`) it is /api on this site, which Vite proxies to the server.
const hosted = String(import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");

// True when the build was told where its API is, so a slow answer is worth waiting for.
export const hasHostedApi = hosted !== "";

const base = hasHostedApi ? hosted : "/api";

export const apiUrl = (path: string): string => `${base}${path}`;
