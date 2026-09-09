/**
 * Stat Card
 *
 * Metric card with optional icon tile, label, value, hint and trend.
 */

import { ArrowDownRight, ArrowUpRight } from "lucide-react";

type Tone = "brand" | "accent" | "sun" | "success" | "info";

const TONE_CLASSES: Record<Tone, string> = {
  brand: "bg-brand-soft text-brand",
  accent: "bg-accent-soft text-accent",
  sun: "bg-sun-soft text-warning",
  success: "bg-success-soft text-success",
  info: "bg-info-soft text-info",
};

interface StatCardProps {
  label: string;
  value: string | number;
  trend?: string;
  trendUp?: boolean;
  icon?: React.ReactNode;
  tone?: Tone;
  hint?: string;
}

export default function StatCard({
  label,
  value,
  trend,
  trendUp,
  icon,
  tone = "brand",
  hint,
}: StatCardProps) {
  return (
    <div className="card card-hover p-5">
      {icon && (
        <span className={`icon-tile mb-4 ${TONE_CLASSES[tone]}`} aria-hidden="true">
          {icon}
        </span>
      )}
      <p className="text-3xl font-extrabold text-foreground leading-none">{value}</p>
      <p className="text-sm font-semibold text-muted mt-2">{label}</p>
      {hint && <p className="helper">{hint}</p>}
      {trend && (
        <p
          className={`mt-2 inline-flex items-center gap-1 text-xs font-bold ${
            trendUp ? "text-success" : "text-error"
          }`}
        >
          {trendUp ? (
            <ArrowUpRight size={14} aria-hidden="true" />
          ) : (
            <ArrowDownRight size={14} aria-hidden="true" />
          )}
          {trendUp ? "Subiu" : "Caiu"} {trend}
        </p>
      )}
    </div>
  );
}
