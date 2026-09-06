import "server-only";
import { inspect } from "node:util";
import {
  credentialCapabilities,
  type CredentialCapability,
  type CredentialStatusView,
} from "../credentials/types";

type EnvironmentRegistryEntry = { source: "environment"; envName: string };
type ExternalRegistryEntry = { source: "external_cli" };
type CredentialRegistryEntry = EnvironmentRegistryEntry | ExternalRegistryEntry;

const CREDENTIAL_REGISTRY: Readonly<Record<CredentialCapability, CredentialRegistryEntry>> = Object.freeze({
  slack_outbound: { source: "environment", envName: "MULTIAGENTS_SLACK_WEBHOOK_URL" },
  github_cli: { source: "external_cli" },
  agent_codex: { source: "external_cli" },
  agent_cursor: { source: "external_cli" },
  agent_claude: { source: "external_cli" },
});

const REDACTED = "[REDACTED_SECRET]";
const inspectCustom = inspect.custom;
const activeSecrets = new WeakSet<SecretValue>();

export class SecretValue {
  readonly kind = "secret" as const;
  readonly #capability: CredentialCapability;
  readonly #value: string;

  constructor(capability: CredentialCapability, value: string) {
    this.#capability = capability;
    this.#value = value;
    activeSecrets.add(this);
    Object.freeze(this);
  }

  revealForCapability(capability: CredentialCapability): string {
    if (!activeSecrets.has(this)) throw new CredentialAccessError("Credential reference has expired");
    if (capability !== this.#capability) throw new CredentialAccessError("Credential capability mismatch");
    return this.#value;
  }

  toString() { return REDACTED; }
  toJSON() { return REDACTED; }
  [Symbol.toPrimitive]() { return REDACTED; }
  [inspectCustom]() { return REDACTED; }
}

export class CredentialAccessError extends Error {}

export type CredentialResolver = {
  status(capability: CredentialCapability): CredentialStatusView;
  statuses(): CredentialStatusView[];
  withCredential<T>(capability: CredentialCapability, callback: (credential: SecretValue) => T | Promise<T>): Promise<T>;
};

type EnvironmentValues = Readonly<Record<string, string | undefined>>;

export function createCredentialResolver(environment: EnvironmentValues = process.env): CredentialResolver {
  function requireCapability(value: CredentialCapability): CredentialRegistryEntry {
    if (!credentialCapabilities.includes(value)) throw new CredentialAccessError("Unsupported credential capability");
    return CREDENTIAL_REGISTRY[value];
  }

  function status(capability: CredentialCapability): CredentialStatusView {
    const entry = requireCapability(capability);
    if (entry.source === "external_cli") return { capability, status: "externally_managed", source: "external_cli" };
    return {
      capability,
      status: environment[entry.envName]?.trim() ? "configured" : "not_configured",
      source: "environment",
    };
  }

  return Object.freeze({
    status,
    statuses: () => credentialCapabilities.map(status),
    async withCredential<T>(capability: CredentialCapability, callback: (credential: SecretValue) => T | Promise<T>) {
      const entry = requireCapability(capability);
      if (entry.source !== "environment") throw new CredentialAccessError("Credential is managed externally");
      const value = environment[entry.envName]?.trim();
      if (!value) throw new CredentialAccessError("Credential is not configured");
      const secret = new SecretValue(capability, value);
      try {
        return await callback(secret);
      } finally {
        activeSecrets.delete(secret);
      }
    },
  });
}

export const credentialResolver = createCredentialResolver();

export function registeredServerSecretEnvironmentNames(): ReadonlySet<string> {
  return new Set(Object.values(CREDENTIAL_REGISTRY).flatMap((entry) => entry.source === "environment" ? [entry.envName] : []));
}

function knownSecretValues(environment: EnvironmentValues = process.env) {
  return Object.values(CREDENTIAL_REGISTRY)
    .flatMap((entry) => entry.source === "environment" ? [environment[entry.envName]?.trim()] : [])
    .filter((value): value is string => Boolean(value && value.length >= 8));
}

export function containsKnownSecret(value: string | Buffer, environment: EnvironmentValues = process.env) {
  const content = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  return knownSecretValues(environment).some((secret) => content.includes(secret));
}

export function redactKnownSecrets(value: string, environment: EnvironmentValues = process.env) {
  return knownSecretValues(environment).reduce((safe, secret) => safe.split(secret).join(REDACTED), value);
}

export function redactKnownSecretsInValue<T>(value: T, environment: EnvironmentValues = process.env): T {
  if (typeof value === "string") return redactKnownSecrets(value, environment) as T;
  if (Array.isArray(value)) return value.map((item) => redactKnownSecretsInValue(item, environment)) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactKnownSecretsInValue(item, environment)])) as T;
  }
  return value;
}
