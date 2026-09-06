import { registeredServerSecretEnvironmentNames } from "./credential-resolver";

export type ChildProcessPurpose = "agent" | "validation" | "git" | "github";

const BASE_KEYS = new Set([
  "PATH", "HOME", "USER", "USERNAME", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM",
  "TMPDIR", "TMP", "TEMP", "SystemRoot", "SYSTEMROOT", "COMSPEC", "PATHEXT", "NODE_ENV",
]);
const AUTH_STORE_PATH_KEYS = new Set(["CODEX_HOME", "CLAUDE_CONFIG_DIR", "CURSOR_CONFIG_DIR"]);
const GIT_AUTH_BROKER_KEYS = new Set(["SSH_AUTH_SOCK", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_ASKPASS", "SSH_ASKPASS"]);
const GITHUB_CONFIG_KEYS = new Set(["GH_CONFIG_DIR"]);
const SECRET_NAME = /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD)(?:$|_)/i;

export function buildChildProcessEnv(input: {
  purpose: ChildProcessPurpose;
  baseEnv?: Readonly<Record<string, string | undefined>>;
  overrides?: Readonly<Record<string, string | undefined>>;
}): NodeJS.ProcessEnv {
  const source = input.baseEnv ?? process.env;
  const allowed = new Set(BASE_KEYS);
  if (input.purpose === "agent") for (const key of AUTH_STORE_PATH_KEYS) allowed.add(key);
  if (input.purpose === "git" || input.purpose === "github") for (const key of GIT_AUTH_BROKER_KEYS) allowed.add(key);
  if (input.purpose === "github") for (const key of GITHUB_CONFIG_KEYS) allowed.add(key);

  const output: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    if (allowed.has(key) || key.startsWith("LC_") || key.startsWith("XDG_")) output[key] = value;
  }
  for (const [key, value] of Object.entries(input.overrides ?? {})) output[key] = value;

  const registered = registeredServerSecretEnvironmentNames();
  for (const key of Object.keys(output)) {
    if (registered.has(key) || SECRET_NAME.test(key) || key.toUpperCase() === "AUTHORIZATION") delete output[key];
  }
  return output as NodeJS.ProcessEnv;
}

export function buildServerGitMutationEnv(baseEnv: Readonly<Record<string, string | undefined>> = process.env): NodeJS.ProcessEnv {
  const output = buildChildProcessEnv({ purpose: "git", baseEnv });
  for (const key of Object.keys(output)) {
    if (key === "GIT_DIR" || key === "GIT_WORK_TREE" || key === "GIT_INDEX_FILE" || key.startsWith("GIT_CONFIG_")) delete output[key];
  }
  delete output.GIT_SSH;
  delete output.GIT_SSH_COMMAND;
  delete output.GIT_ASKPASS;
  delete output.SSH_ASKPASS;
  output.GIT_CONFIG_NOSYSTEM = "1";
  output.GIT_CONFIG_SYSTEM = "/dev/null";
  output.GIT_CONFIG_GLOBAL = "/dev/null";
  output.GIT_NO_REPLACE_OBJECTS = "1";
  return output;
}
