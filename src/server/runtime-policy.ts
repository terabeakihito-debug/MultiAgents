import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type { AgentAdapter, AgentId, AgentResult } from "../agents/types";
import { parseProfileSnapshot, type AgentRole } from "../profiles/policy";
import {
  RUNTIME_POLICY_VERSION,
  type PublicRuntimePolicy,
  type RuntimePolicy,
  type RuntimePolicyClass,
  type RuntimeViolation,
} from "../runtime/types";
import { builtInTemplate, mergeTemplateWithProfile, parseTemplateSnapshot } from "../templates/policy";
import { runGit } from "./git";
import { validateRepository } from "./repositories";
import type { RepoTask } from "./tasks";

const AGENTS = ["codex", "cursor", "claude"] as const;
const FORBIDDEN_OPERATIONS = Object.freeze([
  "base_repo_write", "repo_outside_write", "direct_main_write", "git_commit", "git_push",
  "git_reset_hard", "git_checkout_main", "git_branch_delete", "github_mutation", "merge", "deploy",
]);
const MAX_FINGERPRINT_FILE_BYTES = 2_000_000;

type WorktreeState = { branch: string; head: string; fingerprint: string };
type RuntimeState = {
  base: WorktreeState;
  target: WorktreeState;
  targetIsBase: boolean;
  registrations: string;
  siblings: string;
  repositories: string;
};

export class RuntimePolicyError extends Error {
  constructor(message: string, public readonly violation: RuntimeViolation = "forbidden_runtime_configuration") { super(message); }
}

export async function buildTaskRuntimePolicies(task: RepoTask): Promise<Record<AgentId, RuntimePolicy>> {
  const profile = parseProfileSnapshot(task.profile);
  const savedTemplate = parseTemplateSnapshot(task.template);
  if (profile.repoId !== task.repoId || savedTemplate.repoId !== task.repoId) throw new RuntimePolicyError("Runtime policy snapshot repository mismatch");
  const expectedTemplate = mergeTemplateWithProfile({
    ...builtInTemplate(task.repoId, savedTemplate.templateId),
    version: savedTemplate.version,
    enabled: savedTemplate.enabled,
  }, profile);
  if (JSON.stringify(savedTemplate) !== JSON.stringify(expectedTemplate)) throw new RuntimePolicyError("Runtime policy snapshots do not form the fixed server-side intersection");

  const roots = await validateRuntimeRoots(task, savedTemplate.readOnly);
  return Object.fromEntries(await Promise.all(AGENTS.map(async (agent) => {
    const role = effectiveRole(agent, profile.roles[agent], savedTemplate.roles[agent], savedTemplate.readOnly);
    const allowWrite = role === "implement";
    const policyClass: RuntimePolicyClass = role === "disabled" ? "disabled" : allowWrite ? "repository_implementation" : "repository_review";
    const policy = basePolicy({
      agent, role, policyClass,
      workingRoot: allowWrite ? roots.worktree! : roots.execution,
      writableRoot: allowWrite ? roots.worktree : undefined,
      baseRepoRoot: allowWrite ? roots.repo : undefined,
      filesystem: role === "disabled" ? [] : allowWrite ? ["worktree_read", "worktree_write"] : [savedTemplate.readOnly ? "repo_read" : "worktree_read"],
      source: "task_snapshots",
      sourceProfileId: profile.profileId,
      sourceProfileVersion: profile.version,
      sourceTemplateId: savedTemplate.templateId,
      sourceTemplateVersion: savedTemplate.version,
    });
    return [agent, policy] as const;
  }))) as Record<AgentId, RuntimePolicy>;
}

export function buildGenericRuntimePolicy(agent: AgentId, workingRoot = process.cwd()): RuntimePolicy {
  const root = resolve(workingRoot);
  return basePolicy({
    agent, role: "review_only", policyClass: "generic_read_only", workingRoot: root,
    filesystem: [], source: "parallel_generic",
  });
}

