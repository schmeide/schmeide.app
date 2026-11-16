/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// One config for the dev server, the build, and Vitest. `base` is "/" because
// the site is served from the custom domain in public/CNAME, not a
// github.io/<repo>/ subpath.
export default defineConfig({
  base: "/",
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/__tests__/*.{test,spec}.{ts,tsx}"],
    exclude: ["node_modules", "dist"],
  },
});
