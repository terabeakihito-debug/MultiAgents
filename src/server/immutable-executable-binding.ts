import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { securePrivateDirectory } from "./state-path";

const RUNTIME_BINDING_ROOT = join(homedir(), ".multiagents", "runtime", "provider-bindings");

export type ExecutableContentIdentity = {
  digest: string;
  dev: number;
  ino: number;
  size: number;
  ctimeMs: number;
  mode: number;
  uid: number;
  gid: number;
};

export type ImmutableExecutableBinding = {
  path: string;
  digest: string;
  cleanup: () => Promise<void>;
};
export type RuntimeArtifact = { name: string; sourcePath: string; identity: ExecutableContentIdentity; executable?: boolean };
export type ImmutableRuntimeBinding = { directory: string; paths: Readonly<Record<string, string>>; aggregateDigest: string; cleanup: () => Promise<void> };

/**
 * Runtime aggregate identity deliberately describes logical roles rather than
 * source filesystem permissions.  Staging tightens source files to 0500/0400;
 * that security transformation must not make an otherwise unchanged approved
 * runtime appear different.
 */
export function aggregateRuntimeArtifactIdentity(artifacts: readonly Pick<RuntimeArtifact, "name" | "identity" | "executable">[]) {
  const hash = createHash("sha256");
  for (const artifact of [...artifacts].sort((a, b) => a.name.localeCompare(b.name))) {
    const role = artifact.executable === false ? "runtime-data" : "executable";
    const canonicalMode = artifact.executable === false ? "0400" : "0500";
    hash.update(`${artifact.name}\0${role}\0${artifact.identity.digest}\0${canonicalMode}\n`);
  }
  return hash.digest("hex");
}

/** Reads metadata and bytes from one O_NOFOLLOW file object. */
export async function executableContentIdentity(path: string, executable = true): Promise<ExecutableContentIdentity> {
  const handle = await openSource(path);
  try {
    const before = await checkedFileStat(handle, executable);
    const digest = await digestHandle(handle);
    const after = await checkedFileStat(handle, executable);
    if (!sameObject(before, after)) throw new Error("Provider executable changed while being read");
    return { digest, ...fileMetadata(before) };
  } finally { await handle.close(); }
}

/**
 * Copies the approved bytes out of the opened source object before Bubblewrap
 * ever sees a pathname. The returned private file is the only Codex mount.
 */
export async function prepareImmutableExecutableBinding(sourcePath: string, approved: ExecutableContentIdentity): Promise<ImmutableExecutableBinding> {
  const binding = await prepareImmutableRuntimeBinding([{ name: "codex", sourcePath, identity: approved }]);
  return { path: binding.paths.codex, digest: approved.digest, cleanup: binding.cleanup };
}

/** Stages a minimal, deterministic runtime view from approved file objects. */
export async function prepareImmutableRuntimeBinding(artifacts: readonly RuntimeArtifact[]): Promise<ImmutableRuntimeBinding> {
  if (!artifacts.length || new Set(artifacts.map((artifact) => artifact.name)).size !== artifacts.length || artifacts.some((artifact) => !/^[A-Za-z0-9._-]{1,80}$/.test(artifact.name))) throw new Error("Provider runtime artifact layout is invalid");
  secureBindingRoot();
  const directory = join(RUNTIME_BINDING_ROOT, randomUUID());
  try {
    await mkdir(directory, { mode: 0o700 });
    const paths: Record<string, string> = {};
    const stagedArtifacts: RuntimeArtifact[] = [];
    for (const artifact of [...artifacts].sort((a, b) => a.name.localeCompare(b.name))) {
      const targetPath = join(directory, artifact.name);
      const source = await openSource(artifact.sourcePath);
      try {
        const before = await checkedFileStat(source, artifact.executable !== false);
        const target = await open(targetPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, artifact.executable === false ? 0o400 : 0o500);
        try {
          const hash = createHash("sha256"); const buffer = Buffer.allocUnsafe(64 * 1024); let position = 0;
          for (;;) {
            const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
            if (!bytesRead) break;
            const chunk = buffer.subarray(0, bytesRead); hash.update(chunk); await target.write(chunk, 0, bytesRead, position); position += bytesRead;
          }
          await target.sync();
          const digest = hash.digest("hex"); const after = await checkedFileStat(source, artifact.executable !== false);
          if (!sameObject(before, after) || !matchesApproved(before, artifact.identity) || digest !== artifact.identity.digest) throw new Error(`Approved provider runtime artifact changed before immutable binding (${artifact.name})`);
          await chmod(targetPath, artifact.executable === false ? 0o400 : 0o500);
          const stagedIdentity = await executableContentIdentity(targetPath, artifact.executable !== false);
          if (stagedIdentity.digest !== digest) throw new Error(`Staged provider runtime artifact changed during binding (${artifact.name})`);
          stagedArtifacts.push({ ...artifact, identity: stagedIdentity });
          paths[artifact.name] = targetPath;
        } finally { await target.close(); }
      } finally { await source.close(); }
    }
    await fsyncDirectory(directory);
    const aggregateDigest = aggregateRuntimeArtifactIdentity(stagedArtifacts);
    return { directory, paths, aggregateDigest, cleanup: async () => { await rm(directory, { recursive: true, force: true }); } };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function secureBindingRoot() {
  securePrivateDirectory(join(homedir(), ".multiagents"));
  securePrivateDirectory(join(homedir(), ".multiagents", "runtime"));
  securePrivateDirectory(RUNTIME_BINDING_ROOT);
}

async function openSource(path: string) {
  const link = await lstat(path);
  if (link.isSymbolicLink() || !link.isFile() || await realpath(path) !== path) throw new Error("Provider executable must be a regular non-symlink file");
  return open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
}

async function checkedFileStat(handle: Awaited<ReturnType<typeof open>>, executable: boolean) {
  const info = await handle.stat();
  if (!info.isFile() || (executable && (info.mode & 0o111) === 0)) throw new Error("Provider runtime artifact is not a regular required file");
  return info;
}

async function digestHandle(handle: Awaited<ReturnType<typeof open>>) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) return hash.digest("hex");
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
}

function sameObject(a: Awaited<ReturnType<typeof checkedFileStat>>, b: Awaited<ReturnType<typeof checkedFileStat>>) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.ctimeMs === b.ctimeMs && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid;
}
function fileMetadata(info: Awaited<ReturnType<typeof checkedFileStat>>) { return { dev: info.dev, ino: info.ino, size: info.size, ctimeMs: info.ctimeMs, mode: info.mode & 0o777, uid: info.uid, gid: info.gid }; }
function matchesApproved(info: Awaited<ReturnType<typeof checkedFileStat>>, approved: ExecutableContentIdentity) {
  const current = fileMetadata(info);
  return current.dev === approved.dev && current.ino === approved.ino && current.size === approved.size && current.ctimeMs === approved.ctimeMs && current.mode === approved.mode && current.uid === approved.uid && current.gid === approved.gid;
}
async function fsyncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); }
  finally { closeSync(fd); }
}
