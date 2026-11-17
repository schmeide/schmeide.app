/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { copyFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

// GitHub Pages answers an address it has no file for (/sign-in, /set-password, /projects/7) with
// 404.html. A copy of the app there lets it load and route the address itself, which invite
// links and provider sign-in returns rely on.
const spaFallback = (): Plugin => ({
  name: "spa-fallback",
  apply: "build",
  closeBundle: () => copyFileSync("dist/index.html", "dist/404.html"),
});

// One config for the dev server, the build, and Vitest. `base` is "/" because
// the site is served from the custom domain in public/CNAME, not a
// github.io/<repo>/ subpath.
export default defineConfig({
  base: "/",
  plugins: [react(), spaFallback()],
  // `make serve` runs the platform server on :3100 (see server/src/main.ts). The browser calls
  // /api on this origin, so the session cookie is first-party; the server itself has no /api.
  server: {
    proxy: {
      "/api": { target: "http://localhost:3100", rewrite: (path) => path.replace(/^\/api/, "") },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/__tests__/*.{test,spec}.{ts,tsx}"],
    exclude: ["**/node_modules/**", "dist", "server/**", ".claude/worktrees/**"],
  },
});
