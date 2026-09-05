import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { GIT_BINARY, runGit } from "./git";
import { validateRepository } from "./repositories";
import { validationScript, validationTimeoutMs, type ValidationStep } from "../profiles/policy";
import { acquireTaskLock, clearTaskLocksForTests, isTaskLocked, releaseTaskLock } from "./task-lock";
import {
  MAX_UNTRACKED_FILE_BYTES,
  MAX_UNTRACKED_TOTAL_BYTES,
  TASK_BRANCH_PATTERN,
  getTask,
  getTaskDiff,
  invalidateApproval,
  persistTask,
  publicTask,
  recordApprovalEvent,
  recordDiffVersion,
  recordTaskEvent,
  requireTaskProfile,
  requireTaskTemplate,
  transitionTask,
  type RepoTask,
  type SecretFinding,
} from "./tasks";

export const GH_BINARY = "/usr/bin/gh";
export const COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_OUTPUT_BYTES = 200_000;
const PROCESS_TERMINATION_GRACE_MS = 5_000;
const STDERR_SUMMARY_CHARS = 1_200;

type SnapshotEntry = { path: string; kind: "file" | "symlink" | "deleted"; mode: string; content: Buffer };
export type DiffSnapshot = { hash: string; empty: boolean; entries: SnapshotEntry[] };
export type ApprovalInput = { approved: true; diffHash: string; approvalId: string };
export type PullRequestResult = ReturnType<typeof publicTask>;

export type ApprovalDependencies = {
  stage: (task: RepoTask) => Promise<void>;
  commit: (task: RepoTask, message: string) => Promise<void>;
  push: (task: RepoTask) => Promise<void>;
  checkGhAuth: (task: RepoTask) => Promise<void>;
  createPr: (task: RepoTask, remote: GitHubRemote, title: string, body: string) => Promise<{ url: string; number: number }>;
  checkDependencies: (task: RepoTask) => Promise<void>;
  runValidation: (task: RepoTask, script: ValidationScript, timeoutMs?: number) => Promise<void>;
};

export type ValidationScript = "test" | "lint" | "typecheck" | "build";
export type GitHubRemote = { owner: string; repo: string; url: string };
export const VALIDATION_TIMEOUT_MS: Readonly<Record<ValidationScript, number>> = {
  test: 60_000,
  lint: 60_000,
  typecheck: 60_000,
  build: 120_000,
};

export type FixedProcessResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

export class ProcessExecutionError extends Error {
  constructor(public readonly result: FixedProcessResult) {
    super(result.timedOut ? "Command timed out" : "Command failed");
  }
}

const defaultDependencies: ApprovalDependencies = {
  stage: async (task) => { await checkedProcess(GIT_BINARY, ["add", "--all"], task.worktreePath, COMMAND_TIMEOUT_MS); },
  commit: async (task, message) => { await checkedProcess(GIT_BINARY, ["commit", "-m", message], task.worktreePath, COMMAND_TIMEOUT_MS); },
  push: async (task) => { await checkedProcess(GIT_BINARY, ["push", "-u", "origin", task.branch], task.worktreePath, COMMAND_TIMEOUT_MS); },
  checkGhAuth: async (task) => { await checkedProcess(GH_BINARY, ["auth", "status", "--hostname", "github.com"], task.worktreePath, 30_000); },
  createPr: async (task, remote, title, body) => {
    const output = await checkedProcess(GH_BINARY, [
      "pr", "create",
      "--repo", `${remote.owner}/${remote.repo}`,
      "--base", task.baseBranch,
      "--head", task.branch,
      "--title", title,
      "--body", body,
    ], task.worktreePath, COMMAND_TIMEOUT_MS);
    const expected = new RegExp(`^https://github\\.com/${escapeRegex(remote.owner)}/${escapeRegex(remote.repo)}/pull/([1-9][0-9]*)/?$`);
    const url = output.stdout.trim().split(/\s+/).find((value) => expected.test(value));
    if (!url) throw new Error("GitHub CLI did not return a valid pull request URL");
    return { url, number: Number(url.match(expected)![1]) };
  },
  checkDependencies: checkTaskDependencies,
  runValidation: runValidationCommand,
};

export class ApprovalError extends Error {
  constructor(message: string, public readonly statusCode = 409) { super(message); }
}

