import { constants } from "node:fs";
import { lstat, mkdtemp, mkdir, open, readFile, readlink, realpath, readdir, stat, symlink, writeFile, type FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { runGit, runGitMktree, runGitReadOnly } from "./git";

export const ALLOWED_ROOT = join(homedir(), "code");
export type Repository = { id: string; name: string; branch: string; dirty: boolean; initializationRequired: boolean; initializationRepairRequired: boolean };
export type ValidatedRepository = Repository & { path: string };
export type GitHubProject = { owner: string; repo: string; url: string };

function isWithin(root: string, candidate: string) {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !/^\/mnt\/[a-z](?:\/|$)/i.test(resolve(candidate));
}

function safeProjectId(value: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value) || value === "." || value === "..") throw new Error("Project name is invalid");
  return value;
}

const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const ONBOARDING_DIRECTORY = ".multiagents-onboarding";
const STARTER_README = (id: string) => `# ${id}\n\nThis project was created with MultiAgents.\n`;
const onboardingMutexes = new Set<string>();
type StarterMetadata = { version: 1; expectedStarter: boolean; blob?: string; contentHash?: string };
type InitializationPending = { version: 1; commit: string; tree: string; ref: string; blob?: string; contentHash?: string };
type InitializationComplete = InitializationPending;
let onboardingHookForTests: ((stage: "before-publication" | "before-publication-copy" | "before-completion" | "after-readme-verification" | "before-initial-tree" | "before-initial-ref" | "after-initial-ref" | "before-initialization-completion" | "before-initialization-completion-create", details: { target?: string; staging?: string; repoPath?: string }) => Promise<void> | void) | undefined;

/** Test-only deterministic boundary for filesystem and Git race regression tests. */
export function setRepositoryOnboardingHookForTests(hook?: typeof onboardingHookForTests) { onboardingHookForTests = hook; }
async function onboardingHook(stage: "before-publication" | "before-publication-copy" | "before-completion" | "after-readme-verification" | "before-initial-tree" | "before-initial-ref" | "after-initial-ref" | "before-initialization-completion" | "before-initialization-completion-create", details: { target?: string; staging?: string; repoPath?: string }) { await onboardingHookForTests?.(stage, details); }

export function parseGitHubProjectUrl(value: string): GitHubProject {
  if (typeof value !== "string" || value.length > 500) throw new Error("GitHub URL is not supported");
  if (value !== value.trim()) throw new Error("GitHub URL is not supported");
  const url = value;
  const match = url.match(/^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9][A-Za-z0-9._-]*?)(?:\.git)?$/)
    ?? url.match(/^git@github\.com:([A-Za-z0-9-]+)\/([A-Za-z0-9][A-Za-z0-9._-]*?)(?:\.git)?$/);
  if (!match || !GITHUB_OWNER.test(match[1])) throw new Error("GitHub URL is not supported");
  return { owner: match[1], repo: match[2], url };
}

