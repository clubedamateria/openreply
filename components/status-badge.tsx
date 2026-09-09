/**
 * Status badge for DM status. Pill with icon plus visible label.
 */

import { Ban, Check, Clock, Copy, Gauge, SearchX, X, type LucideIcon } from "lucide-react";

const statusConfig: Record<string, { badge: string; label: string; icon: LucideIcon }> = {
  SENT: { badge: "badge-success", label: "Enviada", icon: Check },
  FAILED: { badge: "badge-error", label: "Falhou", icon: X },
  PENDING: { badge: "badge-warning", label: "Pendente", icon: Clock },
  SKIPPED_DEDUP: { badge: "badge-neutral", label: "Duplicada", icon: Copy },
  SKIPPED_RATE_LIMIT: { badge: "badge-warning", label: "Limite de envio", icon: Gauge },
  SKIPPED_PLAN_LIMIT: { badge: "badge-warning", label: "Ignorada", icon: Ban },
  SKIPPED_NO_MATCH: { badge: "badge-neutral", label: "Sem correspondência", icon: SearchX },
};

interface StatusBadgeProps {
  status: string;
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  const config = statusConfig[status] ?? statusConfig.PENDING;
  const Icon = config.icon;

  return (
    <span className={`badge ${config.badge} shrink-0`}>
      <Icon size={12} aria-hidden="true" />
      {config.label}
    </span>
  );
}
