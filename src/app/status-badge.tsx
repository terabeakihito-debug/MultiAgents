type StatusBadgeProps = {
  status: "ready" | "ok" | "warning" | "attention" | "critical" | "enforced";
};

const labels: Record<StatusBadgeProps["status"], string> = {
  ready: "準備完了", ok: "正常", warning: "警告", attention: "要確認", critical: "重大", enforced: "適用中",
};

/** A single, text-labelled status treatment for operational state. */
export function StatusBadge({ status }: StatusBadgeProps) {
  return <span className={`statusBadge statusBadge-${status}`}>{labels[status]}</span>;
}