export function publicRuntimePolicy(policy: RuntimePolicy): PublicRuntimePolicy {
  return {
    version: policy.version,
    agent: policy.agent,
    role: policy.role,
    policyClass: policy.policyClass,
    filesystem: [...policy.filesystem],
    networkPolicy: policy.networkPolicy,
    networkEnforcement: policy.networkEnforcement,
    osSandboxProfile: policy.osSandboxProfile,
    execution: [...policy.execution],
    allowWrite: policy.allowWrite,
    environmentPolicy: policy.environmentPolicy,
    sourceProfileId: policy.sourceProfileId,
    sourceProfileVersion: policy.sourceProfileVersion,
    sourceTemplateId: policy.sourceTemplateId,
    sourceTemplateVersion: policy.sourceTemplateVersion,
    source: policy.source,
    policyHash: policy.policyHash,
    writeScope: policy.allowWrite ? "task_worktree_only" : "denied",
    forbiddenOperations: [...policy.forbiddenOperations],
  };
}

export function readOnlyRuntimePolicy(policy: RuntimePolicy): RuntimePolicy {
  if (policy.role === "disabled" || !policy.allowWrite) return policy;
  return basePolicy({
    ...policy,
    role: "review_only",
    policyClass: "repository_review",
    filesystem: policy.source === "task_snapshots" ? ["worktree_read"] : [],
    writableRoot: undefined,
    baseRepoRoot: undefined,
  });
}

export async function runTaskAgentWithPolicy(input: {
  task: RepoTask;
  adapter: AgentAdapter;
  policy: RuntimePolicy;
  prompt: string;
  signal?: AbortSignal;
  stepId?: string;
  onAudit: (type: "runtime_policy_created" | "runtime_execution_started" | "runtime_execution_completed" | "runtime_violation_detected", policy: RuntimePolicy, violation?: RuntimeViolation) => void;
  onViolation: (policy: RuntimePolicy, violation: RuntimeViolation) => void;
  onSandboxAudit: (event: import("./os-sandbox").OsSandboxAudit) => void;
  onLifecycleTelemetry?: (telemetry: import("../agents/types").AgentLifecycleTelemetry) => void;
}): Promise<AgentResult> {
  const { task, adapter, policy } = input;
  if (adapter.id !== policy.agent || policy.execution.length !== (policy.role === "disabled" ? 0 : 1)) {
    input.onViolation(policy, "forbidden_runtime_configuration");
    return violationResult(policy.agent, "forbidden_runtime_configuration");
  }
  if (policy.role === "disabled") return { agent: policy.agent, status: "error", output: "", error: "Agent is disabled by runtime policy" };
  input.onAudit("runtime_policy_created", policy);
  let before: RuntimeState;
  try { before = await captureRuntimeState(task, policy); }
  catch {
    input.onAudit("runtime_violation_detected", policy, "worktree_escape");
    input.onViolation(policy, "worktree_escape");
    return violationResult(policy.agent, "worktree_escape");
  }
  input.onAudit("runtime_execution_started", policy);
  const verifyAfterClose = async (result: AgentResult) => {
    let verificationAuditError: unknown;
    const auditSafely = (type: "runtime_execution_completed" | "runtime_violation_detected", violation?: RuntimeViolation) => {
      try { input.onAudit(type, policy, violation); }
      catch (error) { verificationAuditError ??= error; }
    };
    let after: RuntimeState | undefined;
    let violations: RuntimeViolation[];
    try {
      after = await captureRuntimeState(task, policy);
      violations = compareRuntimeState(policy, before, after);
    }
    catch { violations = ["worktree_escape"]; }
    auditSafely("runtime_execution_completed");
    if (violations.length) {
      const violation = violations[0];
      auditSafely("runtime_violation_detected", violation);
      try { input.onViolation(policy, violation); } catch { /* violation still wins */ }
      return { ...violationResult(policy.agent, violation), output: result.output };
    }
    if (isCodexRepositoryAccessSelfReport(policy, result, before, after)) {
      // Do not log model output: it is untrusted task content. The fixed
      // classification and empty-worktree signal correlate with the Codex
      // launch and stderr diagnostics without disclosing task data.
      console.warn("codex_repository_access_self_report", JSON.stringify({
        agent: policy.agent,
        status: result.status,
        implementationDiffEmpty: true,
        outputClassification: "repository_access_unavailable",
      }));
    }
    if (verificationAuditError) throw verificationAuditError;
    return result;
  };
  try {
    const result = await adapter.run(input.prompt, {
      signal: input.signal,
      policy,
      onSandboxAudit: input.onSandboxAudit,
      onLifecycleTelemetry: input.onLifecycleTelemetry,
      // The adapter owns the active-agent gate, so verification belongs in its
      // post-close finalization callback rather than after adapter.run().
      afterClose: verifyAfterClose,
    });
    // Test and third-party adapters may not yet implement the lifecycle hook.
    // Their result has no runner-held gate, so retain the established fallback.
    return adapter.supportsPostCloseFinalization ? result : await verifyAfterClose(result);
  } catch (error) {
    return { agent: policy.agent, status: "error", output: "", error: error instanceof Error ? error.message : "Agent execution failed" };
  }
}

