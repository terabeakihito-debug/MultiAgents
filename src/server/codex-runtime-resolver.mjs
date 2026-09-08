import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

const entrypoint = process.argv[2];
const architecture = process.argv[3];
if (!entrypoint || !isAbsolute(entrypoint) || !["x64", "arm64"].includes(architecture)) process.exit(2);

const mainPackageRoot = realpathSync(join(dirname(entrypoint), ".."));
const triple = architecture === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl";
const optionalPackageName = architecture === "arm64" ? "codex-linux-arm64" : "codex-linux-x64";
const optionalSpecifier = `@openai/${optionalPackageName}`;
const resolver = createRequire(entrypoint);

function within(path, root) {
  const value = relative(root, path);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`));
}

let value;
try {
  const packageJson = realpathSync(resolver.resolve(`${optionalSpecifier}/package.json`));
  const packageRoot = dirname(packageJson);
  const installRoot = resolver.resolve.paths(optionalSpecifier)
    ?.map((searchRoot) => join(searchRoot, optionalSpecifier))
    .map((candidate) => { try { return realpathSync(candidate); } catch { return undefined; } })
    .find((candidate) => candidate && within(packageRoot, candidate));
  if (!installRoot) process.exit(3);
  value = { source: "optional", mainPackageRoot, installRoot, packageRoot, packageJson, nativeExecutable: join(packageRoot, "vendor", triple, "bin", "codex"), optionalPackageName };
} catch {
  value = { source: "vendor", mainPackageRoot, installRoot: mainPackageRoot, packageRoot: mainPackageRoot, packageJson: join(mainPackageRoot, "package.json"), nativeExecutable: join(mainPackageRoot, "vendor", triple, "bin", "codex"), optionalPackageName };
}
process.stdout.write(`${JSON.stringify(value)}\n`);