export async function prepareApproval(task: RepoTask) {
  const diff = await getTaskDiff(task);
  const template = requireTaskTemplate(task);
  if (template.readOnly || !template.requireHumanApproval || !template.requirePr) {
    invalidateApproval(task);
    persistTask(task);
    return { diff, approval: { blockedReason: "This task template is read-only and forbids commit, push, and pull request creation." }, task: publicTask(task) };
  }
  if (template.taskType === "documentation") {
    const outOfScope = [...diff.trackedFiles, ...diff.untrackedFiles].find((path) => !isDocumentationPath(path));
    if (outOfScope) {
      invalidateApproval(task);
      persistTask(task);
      return { diff, approval: { blockedReason: `Documentation template scope forbids non-documentation path ${JSON.stringify(outOfScope)}.` }, task: publicTask(task) };
    }
  }
  if (["validating", "committing", "pushing", "creating_pr", "pr_created", "push_failed", "pr_failed", "fetching_review", "reworking", "reviewing_rework", "committing_rework", "pushing_rework", "checking_ci", "ready_for_human_merge", "review_fetch_failed", "rework_failed", "ci_failed", "ci_pending"].includes(task.status)) {
    return { diff, approval: undefined, task: publicTask(task) };
  }
  const rework = task.status === "awaiting_final_approval" || (["validation_failed", "secret_scan_failed", "approval_invalidated", "commit_failed"].includes(task.status) && task.approvalPurpose === "rework");
  if (!task.reviewReady || (!rework && !["awaiting_approval", "reviewed", "validation_failed", "secret_scan_failed", "approval_invalidated", "commit_failed"].includes(task.status))) {
    invalidateApproval(task);
    persistTask(task);
    return { diff, approval: undefined, task: publicTask(task) };
  }
  if (!diff.approvable) {
    invalidateApproval(task);
    persistTask(task);
    return { diff, approval: { blockedReason: diff.blockedReason }, task: publicTask(task) };
  }
  let snapshot: DiffSnapshot;
  try { snapshot = await createDiffSnapshot(task); }
  catch (error) {
    invalidateApproval(task);
    persistTask(task);
    return { diff, approval: { blockedReason: error instanceof Error ? error.message : "The diff cannot be safely approved." }, task: publicTask(task) };
  }
  if (snapshot.empty) {
    invalidateApproval(task);
    persistTask(task);
    return { diff, approval: { blockedReason: "The final diff is empty." }, task: publicTask(task) };
  }
  recordDiffVersion(task, snapshot.hash, diff);
  if (task.status === "reviewed") transitionTask(task, "awaiting_approval");
  let issued: { approvalId: string; diffHash: string; purpose: NonNullable<RepoTask["approvalPurpose"]> } | undefined;
  if (task.diffHash !== snapshot.hash || task.approvalState !== "pending" || !task.approvalId) {
    const changed = task.diffHash !== snapshot.hash;
    if (task.approvalId && task.diffHash && task.approvalPurpose && ["pending", "processing"].includes(task.approvalState)) {
      task.approvalState = "invalidated";
      recordApprovalEvent(task, "invalidated", { approvalId: task.approvalId, diffHash: task.diffHash, purpose: task.approvalPurpose }, "diff_changed");
    }
    task.diffHash = snapshot.hash;
    task.approvalId = randomUUID();
    task.approvalState = "pending";
    task.approvalPurpose = rework ? "rework" : "create_pr";
    issued = { approvalId: task.approvalId, diffHash: task.diffHash, purpose: task.approvalPurpose };
    if (changed) {
      task.validation = [];
      task.secretFindings = [];
      task.error = undefined;
    }
  }
  persistTask(task);
  if (issued) recordApprovalEvent(task, "issued", issued, "pending");
  return {
    diff,
    approval: { diffHash: task.diffHash, approvalId: task.approvalId },
    task: publicTask(task),
  };
}

function isDocumentationPath(path: string) {
  const lower = path.toLowerCase();
  const name = lower.split("/").at(-1) ?? lower;
  return lower.startsWith("docs/") || lower.startsWith("documentation/") || ["readme", "changelog", "contributing", "license", "security", "code_of_conduct"].some((prefix) => name === prefix || name.startsWith(`${prefix}.`)) || [".md", ".mdx", ".rst", ".txt"].some((extension) => lower.endsWith(extension));
}

