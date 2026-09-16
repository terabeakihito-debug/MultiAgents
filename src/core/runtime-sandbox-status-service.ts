import {
  checkOsSandboxAvailability,
  publicOsSandboxPolicy,
} from "../server/os-sandbox";

type RuntimeSandboxStatusDependencies = {
  checkAvailability: typeof checkOsSandboxAvailability;
  publicPolicy: typeof publicOsSandboxPolicy;
};

export type RuntimeSandboxStatusResponse = {
  statusCode: number;
  body: Record<string, unknown>;
};

export function createRuntimeSandboxStatusService(dependencies: RuntimeSandboxStatusDependencies = {
  checkAvailability: checkOsSandboxAvailability,
  publicPolicy: publicOsSandboxPolicy,
}) {
  return {
    async load(): Promise<RuntimeSandboxStatusResponse> {
      try {
        const backend = await dependencies.checkAvailability();
        return {
          statusCode: 200,
          body: {
            status: "enforced",
            backend: backend.backend,
            policyVersion: backend.version,
            agentReadOnly: dependencies.publicPolicy("agent_read_only"),
            agentImplement: dependencies.publicPolicy("agent_implement"),
            validation: dependencies.publicPolicy("validation"),
          },
        };
      } catch (error) {
        return {
          statusCode: 503,
          body: {
            status: "unavailable",
            error: "OS sandbox unavailable. Task execution blocked.",
            failureCode:
              error instanceof Error && "failureCode" in error
                ? (error as Error & { failureCode: string }).failureCode
                : "namespace_unsupported",
          },
        };
      }
    },
  };
}

/** Framework-independent runtime sandbox status read boundary used by transport adapters. */
export const runtimeSandboxStatusService = createRuntimeSandboxStatusService();
