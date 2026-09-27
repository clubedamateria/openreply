/**
 * Status badge for ScheduledPost. Same visual language as StatusBadge (used
 * for DmStatus), kept separate because the two enums do not overlap in
 * meaning — PREPARING/PUBLISHING have no DM equivalent.
 */

import {
  Ban,
  Check,
  Clock,
  Loader2,
  UploadCloud,
  X,
  type LucideIcon,
} from "lucide-react";

const statusConfig: Record<string, { badge: string; label: string; icon: LucideIcon }> = {
  SCHEDULED: { badge: "badge-info", label: "Agendado", icon: Clock },
  PREPARING: { badge: "badge-warning", label: "Preparando", icon: Loader2 },
  PUBLISHING: { badge: "badge-warning", label: "Publicando", icon: UploadCloud },
  PUBLISHED: { badge: "badge-success", label: "Publicado", icon: Check },
  FAILED: { badge: "badge-error", label: "Falhou", icon: X },
  CANCELED: { badge: "badge-neutral", label: "Cancelado", icon: Ban },
};

interface ScheduledPostStatusBadgeProps {
  status: string;
}

export default function ScheduledPostStatusBadge({
  status,
}: ScheduledPostStatusBadgeProps) {
  const config = statusConfig[status] ?? statusConfig.SCHEDULED;
  const Icon = config.icon;

  return (
    <span className={`badge ${config.badge} shrink-0`}>
      <Icon size={12} aria-hidden="true" />
      {config.label}
    </span>
  );
}
