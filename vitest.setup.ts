import "@testing-library/jest-dom/vitest";

// Remembered choices (utils/stored.ts) and unsent drafts (components/useDraft.ts) must not leak
// from one test into the next.
afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
