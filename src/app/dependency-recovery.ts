export type PublicDependencyRecovery = {
  reason: "dependency_setup_required";
  recheckAvailable: true;
};

/** Keeps the UI narrow: only the server-issued, fixed recovery reason renders this card. */
export function dependencyRecoveryPresentation(value: unknown): PublicDependencyRecovery | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const recovery = value as { reason?: unknown; recheckAvailable?: unknown };
  return recovery.reason === "dependency_setup_required" && recovery.recheckAvailable === true
    ? { reason: "dependency_setup_required", recheckAvailable: true }
    : undefined;
}