function isCodexRepositoryAccessSelfReport(policy: RuntimePolicy, result: AgentResult, before: RuntimeState, after: RuntimeState | undefined) {
  if (policy.agent !== "codex" || !policy.allowWrite || result.status !== "completed" || !after) return false;
  if (before.target.fingerprint !== after.target.fingerprint) return false;
  return /\brepository\s+access\s+(?:failed|is\s+(?:unavailable|denied)|cannot|could\s+not)\b/i.test(result.output)
    || /(?:実行環境(?:のエラー)?|実行環境のエラー).{0,100}(?:アクセス|ファイル(?:確認|の確認)?|編集).{0,60}でき(?:ない|ません(?:でした)?)/.test(result.output);
}

export function runtimeViolationMessage(violation: RuntimeViolation) {
  const descriptions: Record<RuntimeViolation, string> = {
    unexpected_write: "Agent wrote outside its permitted runtime capability.",
    head_changed: "Agent changed Git HEAD.",
    branch_changed: "Agent changed the Git branch.",
    base_repo_changed: "Agent changed the base repository.",
    worktree_escape: "Agent runtime root failed worktree/path validation.",
    unexpected_worktree: "Agent changed Git worktree registration or another worktree.",
    forbidden_runtime_configuration: "Agent runtime configuration exceeded the server policy.",
  };
  return `Runtime policy violation: ${descriptions[violation]} No commit, push, or PR action is permitted.`;
}

function basePolicy(input: Pick<RuntimePolicy, "agent" | "role" | "policyClass" | "workingRoot" | "filesystem" | "source"> & Partial<RuntimePolicy>): RuntimePolicy {
  const value = {
    version: RUNTIME_POLICY_VERSION,
    agent: input.agent,
    role: input.role,
    policyClass: input.policyClass,
    filesystem: [...input.filesystem],
    networkPolicy: "provider_required" as const,
    networkEnforcement: "host_network_residual_risk" as const,
    osSandboxProfile: input.role === "implement" ? "agent_implement" as const : "agent_read_only" as const,
    execution: input.role === "disabled" ? [] : ["agent_cli" as const],
    allowWrite: input.role === "implement",
    workingRoot: input.workingRoot,
    writableRoot: input.writableRoot,
    baseRepoRoot: input.baseRepoRoot,
    environmentPolicy: "agent" as const,
    forbiddenOperations: [...FORBIDDEN_OPERATIONS],
    sourceProfileId: input.sourceProfileId,
    sourceProfileVersion: input.sourceProfileVersion,
    sourceTemplateId: input.sourceTemplateId,
    sourceTemplateVersion: input.sourceTemplateVersion,
    source: input.source,
  };
  const policyHash = createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return { ...value, policyHash };
}

function effectiveRole(agent: AgentId, profileRole: AgentRole, templateRole: AgentRole, readOnly: boolean): AgentRole {
  const rank: Record<AgentRole, number> = { disabled: 0, review_only: 1, implement: 2 };
  if ((agent === "cursor" || agent === "claude") && (profileRole === "implement" || templateRole === "implement")) {
    throw new RuntimePolicyError(`${agent} cannot receive implement runtime capability`);
  }
  const role = rank[profileRole] <= rank[templateRole] ? profileRole : templateRole;
  if (readOnly && role === "implement") return "review_only";
  if (agent !== "codex" && role === "implement") throw new RuntimePolicyError("Only Codex may receive implement runtime capability");
  return role;
}

