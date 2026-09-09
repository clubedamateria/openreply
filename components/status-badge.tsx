/**
 * Status label for DM status. Plain text; color carries the state.
 */

const statusConfig: Record<string, { text: string; label: string }> = {
  SENT: { text: "text-success", label: "Enviada" },
  FAILED: { text: "text-error", label: "Falhou" },
  PENDING: { text: "text-warning", label: "Pendente" },
  SKIPPED_DEDUP: { text: "text-muted", label: "Duplicada" },
  SKIPPED_RATE_LIMIT: { text: "text-warning", label: "Limite de envio" },
  SKIPPED_PLAN_LIMIT: { text: "text-warning", label: "Ignorada" },
  SKIPPED_NO_MATCH: { text: "text-muted", label: "Sem correspondência" },
};

interface StatusBadgeProps {
  status: string;
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  const config = statusConfig[status] ?? statusConfig.PENDING;

  return (
    <span className={`shrink-0 whitespace-nowrap text-sm ${config.text}`}>
      {config.label}
    </span>
  );
}