export async function approveAndCreatePullRequest(taskId: string, input: ApprovalInput, dependencies: Partial<ApprovalDependencies> = {}): Promise<PullRequestResult> {
  if (!acquireTaskLock(taskId)) throw new ApprovalError("This task is already being processed", 409);
  const deps = { ...defaultDependencies, ...dependencies };
  try {
    const task = getTask(taskId);
    if (!task) throw new ApprovalError("Task not found", 404);
    const profile = requireTaskProfile(task);
    const template = requireTaskTemplate(task);
    if (template.readOnly || !template.requireWorktree || !template.requireHumanApproval || !template.requirePr) throw new ApprovalError("Task template forbids commit, push, and PR creation");
    if (!profile.git.prRequired || !profile.git.commitRequiresApproval || !profile.approval.beforeCommit || !profile.approval.diffHashRequired || !profile.approval.secretScanRequired || !profile.approval.validationRequired || profile.git.mergeAllowedInApp || profile.git.forcePushAllowed || profile.git.deployAllowedInApp) {
      throw new ApprovalError("Task profile does not satisfy the enforced safe PR policy");
    }
    requireApproval(task, input);
    const acceptedApproval = { approvalId: input.approvalId, diffHash: input.diffHash, purpose: "create_pr" as const };
    recordApprovalEvent(task, "accepted", acceptedApproval, "accepted");
    task.approvalState = "processing";
    if (task.status !== "awaiting_approval") transitionTask(task, "awaiting_approval");
    transitionTask(task, "validating");
    recordTaskEvent(task, "validation_started", "system", { status: "running", metadata: { diffHash: input.diffHash } });
    task.error = undefined;
    task.validation = [];
    task.secretFindings = [];

    try {
      await validateTaskSafety(task);
      const first = await createDiffSnapshot(task);
      if (first.empty) throw invalidate(task, "The final diff is empty.");
      if (first.hash !== input.diffHash) throw invalidate(task, "Approval invalidated because the worktree changed. Review the latest diff again.");
      pass(task, "Diff hash", "MATCH");

      const findings = await scanSecrets(first);
      task.secretFindings = findings;
      if (findings.length) {
        fail(task, "Secret scan", `${findings.length} finding(s)`);
        task.approvalState = "invalidated";
        transitionTask(task, "secret_scan_failed");
        task.error = "Secret scan found files or content that cannot be committed.";
        throw new ApprovalError(task.error);
      }
      pass(task, "Secret scan");

      await runProjectValidation(task, deps);
      let remote: GitHubRemote;
      try {
        const currentOrigin = await runGit(task.worktreePath, ["remote", "get-url", "origin"]);
        if (!task.originUrl || currentOrigin !== task.originUrl) throw new Error("origin changed after task creation");
        remote = validateGitHubRemote(currentOrigin);
        pass(task, "GitHub origin", `${remote.owner}/${remote.repo}`);
      } catch {
        fail(task, "GitHub origin", "Invalid or missing origin");
        task.approvalState = "invalidated";
        transitionTask(task, "validation_failed");
        task.error = "origin must be a standard GitHub HTTPS or SSH URL.";
        throw new ApprovalError(task.error);
      }
      try {
        await deps.checkGhAuth(task);
        pass(task, "gh auth");
      } catch {
        fail(task, "gh auth", "Authentication unavailable");
        task.approvalState = "invalidated";
        transitionTask(task, "validation_failed");
        task.error = "GitHub CLI authentication is required before commit.";
        throw new ApprovalError(task.error);
      }

      recordTaskEvent(task, "validation_passed", "system", { status: "passed", metadata: { diffHash: input.diffHash } });

      const beforeStage = await createDiffSnapshot(task);
      if (beforeStage.hash !== input.diffHash) throw invalidate(task, "Approval invalidated because the worktree changed. Review the latest diff again.");

      transitionTask(task, "committing");
      try {
        await deps.stage(task);
        const beforeCommit = await createDiffSnapshot(task);
        if (beforeCommit.hash !== input.diffHash) throw invalidate(task, "Approval invalidated because the worktree changed. Review the latest diff again.");
        await deps.commit(task, commitMessage(task.prompt));
        task.commitSha = await runGit(task.worktreePath, ["rev-parse", "HEAD"]);
        task.approvalState = "used";
        persistTask(task);
        recordTaskEvent(task, "commit_created", "system", { status: "created", metadata: { commitSha: task.commitSha } });
      } catch (error) {
        if (error instanceof ApprovalError) throw error;
        task.approvalState = "invalidated";
        transitionTask(task, "commit_failed");
        task.error = "Git commit failed. Nothing was pushed.";
        throw new ApprovalError(task.error);
      }

      transitionTask(task, "pushing");
      try {
        await deps.push(task);
        recordTaskEvent(task, "branch_pushed", "system", { status: "pushed", metadata: task.commitSha ? { commitSha: task.commitSha } : undefined });
      } catch {
        transitionTask(task, "push_failed");
        task.error = "Git push failed. The commit exists only in the retained task worktree.";
        throw new ApprovalError(task.error);
      }

      transitionTask(task, "creating_pr");
      try {
        const title = prTitle(task.prompt);
        const created = await deps.createPr(task, remote, title, prBody(task));
        validatePrUrl(created.url, remote, created.number);
        task.prUrl = created.url;
        task.prNumber = created.number;
        transitionTask(task, "pr_created");
        recordTaskEvent(task, "pr_created", "system", { status: "created", metadata: { prNumber: created.number, ...(task.commitSha ? { commitSha: task.commitSha } : {}) } });
        task.error = undefined;
        return publicTask(task);
      } catch {
        transitionTask(task, "pr_failed");
        task.error = "Pull request creation failed. The task branch and commit were pushed; no merge was attempted.";
        throw new ApprovalError(task.error);
      }
    } catch (error) {
      const failure = error instanceof ApprovalError ? error : new ApprovalError(task.error ?? "Approve and create PR failed");
      if (!(error instanceof ApprovalError) && task.status === "validating") {
        task.approvalState = "invalidated";
        transitionTask(task, "validation_failed");
        task.error = "Pre-PR safety validation failed.";
      }
      if (task.approvalState === "invalidated") {
        if (["validation_failed", "secret_scan_failed", "approval_invalidated"].includes(task.status)) recordTaskEvent(task, "validation_failed", "system", { status: task.status, metadata: { diffHash: input.diffHash } });
        recordApprovalEvent(task, "invalidated", acceptedApproval, task.status);
        recordApprovalEvent(task, "failed", acceptedApproval, task.status);
      }
      throw error instanceof ApprovalError ? failure : new ApprovalError(task.error ?? failure.message);
    }
  } finally {
    const task = getTask(taskId); if (task) persistTask(task);
    releaseTaskLock(taskId);
  }
}

