type StatusBadgeProps = {
  status: "ready" | "ok" | "warning" | "attention" | "critical" | "enforced";
};

const labels: Record<StatusBadgeProps["status"], string> = {
  ready: "READY", ok: "OK", warning: "WARNING", attention: "ATTENTION", critical: "CRITICAL", enforced: "ENFORCED",
};

/** A single, text-labelled status treatment for operational state. */
export function StatusBadge({ status }: StatusBadgeProps) {
  return <span className={`statusBadge statusBadge-${status}`}>{labels[status]}</span>;
}
