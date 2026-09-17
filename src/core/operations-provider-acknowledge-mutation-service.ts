import {
  acknowledgeProviderVersion,
  providerDiagnostics,
} from "../server/provider-diagnostics";
import type { AgentId } from "../agents/types";

const KNOWN_PROVIDERS = ["codex", "cursor", "claude"] as const satisfies readonly AgentId[];

type KnownProvider = (typeof KNOWN_PROVIDERS)[number];

type OperationsProviderAcknowledgeMutationDependencies = {
  loadDiagnostics: typeof providerDiagnostics;
  acknowledge: typeof acknowledgeProviderVersion;
};

export class OperationsProviderAcknowledgeNotFoundError extends Error {
  constructor() {
    super("Unknown provider");
    this.name = "OperationsProviderAcknowledgeNotFoundError";
  }
}

export class OperationsProviderAcknowledgeConflictError extends Error {
  constructor() {
    super("Only a passing provider version can be acknowledged");
    this.name = "OperationsProviderAcknowledgeConflictError";
  }
}

function isKnownProvider(provider: string): provider is KnownProvider {
  return (KNOWN_PROVIDERS as readonly string[]).includes(provider);
}

export function createOperationsProviderAcknowledgeMutationService(
  dependencies: OperationsProviderAcknowledgeMutationDependencies = {
    loadDiagnostics: () => providerDiagnostics(),
    acknowledge: acknowledgeProviderVersion,
  },
) {
  return {
    async apply(providerParam: string) {
      if (!isKnownProvider(providerParam)) {
        throw new OperationsProviderAcknowledgeNotFoundError();
      }
      const provider = providerParam;
      const diagnostic = (await dependencies.loadDiagnostics()).find(
        (item) => item.provider === provider,
      );
      if (
        !diagnostic?.version ||
        !["supported", "supported_with_warning"].includes(diagnostic.status)
      ) {
        throw new OperationsProviderAcknowledgeConflictError();
      }
      dependencies.acknowledge(provider, diagnostic.version);
      return { provider, version: diagnostic.version };
    },
  };
}

/** Framework-independent operations provider acknowledge mutation used by transport adapters. */
export const operationsProviderAcknowledgeMutationService =
  createOperationsProviderAcknowledgeMutationService();