export async function retryPullRequest(taskId: string, dependencies: Partial<ApprovalDependencies> = {}) {
  if (!acquireTaskLock(taskId)) throw new ApprovalError("This task is already being processed", 409);
  const deps = { ...defaultDependencies, ...dependencies };
  try {
    const task = getTask(taskId);
    if (!task) throw new ApprovalError("Task not found", 404);
    const profile = requireTaskProfile(task);
    const template = requireTaskTemplate(task);
    if (template.readOnly || !template.requirePr) throw new ApprovalError("Task template forbids this Git operation");
    if (!profile.git.prRequired || profile.git.mergeAllowedInApp || profile.git.forcePushAllowed || profile.git.deployAllowedInApp) throw new ApprovalError("Task profile forbids this Git operation");
    if (task.prNumber && task.prUrl) return publicTask(task);
    if (task.status !== "pr_failed" || !task.commitSha || task.approvalState !== "used") throw new ApprovalError("PR retry is not available for this task");
    await validateCommittedTask(task);
    const remote = validateGitHubRemote(await runGit(task.worktreePath, ["remote", "get-url", "origin"]));
    await deps.checkGhAuth(task);
    transitionTask(task, "creating_pr");
    try {
      const title = prTitle(task.prompt);
      const created = await deps.createPr(task, remote, title, prBody(task));
      validatePrUrl(created.url, remote, created.number);
      task.prUrl = created.url;
      task.prNumber = created.number;
      transitionTask(task, "pr_created");
      recordTaskEvent(task, "pr_created", "system", { status: "created", metadata: { prNumber: created.number, commitSha: task.commitSha } });
      task.error = undefined;
      return publicTask(task);
    } catch {
      transitionTask(task, "pr_failed");
      task.error = "Pull request creation failed again. No automatic retry or merge was attempted.";
      throw new ApprovalError(task.error);
    }
  } finally {
    const task = getTask(taskId); if (task) persistTask(task);
    releaseTaskLock(taskId);
  }
}

function requireApproval(task: RepoTask, input: ApprovalInput) {
  if (input.approved !== true) throw new ApprovalError("Explicit human approval is required", 400);
  if (!["awaiting_approval", "validation_failed", "secret_scan_failed", "approval_invalidated", "commit_failed"].includes(task.status) || task.approvalState !== "pending") {
    throw new ApprovalError("This task is not awaiting approval");
  }
  if (task.approvalPurpose !== "create_pr") throw new ApprovalError("This approval is not valid for PR creation");
  if (!input.diffHash || input.diffHash !== task.diffHash || !input.approvalId || input.approvalId !== task.approvalId) {
    throw new ApprovalError("Approval is invalid or has already been used");
  }
}

