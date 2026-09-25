import { spawn } from "node:child_process";
import { isViteUiBuildAvailable } from "../src/server/static-ui-artifacts.mjs";

async function main() {
  if (await isViteUiBuildAvailable()) {
    return;
  }

  console.info(
    "static_ui_build",
    JSON.stringify({ phase: "vite_build", reason: "missing_dist_ui" }),
  );
  await runViteBuild();
}

function runViteBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["./node_modules/vite/bin/vite.js", "build"], {
      cwd: process.cwd(),
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `vite build failed: code=${code ?? "null"} signal=${signal ?? "null"}`,
        ),
      );
    });
  });
}

await main();
