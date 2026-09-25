import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  js.configs.recommended,
  ...tseslint.configs.recommended,
  globalIgnores([".next/**", "out/**", "coverage/**", "dist-daemon/**", "dist-ui/**"]),
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["src/app/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    rules: {
      "no-control-regex": "off",
      "no-constant-condition": "off",
      "no-useless-escape": "off",
    },
  },
]);