export async function validateTaskSafety(task: RepoTask) {
  const profile = requireTaskProfile(task);
  const template = requireTaskTemplate(task);
  if (template.readOnly || !template.requireWorktree) throw new Error("Task template does not permit an implementation worktree");
  if (!profile.git.isolatedWorktreeRequired || !profile.git.directMainWriteForbidden) throw new Error("Task profile does not require an isolated worktree");
  const validated = await validateRepository(task.repoId, task.allowedRoot);
  const repoPath = await realpath(task.repoPath);
  const worktreePath = await realpath(task.worktreePath);
  const worktreeRoot = await realpath(task.worktreeRoot);
  const worktreeRelative = relative(worktreeRoot, worktreePath);
  if (validated.path !== repoPath || validated.id !== task.repoId) throw new Error("Task and repository do not match");
  if (worktreePath === repoPath) throw new Error("Task worktree must differ from the source repository");
  if (!worktreeRelative || worktreeRelative === ".." || worktreeRelative.startsWith(`..${sep}`)) throw new Error("Task worktree is outside its server-managed root");
  if (worktreePath !== await realpath(join(worktreeRoot, task.repoId, task.id))) throw new Error("Task worktree path does not match the task");
  if (!TASK_BRANCH_PATTERN.test(task.branch) || task.branch !== `multiagents/${task.id}`) throw new Error("Invalid task branch");
  if (await runGit(worktreePath, ["branch", "--show-current"]) !== task.branch) throw new Error("Task branch does not match the worktree");
  if (await realpath(await runGit(worktreePath, ["rev-parse", "--show-toplevel"])) !== worktreePath) throw new Error("Invalid task worktree root");
  if (await runGit(worktreePath, ["rev-parse", "HEAD"]) !== task.baseSha) throw new Error("Task HEAD changed before approval");
  if (await runGit(worktreePath, ["rev-parse", "--is-inside-work-tree"]) !== "true") throw new Error("Invalid Git worktree");
  if (await runGit(worktreePath, ["ls-files", "-u"])) throw new Error("Merge conflict state is not allowed");
  if (await runGit(worktreePath, ["diff", "--name-only", "--diff-filter=U", "HEAD", "--"])) throw new Error("Merge conflicts must be resolved before approval");

  const dotGit = await lstat(join(worktreePath, ".git"));
  if (!dotGit.isFile() || dotGit.isSymbolicLink()) throw new Error("Unexpected .git entry in task worktree");
  const commonDir = await realpath(resolveGitPath(worktreePath, await runGit(worktreePath, ["rev-parse", "--git-common-dir"])));
  const expectedCommonDir = await realpath(join(repoPath, ".git"));
  if (commonDir !== expectedCommonDir) throw new Error("Task uses an unexpected Git common directory");
  const gitDir = await realpath(resolveGitPath(worktreePath, await runGit(worktreePath, ["rev-parse", "--git-dir"])));
  const gitDirRelative = relative(commonDir, gitDir);
  if (!gitDirRelative.startsWith(`worktrees${sep}`) || gitDirRelative.includes(`..${sep}`)) throw new Error("Task uses an unexpected Git directory");
}

async function validateCommittedTask(task: RepoTask) {
  const validated = await validateRepository(task.repoId, task.allowedRoot);
  if (await realpath(validated.path) !== await realpath(task.repoPath)) throw new Error("Task and repository do not match");
  if (await runGit(task.worktreePath, ["branch", "--show-current"]) !== task.branch) throw new Error("Task branch changed");
  if (await runGit(task.worktreePath, ["rev-parse", "HEAD"]) !== task.commitSha) throw new Error("Task commit changed");
  if (await runGit(task.worktreePath, ["status", "--porcelain"])) throw new Error("Task worktree changed after commit");
}

function resolveGitPath(worktreePath: string, value: string) {
  return isAbsolute(value) ? value : resolve(worktreePath, value);
}

export async function createDiffSnapshot(task: RepoTask): Promise<DiffSnapshot> {
  const root = await realpath(task.worktreePath);
  const [tracked, untracked, head] = await Promise.all([
    runGit(root, ["diff", "--name-only", "-z", "HEAD", "--"]),
    runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
    runGit(root, ["rev-parse", "HEAD"]),
  ]);
  const paths = [...new Set([...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean))].sort();
  const entries: SnapshotEntry[] = [];
  let totalBytes = 0;
  for (const path of paths) {
    if (isAbsolute(path) || path === ".git" || path.startsWith(".git/") || path.split("/").includes("..")) throw new Error("Invalid changed path");
    const absolute = join(root, path);
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        const content = Buffer.from(await readlink(absolute), "utf8");
        entries.push({ path, kind: "symlink", mode: "120000", content });
        totalBytes += content.length;
      } else if (info.isFile()) {
        if (info.size > MAX_UNTRACKED_FILE_BYTES) throw new Error(`Changed file ${JSON.stringify(path)} exceeds the approval limit`);
        const content = await readFile(absolute);
        entries.push({ path, kind: "file", mode: info.mode & 0o111 ? "100755" : "100644", content });
        totalBytes += content.length;
      } else {
        throw new Error(`Changed path ${JSON.stringify(path)} is not a regular file or symlink`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") entries.push({ path, kind: "deleted", mode: "000000", content: Buffer.alloc(0) });
      else throw error;
    }
    if (totalBytes > MAX_UNTRACKED_TOTAL_BYTES) throw new Error("Changed content exceeds the approval limit");
  }
  const hash = createHash("sha256");
  addPart(hash, Buffer.from("multiagents-diff-v1\0"));
  addPart(hash, Buffer.from(head));
  for (const entry of entries) {
    addPart(hash, Buffer.from(entry.path));
    addPart(hash, Buffer.from(entry.kind));
    addPart(hash, Buffer.from(entry.mode));
    addPart(hash, entry.content);
  }
  return { hash: hash.digest("hex"), empty: entries.length === 0, entries };
}