async function validateRuntimeRoots(task: RepoTask, readOnly: boolean) {
  const allowedRoot = await realpath(task.allowedRoot);
  rejectWindowsRoot(allowedRoot, "allowed repository root");
  if (["/", "/tmp", homedir()].includes(resolve(allowedRoot))) throw new RuntimePolicyError("Allowed repository root is too broad", "worktree_escape");
  const repo = await validateRepository(task.repoId, allowedRoot);
  const savedRepo = await realpath(task.repoPath);
  if (savedRepo !== repo.path) throw new RuntimePolicyError("Saved repository root is not the validated repository", "worktree_escape");
  if (readOnly) {
    if (await realpath(task.worktreePath) !== repo.path || task.worktreeAvailable) throw new RuntimePolicyError("Read-only task root is not the validated repository", "worktree_escape");
    return { execution: repo.path, repo: repo.path, worktree: undefined };
  }
  if (!task.worktreeAvailable) throw new RuntimePolicyError("Writable runtime requires an available managed task worktree", "worktree_escape");
  const root = await realpath(task.worktreeRoot);
  const worktree = await realpath(task.worktreePath);
  rejectDangerousRoot(root, "managed worktree root");
  rejectDangerousRoot(worktree, "task worktree");
  const expected = await realpath(join(root, task.repoId, task.id));
  if (worktree !== expected || !isStrictlyWithin(root, worktree)) throw new RuntimePolicyError("Writable root is not the server-managed task worktree", "worktree_escape");
  if (worktree === repo.path || worktree === allowedRoot || worktree === homedir() || worktree === "/" || worktree === "/tmp") throw new RuntimePolicyError("Writable root is forbidden", "worktree_escape");
  if (await realpath(await runGit(worktree, ["rev-parse", "--show-toplevel"])) !== worktree) throw new RuntimePolicyError("Task worktree top-level mismatch", "worktree_escape");
  if (await runGit(worktree, ["branch", "--show-current"]) !== task.branch || task.branch !== `multiagents/${task.id}`) throw new RuntimePolicyError("Task worktree branch mismatch", "worktree_escape");
  const dotGit = await lstat(join(worktree, ".git"));
  if (!dotGit.isFile() || dotGit.isSymbolicLink()) throw new RuntimePolicyError("Task worktree Git link is invalid", "worktree_escape");
  const registrations = parseWorktrees(await runGit(repo.path, ["worktree", "list", "--porcelain"]));
  if (!registrations.includes(worktree)) throw new RuntimePolicyError("Task worktree is not registered", "worktree_escape");
  return { execution: worktree, repo: repo.path, worktree };
}

function rejectDangerousRoot(path: string, label: string) {
  const normalized = resolve(path);
  rejectWindowsRoot(normalized, label);
  if (["/", "/tmp", homedir(), join(homedir(), "code")].includes(normalized)) throw new RuntimePolicyError(`${label} is too broad`, "worktree_escape");
}

function rejectWindowsRoot(path: string, label: string) {
  if (/^\/mnt\/[a-z](?:\/|$)/i.test(resolve(path))) throw new RuntimePolicyError(`${label} cannot be a Windows mounted drive`, "worktree_escape");
}

