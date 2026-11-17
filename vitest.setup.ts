import "@testing-library/jest-dom/vitest";

// Remembered choices (utils/stored.ts) must not leak from one test into the next.
afterEach(() => {
  localStorage.clear();
});
