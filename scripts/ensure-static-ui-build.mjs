import { spawn } from "node:child_process";
import { isStaticUiBuildAvailable } from "../src/server/static-ui-artifacts.mjs";

async function main() {
  if (await isStaticUiBuildAvailable()) {
    return;
  }

  console.info(
    "static_ui_build",
    JSON.stringify({ phase: "next_build", reason: "missing_output" }),
  );
  await runNextBuild();
}

function runNextBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["./node_modules/next/dist/bin/next", "build"], {
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
          `next build failed: code=${code ?? "null"} signal=${signal ?? "null"}`,
        ),
      );
    });
  });
}

await main();