function isStrictlyWithin(root: string, candidate: string) {
  const rel = relative(root, candidate);
  return Boolean(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

async function captureRuntimeState(task: RepoTask, policy: RuntimePolicy): Promise<RuntimeState> {
  const baseRoot = await realpath(task.repoPath);
  const targetRoot = await realpath(policy.workingRoot);
  if (policy.allowWrite && await realpath(/*turbopackIgnore: true*/ policy.writableRoot ?? "") !== targetRoot) throw new RuntimePolicyError("Writable root changed", "worktree_escape");
  const paths = parseWorktrees(await runGit(baseRoot, ["worktree", "list", "--porcelain"]));
  if (!paths.includes(targetRoot) && targetRoot !== baseRoot) throw new RuntimePolicyError("Runtime worktree registration changed", "worktree_escape");
  const states = await Promise.all(paths.map(async (path) => [path, await captureWorktree(path)] as const));
  const repositories = await captureSiblingRepositories(task.allowedRoot, baseRoot);
  const stateMap = new Map(states);
  const base = stateMap.get(baseRoot) ?? await captureWorktree(baseRoot);
  const target = stateMap.get(targetRoot) ?? await captureWorktree(targetRoot);
  const siblings = createHash("sha256").update(JSON.stringify(states.filter(([path]) => path !== baseRoot && path !== targetRoot))).digest("hex");
  return {
    base, target, targetIsBase: targetRoot === baseRoot,
    registrations: createHash("sha256").update(JSON.stringify(paths)).digest("hex"),
    siblings,
    repositories,
  };
}

async function captureWorktree(root: string): Promise<WorktreeState> {
  const [branch, head, status, unstaged, staged, untracked] = await Promise.all([
    runGit(root, ["branch", "--show-current"]),
    runGit(root, ["rev-parse", "HEAD"]),
    runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    runGit(root, ["diff", "--binary", "--full-index", "HEAD", "--"]),
    runGit(root, ["diff", "--binary", "--full-index", "--cached", "HEAD", "--"]),
    runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const hash = createHash("sha256").update(status).update(unstaged).update(staged);
  for (const name of untracked.split("\0").filter(Boolean).sort()) {
    const candidate = await realpathOrSelf(join(root, name));
    if (!isStrictlyWithin(root, candidate)) { hash.update(`escape:${name}`); continue; }
    const info = await lstat(join(root, name));
    hash.update(name).update(String(info.mode));
    if (info.isSymbolicLink()) hash.update(await readlink(join(root, name)));
    else if (info.isFile() && info.size <= MAX_FINGERPRINT_FILE_BYTES) hash.update(await readFile(/*turbopackIgnore: true*/ candidate));
    else hash.update(`size:${info.size}`);
  }
  return { branch, head, fingerprint: hash.digest("hex") };
}

function compareRuntimeState(policy: RuntimePolicy, before: RuntimeState, after: RuntimeState): RuntimeViolation[] {
  const violations: RuntimeViolation[] = [];
  if (before.registrations !== after.registrations || before.siblings !== after.siblings) violations.push("unexpected_worktree");
  if (before.repositories !== after.repositories) violations.push("unexpected_write");
  if (before.base.head !== after.base.head) violations.push(policy.workingRoot === policy.writableRoot ? "base_repo_changed" : "head_changed");
  if (before.base.branch !== after.base.branch) violations.push(policy.workingRoot === policy.writableRoot ? "base_repo_changed" : "branch_changed");
  if (before.base.fingerprint !== after.base.fingerprint) violations.push(before.targetIsBase ? "unexpected_write" : "base_repo_changed");
  if (before.target.head !== after.target.head) violations.push("head_changed");
  if (before.target.branch !== after.target.branch) violations.push("branch_changed");
  if (!policy.allowWrite && before.target.fingerprint !== after.target.fingerprint) violations.push("unexpected_write");
  return [...new Set(violations)];
}

function parseWorktrees(value: string) {
  return value.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length));
}

async function realpathOrSelf(path: string) {
  try { return await realpath(path); } catch { return path; }
}

async function captureSiblingRepositories(allowedRoot: string, baseRoot: string) {
  const entries = await readdir(allowedRoot, { withFileTypes: true });
  const states = await Promise.all(entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map(async (entry) => {
    try {
      const repo = await validateRepository(entry.name, allowedRoot);
      if (repo.path === baseRoot) return undefined;
      return [repo.path, await captureWorktree(repo.path)] as const;
    } catch { return undefined; }
  }));
  return createHash("sha256").update(JSON.stringify(states.filter(Boolean))).digest("hex");
}

function violationResult(agent: AgentId, violation: RuntimeViolation): AgentResult {
  return { agent, status: "error", output: "", error: runtimeViolationMessage(violation), runtimeViolation: violation };
}
