import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { spawn } from "node:child_process";

const sourceRoot = "src";
const outputRoot = "dist-daemon";

await rm(outputRoot, { recursive: true, force: true });

await run(process.execPath, [
  "./node_modules/typescript/bin/tsc",
  "-p",
  "tsconfig.daemon.json",
]);

await copyMjs(sourceRoot);

async function copyMjs(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const source = join(root, entry.name);

    if (entry.isDirectory()) {
      await copyMjs(source);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;

    const destination = join(outputRoot, relative(sourceRoot, source));
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination);
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
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
          `daemon build command failed: code=${code ?? "null"} signal=${signal ?? "null"}`,
        ),
      );
    });
  });
}
