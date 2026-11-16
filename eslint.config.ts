import eslint from "@eslint/js";
import pluginVitest from "@vitest/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "**/node_modules/**"] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  reactHooks.configs.flat["recommended-latest"],
  {
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["server/**"],
    languageOptions: { globals: globals.node },
  },
  {
    ...pluginVitest.configs.recommended,
    files: ["**/__tests__/*"],
  }
);
