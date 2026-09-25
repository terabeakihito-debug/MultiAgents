import { spawn } from "node:child_process";
import {
  isNextAppUiBuildAvailable,
  isViteUiBuildAvailable,
} from "../src/server/static-ui-artifacts.mjs";

async function main() {
  if (!(await isViteUiBuildAvailable())) {
    console.info(
      "static_ui_build",
      JSON.stringify({ phase: "vite_build", reason: "missing_dist_ui" }),
    );
    await runViteBuild();
  }

  if (!(await isNextAppUiBuildAvailable())) {
    console.info(
      "static_ui_build",
      JSON.stringify({ phase: "next_build", reason: "missing_next_app_html" }),
    );
    await runNextBuild();
  }
}

function runViteBuild() {
  return run(process.execPath, ["./node_modules/vite/bin/vite.js", "build"]);
}

function runNextBuild() {
  return run(process.execPath, ["./node_modules/next/dist/bin/next", "build"]);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
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
          `static ui build command failed: code=${code ?? "null"} signal=${signal ?? "null"}`,
        ),
      );
    });
  });
}

await main();