async function newProjectTarget(id: string, root: string) {
  const realRoot = await realpath(root);
  if (/^\/mnt\/[a-z](?:\/|$)/i.test(realRoot)) throw new Error("Windows mounted drives cannot be repository roots");
  const target = join(realRoot, id);
  if (!isWithin(realRoot, target)) throw new Error("Project path is outside the managed projects folder");
  try { await lstat(target); throw new Error("Project already exists"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return { realRoot, target };
}

async function withProjectReservation<T>(id: string, root: string, operation: (input: { root: string; target: string; staging: string; privateRoot: string }) => Promise<T>) {
  const { realRoot, target } = await newProjectTarget(id, root);
  const { privateRoot } = await onboardingDirectories(realRoot);
  return withOnboardingMutex(`publish:${target}`, "This project is already being added", async () => {
    // Repeat target verification after obtaining the per-name reservation.
    try { await lstat(target); throw new Error("Project already exists"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const staging = await mkdtemp(join(privateRoot, "operation-"));
    // Failed staging is deliberately quarantined. It is never recursively
    // removed automatically because its path may have been replaced.
    return operation({ root: realRoot, target, staging, privateRoot });
  });
}

async function onboardingDirectories(realRoot: string) {
  const privateRoot = join(realRoot, ONBOARDING_DIRECTORY);
  const projects = join(privateRoot, "projects");
  for (const directory of [privateRoot, projects]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const [info, resolved] = await Promise.all([lstat(directory), realpath(/*turbopackIgnore: true*/ directory)]);
    if (!info.isDirectory() || info.isSymbolicLink() || resolved !== directory || !isWithin(realRoot, resolved)) throw new Error("Project onboarding directory is unsafe");
  }
  return { privateRoot, projects };
}

async function withOnboardingMutex<T>(key: string, busyMessage: string, operation: () => Promise<T>) {
  // Server ownership permits one MultiAgents process per user/runtime; this
  // in-process mutex therefore serializes all application onboarding writers.
  // Filesystem publication still uses exclusive mkdir for external writers.
  if (onboardingMutexes.has(key)) throw new Error(busyMessage);
  onboardingMutexes.add(key);
  try { return await operation(); }
  finally { onboardingMutexes.delete(key); }
}

function metadataPath(projects: string, target: string) {
  return join(projects, `${createHash("sha256").update(target).digest("hex")}.json`);
}

async function writeStarterMetadata(projects: string, target: string, metadata: StarterMetadata) {
  const path = metadataPath(projects, target);
  await writeFile(path, JSON.stringify(metadata), { encoding: "utf8", mode: 0o600, flag: "wx" });
}

function completionPath(projects: string, target: string) { return `${metadataPath(projects, target)}.ready`; }
function initializationPendingPath(projects: string, target: string) { return `${metadataPath(projects, target)}.initialization-pending`; }
function initializationCompletionPrefix(projects: string, target: string) { return `${metadataPath(projects, target)}.initialization-complete-`; }

async function markOnboardingReady(projects: string, target: string) {
  // This is monotonic and private. We never delete or replace public project files
  // merely to transition an onboarding operation to visible.
  await writeFile(completionPath(projects, target), "ready\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
}

async function onboardingIsReady(realRoot: string, target: string) {
  const projects = join(realRoot, ONBOARDING_DIRECTORY, "projects");
  const metadata = metadataPath(projects, target);
  try { await lstat(metadata); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
  try {
    const ready = await lstat(completionPath(projects, target));
    return ready.isFile() && !ready.isSymbolicLink() && (await readFile(completionPath(projects, target), "utf8")) === "ready\n";
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function readInitializationPending(projects: string, target: string): Promise<InitializationPending | undefined> {
  const path = initializationPendingPath(projects, target);
  let info;
  try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Project initialization recovery metadata is unsafe");
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")); } catch { throw new Error("Project initialization recovery metadata is invalid"); }
  const pending = value as InitializationPending;
  if (!pending || pending.version !== 1 || !/^[0-9a-f]{40,64}$/i.test(pending.commit) || !/^[0-9a-f]{40,64}$/i.test(pending.tree) || !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(pending.ref) || (pending.blob !== undefined && !/^[0-9a-f]{40,64}$/i.test(pending.blob)) || (pending.contentHash !== undefined && !/^[0-9a-f]{64}$/i.test(pending.contentHash))) throw new Error("Project initialization recovery metadata is invalid");
  return pending;
}

function sameInitializationRecord(left: InitializationComplete, right: InitializationPending) {
  return left.version === 1 && left.commit === right.commit && left.tree === right.tree && left.ref === right.ref && left.blob === right.blob && left.contentHash === right.contentHash;
}

async function initializationIsComplete(projects: string, target: string, pending: InitializationPending | undefined) {
  if (!pending) return false;
  let entries: string[];
  try { entries = await readdir(projects); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  const prefix = initializationCompletionPrefix(projects, target);
  for (const entry of entries.filter((name) => name.startsWith(basename(prefix)) && name.endsWith(".json"))) {
    const path = join(projects, entry);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      const value = JSON.parse(await readFile(path, "utf8")) as InitializationComplete;
      if (sameInitializationRecord(value, pending)) return true;
    } catch { /* malformed partial records are inert; a later immutable record can complete recovery. */ }
  }
  return false;
}

async function writeInitializationPending(projects: string, target: string, pending: InitializationPending) {
  await writeFile(initializationPendingPath(projects, target), JSON.stringify(pending), { encoding: "utf8", mode: 0o600, flag: "wx" });
}

async function markInitializationComplete(projects: string, target: string, pending: InitializationPending) {
  if (await initializationIsComplete(projects, target, pending)) return;
  // Immutable, exclusively-created generations make partial writes inert and
  // ensure a competing object is never replaced. A retry chooses a new name.
  for (let attempt = 0; attempt < 8; attempt++) {
    const path = `${initializationCompletionPrefix(projects, target)}${randomUUID()}.json`;
    await onboardingHook("before-initialization-completion-create", { target: path });
    let handle: FileHandle;
    try { handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; throw error; }
    try {
      await handle.writeFile(JSON.stringify(pending), "utf8");
      await handle.sync();
      return;
    } finally { await handle.close(); }
  }
  throw new Error("Project completion generation could not be reserved");
}

async function initializationRepairRequired(realRoot: string, target: string) {
  const projects = join(realRoot, ONBOARDING_DIRECTORY, "projects");
  const pending = await readInitializationPending(projects, target);
  return Boolean(pending) && !await initializationIsComplete(projects, target, pending);
}

async function readStarterMetadata(projects: string, target: string): Promise<StarterMetadata> {
  const path = metadataPath(projects, target);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Project initialization metadata is unsafe");
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")); } catch { throw new Error("Project initialization metadata is invalid"); }
  if (!value || typeof value !== "object" || (value as StarterMetadata).version !== 1 || typeof (value as StarterMetadata).expectedStarter !== "boolean") throw new Error("Project initialization metadata is invalid");
  const metadata = value as StarterMetadata;
  if (metadata.expectedStarter && (!/^[0-9a-f]{40,64}$/i.test(metadata.blob ?? "") || !/^[0-9a-f]{64}$/i.test(metadata.contentHash ?? ""))) throw new Error("Project initialization metadata is invalid");
  return metadata;
}

function procPath(fd: number, entry = "") {
  if (process.platform !== "linux") throw new Error("Safe project publication requires Linux descriptor paths");
  return `/proc/self/fd/${fd}${entry ? `/${entry}` : ""}`;
}

async function copyFilePinned(source: string, destination: string, mode: number) {
  const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await sourceHandle.stat()).isFile()) throw new Error("Project staging contains an unsupported filesystem object");
    const destinationHandle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (true) {
        const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        let written = 0;
        while (written < bytesRead) {
          const result = await destinationHandle.write(buffer, written, bytesRead - written, position + written);
          written += result.bytesWritten;
        }
        position += bytesRead;
      }
      await destinationHandle.chmod(mode);
    } finally { await destinationHandle.close(); }
  } finally { await sourceHandle.close(); }
}

async function copyTreePinned(sourceHandle: FileHandle, destinationDirectory: string, closeSource = false) {
  let destinationHandle: FileHandle | undefined;
  try {
    destinationHandle = await open(destinationDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    for (const entry of await readdir(procPath(sourceHandle.fd))) {
      if (entry === "." || entry === "..") throw new Error("Project staging entry is invalid");
      const source = procPath(sourceHandle.fd, entry);
      const destination = procPath(destinationHandle.fd, entry);
      const info = await lstat(source);
      const mode = info.mode & 0o777;
      if (info.isDirectory() && !info.isSymbolicLink()) {
        await mkdir(destination, { mode });
        const child = await open(source, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        await copyTreePinned(child, destination, true);
      } else if (info.isFile() && !info.isSymbolicLink()) {
        await copyFilePinned(source, destination, mode);
      } else if (info.isSymbolicLink()) {
        // Both parent directories are descriptor-pinned and symlink() never follows
        // the final destination component; an existing entry therefore fails closed.
        await symlink(await readlink(source), destination);
      } else throw new Error("Project staging contains an unsupported filesystem object");
    }
  } finally {
    await destinationHandle?.close();
    if (closeSource) await sourceHandle.close();
  }
}

async function withPinnedStagedRepository<T>(staging: string, id: string, operation: (path: string, handle: FileHandle) => Promise<T>) {
  const operationHandle = await open(staging, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const repositoryHandle = await open(procPath(operationHandle.fd, id), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { return await operation(procPath(repositoryHandle.fd), repositoryHandle); }
    finally { await repositoryHandle.close(); }
  } finally { await operationHandle.close(); }
}

async function publishStagedProject(source: FileHandle, stagingPath: string, target: string, root: string, projects: string, expectedGitHub?: GitHubProject) {
  await onboardingHook("before-publication", { target, staging: stagingPath });
  try { await mkdir(target, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Project already exists"); throw error; }
  await onboardingHook("before-publication-copy", { target });
  await copyTreePinned(source, target);
  const repository = await validateRepository(basename(target), root, { allowOnboardingIncomplete: true });
  if (expectedGitHub) {
    const actual = parseGitHubProjectUrl(await runGit(repository.path, ["remote", "get-url", "origin"]));
    if (actual.owner.toLowerCase() !== expectedGitHub.owner.toLowerCase() || actual.repo.toLowerCase() !== expectedGitHub.repo.toLowerCase()) throw new Error("Repository validation failed: final origin does not match the requested GitHub project");
  }
  await onboardingHook("before-completion", { target });
  await markOnboardingReady(projects, target);
}

/** Applies the normal Git safety contract through a descriptor-pinned staging path. */
async function validatePinnedStagedRepository(id: string, path: string): Promise<ValidatedRepository> {
  const [canonical, top] = await Promise.all([
    realpath(path),
    runGitReadOnly(path, ["rev-parse", "--show-toplevel"]).then(realpath),
  ]);
  if (top !== canonical) throw new Error("Repository must be a Git working tree rooted directly under ~/code");
  const branch = await runGitReadOnly(path, ["branch", "--show-current"]);
  if (!branch) throw new Error("Detached HEAD repositories are not supported");
  const dirty = Boolean(await runGitReadOnly(path, ["status", "--porcelain"]));
  const initializationRequired = await hasNoInitialCommit(path);
  return { id, name: id, path, branch, dirty, initializationRequired, initializationRepairRequired: false };
}

export async function cloneGitHubProject(githubUrl: string, root = ALLOWED_ROOT, clone: (cwd: string, url: string, target: string) => Promise<void> = async (cwd, url, target) => { await runGit(cwd, ["clone", "--", url, target]); }) {
  const github = parseGitHubProjectUrl(githubUrl);
  const id = safeProjectId(github.repo);
  const realRoot = await realpath(root);
  const existing = await listRepositories(realRoot);
  for (const item of existing) {
    try {
      const origin = await runGit(join(realRoot, item.id), ["remote", "get-url", "origin"]);
      const other = parseGitHubProjectUrl(origin);
      if (other.owner.toLowerCase() === github.owner.toLowerCase() && other.repo.toLowerCase() === github.repo.toLowerCase()) throw new Error(`This GitHub project is already available as ${item.name}`);
    } catch (error) { if (error instanceof Error && error.message.startsWith("This GitHub project")) throw error; }
  }
  return withProjectReservation(id, realRoot, async ({ root: reservedRoot, target, staging }) => {
    const staged = join(staging, id);
    // The URL and destination are validated server-owned arguments; the production clone uses runGit's fixed binary, safe config, environment, output, and timeout controls.
    await clone(staging, github.url, staged);
    await withPinnedStagedRepository(staging, id, async (pinnedPath, pinned) => {
      const repo = await validatePinnedStagedRepository(id, pinnedPath);
      const actual = parseGitHubProjectUrl(await runGit(repo.path, ["remote", "get-url", "origin"]));
      if (actual.owner.toLowerCase() !== github.owner.toLowerCase() || actual.repo.toLowerCase() !== github.repo.toLowerCase()) throw new Error("Repository validation failed: origin does not match the requested GitHub project");
      const { projects } = await onboardingDirectories(reservedRoot);
      await writeStarterMetadata(projects, target, { version: 1, expectedStarter: false });
      await publishStagedProject(pinned, staged, target, reservedRoot, projects, github);
    });
    return validateRepository(id, reservedRoot);
  });
}

export async function createLocalProject(projectName: string, createReadme = false, root = ALLOWED_ROOT) {
  const id = safeProjectId(projectName);
  return withProjectReservation(id, root, async ({ root: reservedRoot, target, staging }) => {
    const staged = join(staging, id);
    await mkdir(staged, { mode: 0o700 });
    await runGit(staging, ["init", "--initial-branch=main", staged]);
    let metadata: StarterMetadata = { version: 1, expectedStarter: false };
    if (createReadme) {
      const content = STARTER_README(id);
      const readme = join(staged, "README.md");
      await writeFile(readme, content, { encoding: "utf8", mode: 0o600 });
      metadata = { version: 1, expectedStarter: true, blob: await runGit(staged, ["hash-object", "-w", "--", "README.md"]), contentHash: createHash("sha256").update(content).digest("hex") };
    }
    await withPinnedStagedRepository(staging, id, async (pinnedPath, pinned) => {
      await validatePinnedStagedRepository(id, pinnedPath);
      const { projects } = await onboardingDirectories(reservedRoot);
      await writeStarterMetadata(projects, target, metadata);
      await publishStagedProject(pinned, staged, target, reservedRoot, projects);
    });
    return validateRepository(id, reservedRoot);
  });
}

function isUnbornHeadError(error: unknown) {
  return error instanceof Error && error.message === "git exited with code 1";
}

async function verifyPendingPlan(repo: ValidatedRepository, pending: InitializationPending, metadata: StarterMetadata) {
  if (await runGitReadOnly(repo.path, ["symbolic-ref", "--quiet", "HEAD"]) !== pending.ref) throw new Error("Project history changed; initialization needs manual attention");
  if (metadata.expectedStarter !== Boolean(pending.blob) || metadata.blob !== pending.blob || metadata.contentHash !== pending.contentHash) throw new Error("Project initialization plan no longer matches its trusted starter metadata");
  if (await runGitReadOnly(repo.path, ["rev-parse", `${pending.commit}^{tree}`]) !== pending.tree) throw new Error("Project initialization plan is invalid");
  const expectedTree = pending.blob ? `100644 blob ${pending.blob}\tREADME.md` : "";
  if (await runGitReadOnly(repo.path, ["ls-tree", "-r", pending.tree]) !== expectedTree) throw new Error("Project initial commit is not the approved tree");
  if (pending.blob) {
    const readme = join(repo.path, "README.md");
    const info = await lstat(readme);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Starter README is no longer safe to initialize");
    if (createHash("sha256").update(await readFile(readme)).digest("hex") !== pending.contentHash || await runGitReadOnly(repo.path, ["hash-object", "--", "README.md"]) !== pending.blob) throw new Error("Starter README was changed; initialize it manually instead");
  }
}

async function verifyPendingInitialization(repo: ValidatedRepository, pending: InitializationPending, metadata: StarterMetadata) {
  await verifyPendingPlan(repo, pending, metadata);
  if (await runGitReadOnly(repo.path, ["rev-parse", "HEAD"]) !== pending.commit || await runGitReadOnly(repo.path, ["rev-parse", "HEAD^{tree}"]) !== pending.tree) throw new Error("Project history changed; initialization needs manual attention");
}

async function expectedRefIsUnborn(repo: ValidatedRepository, pending: InitializationPending) {
  if (await runGitReadOnly(repo.path, ["symbolic-ref", "--quiet", "HEAD"]) !== pending.ref) throw new Error("Project history changed; initialization needs manual attention");
  try {
    await runGitReadOnly(repo.path, ["rev-parse", "--verify", "-q", pending.ref]);
    return false;
  } catch (error) {
    if (isUnbornHeadError(error)) return true;
    throw error;
  }
}

async function readmeIndexIsSynchronized(repo: ValidatedRepository, pending: InitializationPending) {
  return !pending.blob || await runGitReadOnly(repo.path, ["ls-files", "--stage", "--", "README.md"]) === `100644 ${pending.blob} 0\tREADME.md`;
}

async function synchronizeAuthorizedReadme(repo: ValidatedRepository, pending: InitializationPending) {
  if (!pending.blob) return;
  if (await readmeIndexIsSynchronized(repo, pending)) return;
  await runGit(repo.path, ["update-index", "--add", "--cacheinfo", `100644,${pending.blob},README.md`]);
  if (!await readmeIndexIsSynchronized(repo, pending)) throw new Error("Project README index synchronization could not be verified");
}

function recoveryError() { return new Error("Initial commit was created, but project setup still needs completion. Retry Initialize project; no second commit will be created."); }

async function finishPendingInitialization(repo: ValidatedRepository, projects: string, pending: InitializationPending) {
  try {
    await synchronizeAuthorizedReadme(repo, pending);
    await onboardingHook("before-initialization-completion", { repoPath: repo.path });
    await markInitializationComplete(projects, repo.path, pending);
  } catch { throw recoveryError(); }
}

async function publishPendingInitialRef(repo: ValidatedRepository, pending: InitializationPending, metadata: StarterMetadata) {
  const { runServerGitMutation, ProcessExecutionError } = await import("./pull-request");
  const objectFormat = await runGitReadOnly(repo.path, ["rev-parse", "--show-object-format"]);
  const zero = objectFormat === "sha1" ? "0".repeat(40) : objectFormat === "sha256" ? "0".repeat(64) : (() => { throw new Error("Project object format is unsupported"); })();
  try {
    await runServerGitMutation(repo.path, ["update-ref", pending.ref, pending.commit, zero]);
    return;
  } catch (error) {
    // A concurrent actor may have created exactly the already-approved ref. In
    // that narrow case it is safe to continue the metadata/index recovery path.
    try { await verifyPendingInitialization(repo, pending, metadata); return; }
    catch {
      if (error instanceof ProcessExecutionError && /reference already exists|cannot lock ref|reference is missing but expected/i.test(error.result.stderr)) throw new Error("Project was initialized by another process");
      throw error;
    }
  }
}

/**
 * Initialization recovery state machine:
 * U (uncommitted) creates one trusted pending plan; P (plan/ref unborn) retries
 * only that plan's zero-old-value CAS; S (ref established/index pending) and C
 * (index synchronized/completion pending) verify the plan then advance only the
 * missing step; DONE has a matching immutable completion generation. Any other
 * trusted-state mismatch is a closed conflict requiring manual attention.
 */
export async function initializeLocalProject(repoId: string, root = ALLOWED_ROOT) {
  const id = safeProjectId(repoId);
  const realRoot = await realpath(root);
  const preliminary = await validateRepository(id, realRoot);
  return withOnboardingMutex(`initialize:${preliminary.path}`, "This project is already being initialized", async () => {
    const repo = await validateRepository(id, realRoot);
    const { projects } = await onboardingDirectories(realRoot);
    const pending = await readInitializationPending(projects, repo.path);
    const complete = await initializationIsComplete(projects, repo.path, pending);
    if (!repo.initializationRequired) {
      if (!pending || complete) throw new Error("Project already has an initial commit");
      const metadata = await readStarterMetadata(projects, repo.path);
      await verifyPendingInitialization(repo, pending, metadata);
      await finishPendingInitialization(repo, projects, pending);
      return validateRepository(id, realRoot);
    }
    if (complete) throw new Error("Project initialization state is inconsistent; manual attention is required");
    const metadata = await readStarterMetadata(projects, repo.path);
    if (pending) {
      await verifyPendingPlan(repo, pending, metadata);
      if (!await expectedRefIsUnborn(repo, pending)) throw new Error("Project history changed; initialization needs manual attention");
      await publishPendingInitialRef(repo, pending, metadata);
      await verifyPendingInitialization(repo, pending, metadata);
      await finishPendingInitialization(repo, projects, pending);
      return validateRepository(id, realRoot);
    }
    let blob: string | undefined;
    if (metadata.expectedStarter) {
      const readme = join(repo.path, "README.md");
      let info;
      try { info = await lstat(readme); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Starter README is missing; initialize it manually instead"); throw error; }
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Starter README is no longer safe to initialize");
      const verified = await readFile(readme);
      if (createHash("sha256").update(verified).digest("hex") !== metadata.contentHash) throw new Error("Starter README was changed; initialize it manually instead");
      await onboardingHook("after-readme-verification", { repoPath: repo.path });
      const verifiedDirectory = await mkdtemp(join(join(realRoot, ONBOARDING_DIRECTORY), "verified-"));
      const verifiedCopy = join(verifiedDirectory, "verified-readme");
      await writeFile(verifiedCopy, verified, { mode: 0o600, flag: "wx" });
      blob = await runGit(repo.path, ["hash-object", "-w", "--", verifiedCopy]);
      if (blob !== metadata.blob) throw new Error("Starter README verification failed");
    }
    await onboardingHook("before-initial-tree", { repoPath: repo.path });
    const tree = blob ? await runGitMktree(repo.path, Buffer.from(`100644 blob ${blob}\tREADME.md\n`, "utf8")) : await runGitMktree(repo.path, Buffer.alloc(0));
    const expectedTree = blob ? `100644 blob ${blob}\tREADME.md` : "";
    if (await runGitReadOnly(repo.path, ["ls-tree", "-r", tree]) !== expectedTree) throw new Error("Initial project tree did not match authorized content");
    const { runServerGitMutation } = await import("./pull-request");
    const commit = (await runServerGitMutation(repo.path, ["commit-tree", tree, "-m", "Initial project setup"])).stdout.trim();
    const ref = await runGitReadOnly(repo.path, ["symbolic-ref", "--quiet", "HEAD"]);
    if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)) throw new Error("Project initial branch is invalid");
    const state: InitializationPending = { version: 1, commit, tree, ref, blob, contentHash: metadata.contentHash };
    await writeInitializationPending(projects, repo.path, state);
    await onboardingHook("before-initial-ref", { repoPath: repo.path });
    await publishPendingInitialRef(repo, state, metadata);
    await onboardingHook("after-initial-ref", { repoPath: repo.path });
    await verifyPendingInitialization(repo, state, metadata);
    await finishPendingInitialization(repo, projects, state);
    return validateRepository(id, realRoot);
  });
}

async function hasNoInitialCommit(path: string) {
  try {
    await runGit(path, ["rev-parse", "--verify", "-q", "HEAD"]);
    return false;
  } catch (error) {
    // `rev-parse --verify -q HEAD` reports exactly code 1 (with no stderr) for
    // a valid repository that has no initial commit. Do not hide other errors.
    if (error instanceof Error && error.message === "git exited with code 1") return true;
    throw error;
  }
}

function isReservedOnboardingPath(realRoot: string, candidate: string) {
  const managementRoot = join(realRoot, ONBOARDING_DIRECTORY);
  return candidate === managementRoot || isWithin(managementRoot, candidate);
}

export async function validateRepository(id: string, root = ALLOWED_ROOT, options: { allowOnboardingIncomplete?: boolean } = {}): Promise<ValidatedRepository> {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === ".." || id === ONBOARDING_DIRECTORY) throw new Error("Invalid repository id");
  const realRoot = await realpath(root);
  if (/^\/mnt\/[a-z](?:\/|$)/i.test(realRoot)) throw new Error("Windows mounted drives cannot be repository roots");
  const candidate = await realpath(join(realRoot, id));
  if (!isWithin(realRoot, candidate)) throw new Error("Repository is outside the allowed root");
  if (isReservedOnboardingPath(realRoot, candidate)) throw new Error("Repository is in the reserved onboarding area");
  if (!(await stat(candidate)).isDirectory()) throw new Error("Repository is not a directory");
  if (!options.allowOnboardingIncomplete && !await onboardingIsReady(realRoot, candidate)) throw new Error("Repository publication is incomplete");
  const top = await realpath(await runGitReadOnly(candidate, ["rev-parse", "--show-toplevel"]));
  if (top !== candidate) throw new Error("Repository must be a Git working tree rooted directly under ~/code");
  const branch = await runGitReadOnly(candidate, ["branch", "--show-current"]);
  if (!branch) throw new Error("Detached HEAD repositories are not supported");
  const dirty = Boolean(await runGitReadOnly(candidate, ["status", "--porcelain"]));
  const initializationRequired = await hasNoInitialCommit(candidate);
  const initializationRepair = !initializationRequired && await initializationRepairRequired(realRoot, candidate);
  return { id, name: basename(candidate), path: candidate, branch, dirty, initializationRequired, initializationRepairRequired: initializationRepair };
}

export async function listRepositories(root = ALLOWED_ROOT): Promise<Repository[]> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return []; }
  const repos = await Promise.all(entries.filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && entry.name !== ONBOARDING_DIRECTORY).map(async (entry) => {
    try { const repo = await validateRepository(entry.name, root); return { id: repo.id, name: repo.name, branch: repo.branch, dirty: repo.dirty, initializationRequired: repo.initializationRequired, initializationRepairRequired: repo.initializationRepairRequired }; } catch { return undefined; }
  }));
  return repos.filter((repo): repo is Repository => Boolean(repo)).sort((a, b) => a.name.localeCompare(b.name));
}
