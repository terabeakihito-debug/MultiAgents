import type { AgentId } from "../agents/types";

/** Fixed, server-owned compatibility policy. It is intentionally not configurable by repos or clients. */
export type ProviderId = AgentId;
export type VersionRule = { kind: "exact" | "minor" | "build_family"; value: string };
export type ProviderCompatibilityDefinition = {
  provider: ProviderId;
  binary: string;
  supportedVersions: readonly VersionRule[];
  warningVersions: readonly VersionRule[];
  requiredFlags: readonly string[];
  credentialCapability: string;
  sandboxProfile: "agent_read_only";
};

export type ParsedProviderVersion = { normalized: string; major: number; minor: number; patch: number; build?: string };

export const providerCompatibilityDefinitions: Record<ProviderId, ProviderCompatibilityDefinition> = {
  codex: {
    provider: "codex", binary: "codex", supportedVersions: [{ kind: "minor", value: "0.153" }], warningVersions: [{ kind: "minor", value: "0.154" }],
    requiredFlags: ["--ignore-user-config", "--ignore-rules", "--ephemeral", "--sandbox", "--dangerously-bypass-approvals-and-sandbox", "--cd"], credentialCapability: "agent_codex", sandboxProfile: "agent_read_only",
  },
  cursor: {
    provider: "cursor", binary: "agent", supportedVersions: [{ kind: "build_family", value: "2026.09" }], warningVersions: [{ kind: "build_family", value: "2026.10" }],
    requiredFlags: ["--mode", "--sandbox", "--workspace", "--skip-worktree-setup", "-p"], credentialCapability: "agent_cursor", sandboxProfile: "agent_read_only",
  },
  claude: {
    provider: "claude", binary: "claude", supportedVersions: [{ kind: "minor", value: "2.1" }], warningVersions: [{ kind: "minor", value: "2.2" }],
    requiredFlags: ["--restricted", "--safe-mode", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--permission-mode", "--permission-prompts", "--tools", "-p"], credentialCapability: "agent_claude", sandboxProfile: "agent_read_only",
  },
};

export function parseProviderVersion(provider: ProviderId, output: string): ParsedProviderVersion | undefined {
  // Commands may emit an unrelated launcher warning on stderr. Accept exactly one
  // complete provider-owned version line, never a substring inside arbitrary text.
  const lines = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (provider === "codex") {
    const matches = lines.map((line) => /^codex-cli (\d+)\.(\d+)\.(\d+)$/.exec(line)).filter((match): match is RegExpExecArray => Boolean(match));
    const match = matches.length === 1 ? matches[0] : undefined;
    return match ? numeric(match) : undefined;
  }
  if (provider === "cursor") {
    const matches = lines.map((line) => /^(\d{4})\.(\d{2})\.(\d{2})-([0-9a-f]{7,64})$/.exec(line)).filter((match): match is RegExpExecArray => Boolean(match));
    const match = matches.length === 1 ? matches[0] : undefined;
    return match ? { ...numeric(match), build: match[4] } : undefined;
  }
  const matches = lines.map((line) => /^(\d+)\.(\d+)\.(\d+) \(Claude Code\)$/.exec(line)).filter((match): match is RegExpExecArray => Boolean(match));
  const match = matches.length === 1 ? matches[0] : undefined;
  return match ? numeric(match) : undefined;
}

export function classifyProviderVersion(provider: ProviderId, version: ParsedProviderVersion): "supported" | "supported_with_warning" | "unsupported_version" {
  const definition = providerCompatibilityDefinitions[provider];
  if (matches(definition.supportedVersions, provider, version)) return "supported";
  if (matches(definition.warningVersions, provider, version)) return "supported_with_warning";
  return "unsupported_version";
}

function numeric(match: RegExpExecArray): ParsedProviderVersion { return { normalized: `${match[1]}.${Number(match[2])}.${Number(match[3])}`, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }; }
function matches(rules: readonly VersionRule[], provider: ProviderId, version: ParsedProviderVersion) {
  return rules.some((rule) => rule.kind === "exact" ? version.normalized === rule.value : rule.kind === "minor" ? `${version.major}.${version.minor}` === rule.value : provider === "cursor" && `${version.major}.${String(version.minor).padStart(2, "0")}` === rule.value);
}
