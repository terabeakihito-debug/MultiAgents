import { defineConfig } from "vitest/config";
import { heavyVitestFiles } from "./test/vitest-suite-files";
import { sharedVitestConfig } from "./vitest.shared";

export default defineConfig({
  ...sharedVitestConfig,
  test: {
    ...sharedVitestConfig.test,
    include: [...heavyVitestFiles],
    fileParallelism: false,
  },
});
