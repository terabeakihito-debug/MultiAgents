import { fileURLToPath } from "node:url";
import type { UserConfig } from "vitest/config";

export const sharedVitestConfig = {
  test: {
    setupFiles: ["./test/ownership-isolation.ts"],
  },
  resolve: {
    alias: {
      "server-only": fileURLToPath(new URL("./node_modules/next/dist/compiled/server-only/empty.js", import.meta.url)),
    },
  },
} satisfies UserConfig;