function addPart(hash: ReturnType<typeof createHash>, value: Buffer) {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(value.length));
  hash.update(length);
  hash.update(value);
}

export async function scanSecrets(snapshot: DiffSnapshot): Promise<SecretFinding[]> {
  const findings: SecretFinding[] = [];
  for (const entry of snapshot.entries) {
    if (entry.kind === "deleted") continue;
    const lower = entry.path.toLowerCase();
    const name = lower.split("/").at(-1)!;
    const filenameRule =
      name === ".env" || name.startsWith(".env.") ? ".env file" :
      name.endsWith(".pem") ? "*.pem" :
      name.endsWith(".key") ? "*.key" :
      name === "id_rsa" ? "id_rsa" :
      name === "id_ed25519" ? "id_ed25519" :
      name.startsWith("credentials") ? "credentials*" :
      name.includes("token") ? "*token*" :
      undefined;
    if (filenameRule) findings.push({ path: entry.path, kind: "filename", rule: filenameRule });
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(entry.content); }
    catch { continue; }
    if (entry.content.includes(0)) continue;
    const rules: Array<[string, RegExp]> = [
      ["private key header", /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/],
      ["OpenAI-style key", /\bsk-[A-Za-z0-9_-]{16,}\b/],
      ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
      ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
      ["API_KEY assignment", /^\s*(?:export\s+)?API_KEY\s*=\s*['"]?[^\s'"]{4,}/im],
      ["PASSWORD assignment", /^\s*(?:export\s+)?PASSWORD\s*=\s*['"]?[^\s'"]{4,}/im],
      ["SECRET assignment", /^\s*(?:export\s+)?SECRET\s*=\s*['"]?[^\s'"]{4,}/im],
    ];
    for (const [rule, pattern] of rules) if (pattern.test(text)) findings.push({ path: entry.path, kind: "content", rule });
  }
  return findings;
}

export async function runProjectValidation(task: RepoTask, deps: Pick<ApprovalDependencies, "checkDependencies" | "runValidation">) {
  const profile = requireTaskProfile(task);
  const template = requireTaskTemplate(task);
  if (template.readOnly) throw new ApprovalError("Read-only task templates cannot run pre-PR validation");
  let packageJson: { scripts?: Record<string, unknown> } | undefined;
  const packagePath = join(task.worktreePath, "package.json");
  try {
    const info = await lstat(packagePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("package.json must be a regular file");
    packageJson = JSON.parse(await readFile(packagePath, "utf8")) as { scripts?: Record<string, unknown> };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      task.approvalState = "invalidated";
      transitionTask(task, "validation_failed");
      task.error = "package.json could not be safely read.";
      throw new ApprovalError(task.error);
    }
  }
  const configured = template.validationPreset.map((step: ValidationStep) => ({ step, script: validationScript(step) }));
  const scripts = configured.filter(({ script }) => typeof packageJson?.scripts?.[script] === "string");
  const missing = configured.filter(({ script }) => typeof packageJson?.scripts?.[script] !== "string");
  if (missing.length && profile.validation.missingScript === "fail") {
    for (const { script } of missing) fail(task, npmLabel(script), packageJson ? "Required script not defined" : "No package.json");
    task.approvalState = "invalidated";
    transitionTask(task, "validation_failed");
    task.error = "A validation script required by the task profile is missing. No commit was created.";
    throw new ApprovalError(task.error);
  }
  if (scripts.length) {
    try {
      await deps.checkDependencies(task);
      pass(task, "npm dependencies", "Available in task worktree");
    } catch {
      fail(task, "npm dependencies", "dependencies not installed in task worktree");
      task.approvalState = "invalidated";
      transitionTask(task, "validation_failed");
      task.error = "dependencies not installed in task worktree. Install dependencies there explicitly, then retry validation. No commit was created.";
      throw new ApprovalError(task.error);
    }
  }
  for (const { script } of configured) {
    if (!scripts.some((item) => item.script === script)) {
      task.validation.push({ name: npmLabel(script), status: "skip", detail: packageJson ? "Script not defined" : "No package.json" });
      continue;
    }
    const timeoutMs = validationTimeoutMs(script, profile.validation.timeout);
    try {
      await deps.runValidation(task, script, timeoutMs);
      pass(task, npmLabel(script));
    } catch (error) {
      const detail = validationFailureDetail(error, timeoutMs);
      fail(task, npmLabel(script), detail);
      task.approvalState = "invalidated";
      transitionTask(task, "validation_failed");
      task.error = `${npmLabel(script)} failed. No commit was created.`;
      throw new ApprovalError(task.error);
    }
  }
}

export async function checkTaskDependencies(task: RepoTask) {
  const modulesPath = join(task.worktreePath, "node_modules");
  let info;
  try {
    info = await lstat(modulesPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("dependencies not installed in task worktree");
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("dependencies not installed in task worktree");
  const npm = npmCommand(["ls", "--all", "--include=dev", "--ignore-scripts", "--offline"]);
  try {
    await checkedProcess(npm.binary, npm.args, task.worktreePath, COMMAND_TIMEOUT_MS);
  } catch {
    throw new Error("dependencies not installed in task worktree");
  }
}

export async function runValidationCommand(task: RepoTask, script: ValidationScript, timeoutMs = VALIDATION_TIMEOUT_MS[script]) {
  const npm = npmInvocation(script);
  const envOverrides: NodeJS.ProcessEnv | undefined = script === "build" ? { NODE_ENV: "production" } : undefined;
  await checkedProcess(npm.binary, npm.args, task.worktreePath, timeoutMs, envOverrides);
}

export function validateGitHubRemote(url: string): GitHubRemote {
  const https = url.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  const ssh = url.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  const match = https ?? ssh;
  if (!match || match[1] === "." || match[1] === ".." || match[2] === "." || match[2] === "..") {
    throw new Error("origin must be a standard GitHub HTTPS or SSH URL");
  }
  return { owner: match[1], repo: match[2], url };
}

function validatePrUrl(url: string, remote: GitHubRemote, number: number) {
  const expected = `https://github.com/${remote.owner}/${remote.repo}/pull/${number}`;
  if (url !== expected || !Number.isSafeInteger(number) || number < 1) throw new Error("Invalid pull request result");
}

export function taskSummary(prompt: string, maxLength = 80) {
  const clean = prompt.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().replace(/^-+/, "").trim();
  const safe = redactSecrets(clean) || "approved task";
  return Array.from(safe).slice(0, maxLength).join("");
}

export function commitMessage(prompt: string) {
  return `multiagents: ${taskSummary(prompt, 87)}`;
}

export function prTitle(prompt: string) {
  return `MultiAgents: ${taskSummary(prompt, 87)}`;
}

function prBody(task: RepoTask) {
  const checks = task.validation.filter((item) => item.name.startsWith("npm")).map((item) => `- ${item.name}: ${item.status.toUpperCase()}`).join("\n");
  return `## Task

${taskSummary(task.prompt, 200)}

## Multi-agent review

- Codex: implementation
- Cursor: review completed
- Claude: review completed
- Codex: final revision completed

## Validation

${checks || "- No package.json scripts were available"}

## Notes

Created from an isolated MultiAgents worktree after explicit human approval.`;
}

function redactSecrets(value: string) {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g, "[redacted]")
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted]");
}

function npmInvocation(script: ValidationScript) {
  return npmCommand(script === "test" ? ["test"] : ["run", script]);
}

function npmCommand(args: readonly string[]) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && isAbsolute(npmExecPath) && npmExecPath.split(/[\\/]/).at(-1) === "npm-cli.js") {
    return { binary: process.execPath, args: [npmExecPath, ...args] };
  }
  return { binary: join(dirname(process.execPath), "npm"), args: [...args] };
}

function npmLabel(script: ValidationScript) {
  return script === "test" ? "npm test" : `npm run ${script}`;
}

function pass(task: RepoTask, name: string, detail?: string) {
  task.validation.push({ name, status: "pass", detail });
}

function fail(task: RepoTask, name: string, detail?: string) {
  task.validation.push({ name, status: "fail", detail });
}

function invalidate(task: RepoTask, message: string) {
  const existing = task.validation.find((item) => item.name === "Diff hash");
  if (existing) { existing.status = "fail"; existing.detail = "MISMATCH"; }
  else fail(task, "Diff hash", "MISMATCH");
  task.approvalState = "invalidated";
  transitionTask(task, "approval_invalidated");
  task.error = message;
  return new ApprovalError(message);
}

export async function runFixedProcess(binary: string, args: readonly string[], cwd: string, timeoutMs: number) {
  return runFixedProcessWithEnv(binary, args, cwd, timeoutMs);
}

async function runFixedProcessWithEnv(binary: string, args: readonly string[], cwd: string, timeoutMs: number, envOverrides?: NodeJS.ProcessEnv) {
  return new Promise<FixedProcessResult>((resolve, reject) => {
    const child = spawn(binary, [...args], {
      cwd,
      env: { ...process.env, ...envOverrides },
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let processClosed = false;
    let stdoutEnded = false;
    let stderrEnded = false;
    let settled = false;
    let timedOut = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    let forceCloseTimer: NodeJS.Timeout | undefined;
    const append = (current: Buffer, chunk: Buffer) => {
      if (chunk.length >= MAX_COMMAND_OUTPUT_BYTES) {
        return { value: chunk.subarray(chunk.length - MAX_COMMAND_OUTPUT_BYTES), truncated: true };
      }
      const combined = Buffer.concat([current, chunk]);
      if (combined.length <= MAX_COMMAND_OUTPUT_BYTES) return { value: combined, truncated: false };
      return { value: combined.subarray(combined.length - MAX_COMMAND_OUTPUT_BYTES), truncated: true };
    };
    child.stdout.on("data", (chunk: Buffer) => {
      const appended = append(stdout, chunk);
      stdout = appended.value;
      stdoutTruncated ||= appended.truncated;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const appended = append(stderr, chunk);
      stderr = appended.value;
      stderrTruncated ||= appended.truncated;
    });
    const clearTimers = () => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (forceCloseTimer) clearTimeout(forceCloseTimer);
    };
    const result = (): FixedProcessResult => ({
      stdout: stdout.toString("utf8"),
      stderr: stderr.toString("utf8"),
      code: exitCode,
      signal: exitSignal,
      timedOut,
      stdoutTruncated,
      stderrTruncated,
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(result());
    };
    const finishAfterCloseAndOutput = () => {
      if (processClosed && stdoutEnded && stderrEnded) finish();
    };
    const killProcessGroup = (signal: NodeJS.Signals) => {
      if (child.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
      } else child.kill(signal);
    };
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });
    child.stdout.once("end", () => {
      stdoutEnded = true;
      finishAfterCloseAndOutput();
    });
    child.stderr.once("end", () => {
      stderrEnded = true;
      finishAfterCloseAndOutput();
    });
    child.once("close", (code, signal) => {
      exitCode ??= code;
      exitSignal ??= signal;
      processClosed = true;
      finishAfterCloseAndOutput();
    });
    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killProcessGroup("SIGTERM");
      killTimer = setTimeout(() => {
        if (settled) return;
        killProcessGroup("SIGKILL");
        forceCloseTimer = setTimeout(finish, 1_000);
        forceCloseTimer.unref();
      }, PROCESS_TERMINATION_GRACE_MS);
      killTimer.unref();
    }, timeoutMs);
    timeoutTimer.unref();
  });
}

async function checkedProcess(binary: string, args: readonly string[], cwd: string, timeoutMs: number, envOverrides?: NodeJS.ProcessEnv) {
  const result = await runFixedProcessWithEnv(binary, args, cwd, timeoutMs, envOverrides);
  if (result.timedOut || result.code !== 0) throw new ProcessExecutionError(result);
  return result;
}

function validationFailureDetail(error: unknown, timeoutMs: number) {
  if (!(error instanceof ProcessExecutionError)) return "Command could not be started";
  if (error.result.timedOut) return `TIMEOUT after ${Math.round(timeoutMs / 1_000)}s`;
  const status = error.result.code === null
    ? error.result.signal ? `Terminated by ${error.result.signal}` : "Command failed"
    : `Exit code ${error.result.code}`;
  const summary = summarizeStderr(error.result.stderr);
  return summary ? `${status}: ${summary}` : status;
}

export function summarizeStderr(value: string) {
  const clean = redactSecrets(value)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/^[A-Za-z_][A-Za-z0-9_]*=.*$/gm, (line) => `${line.slice(0, line.indexOf("="))}=[redacted]`)
    .replace(/:\/\/[^\s/:@]+:[^\s/@]+@/g, "://[redacted]@")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8)
    .join(" ");
  return clean.length > STDERR_SUMMARY_CHARS ? `…${clean.slice(-STDERR_SUMMARY_CHARS)}` : clean;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isTaskLockedForTests(taskId: string) { return isTaskLocked(taskId); }
export function clearApprovalLocksForTests() { clearTaskLocksForTests(); }
