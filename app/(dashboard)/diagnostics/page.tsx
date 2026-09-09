"use client";

import { useEffect, useState } from "react";
import {
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Activity,
  Bell,
  MessageSquareWarning,
  Webhook,
  KeyRound,
  ListChecks,
  Clock,
  Loader,
  Hourglass,
  Ban,
} from "lucide-react";
import StatusBadge from "@/components/status-badge";

interface DiagnosticsData {
  queueCounts: Record<string, number>;
  workerHealth: {
    healthy: boolean;
    ageMs: number | null;
    heartbeat: {
      checkedAt: string;
      hostname?: string;
      pid: number;
      startedAt?: string;
    } | null;
  };
  workerAlerts: Array<{
    level: string;
    message: string;
    jobId?: string;
    commentId?: string;
    createdAt: string;
  }>;
  webhookFailures: Array<{
    id: string;
    object: string | null;
    errorMessage: string | null;
    createdAt: string;
  }>;
  dmFailures: Array<{
    id: string;
    status: string;
    commentId: string;
    commentText: string;
    errorMessage: string | null;
    updatedAt: string;
    automation: { name: string };
  }>;
  tokenRefreshFailures: Array<{
    id: string;
    message: string;
    createdAt: string;
  }>;
  operationalEvents: Array<{
    id: string;
    source: string;
    level: string;
    message: string;
    createdAt: string;
    resolvedAt: string | null;
  }>;
}

type HealthState = "success" | "warning" | "error";

const HEALTH_STYLES: Record<
  HealthState,
  { tile: string; Icon: typeof CheckCircle2; label: string }
> = {
  success: { tile: "bg-success-soft text-success", Icon: CheckCircle2, label: "Tudo certo" },
  warning: { tile: "bg-warning-soft text-warning", Icon: AlertTriangle, label: "Atenção" },
  error: { tile: "bg-error-soft text-error", Icon: XCircle, label: "Com falha" },
};

const QUEUE_META: Record<string, { label: string; Icon: typeof Clock }> = {
  waiting: { label: "Aguardando", Icon: Clock },
  active: { label: "Ativa", Icon: Loader },
  delayed: { label: "Atrasada", Icon: Hourglass },
  failed: { label: "Falha", Icon: Ban },
};

function formatDate(value: string) {
  return new Date(value).toLocaleString("pt-BR");
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center">
      <span className="icon-tile bg-sun-soft text-warning" aria-hidden="true">
        <CheckCircle2 size={22} />
      </span>
      <p className="text-sm text-muted">{label}</p>
    </div>
  );
}

function HealthCard({
  state,
  title,
  detail,
}: {
  state: HealthState;
  title: string;
  detail: string;
}) {
  const { tile, Icon, label } = HEALTH_STYLES[state];
  return (
    <div className="card flex items-center gap-4 p-4 sm:p-5">
      <span className={`icon-tile ${tile}`} aria-hidden="true">
        <Icon size={22} />
      </span>
      <div className="min-w-0">
        <p className="text-xs font-bold uppercase tracking-wide text-muted">{title}</p>
        <p className="mt-1 text-base font-extrabold text-foreground">{label}</p>
        <p className="mt-0.5 text-xs text-muted">{detail}</p>
      </div>
    </div>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="card p-4 sm:p-6">
      <div className="flex items-center gap-3">
        {icon && (
          <span className="icon-tile bg-brand-soft text-brand" aria-hidden="true">
            {icon}
          </span>
        )}
        <h2 className="text-base font-extrabold text-foreground">{title}</h2>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export default function DiagnosticsPage() {
  const [data, setData] = useState<DiagnosticsData | null>(null);
  const [loading, setLoading] = useState(true);

  async function refreshDiagnostics() {
    setLoading(true);
    const response = await fetch("/api/admin/diagnostics");
    const payload = await response.json();
    if (payload.success) {
      setData(payload.data);
    }
    setLoading(false);
  }

  useEffect(() => {
    let active = true;

    async function loadInitialDiagnostics() {
      const response = await fetch("/api/admin/diagnostics");
      const payload = await response.json();
      if (active && payload.success) {
        setData(payload.data);
      }
      if (active) {
        setLoading(false);
      }
    }

    void loadInitialDiagnostics();

    return () => {
      active = false;
    };
  }, []);

  if (loading && !data) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="skeleton h-12 w-64 rounded-2xl" />
        <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="skeleton h-24 rounded-2xl" />
          ))}
        </div>
        <div className="skeleton h-40 rounded-2xl" />
      </div>
    );
  }

  const workerAgeSeconds =
    data?.workerHealth.ageMs == null
      ? null
      : Math.round(data.workerHealth.ageMs / 1000);

  const workerState: HealthState =
    workerAgeSeconds == null ? "error" : data?.workerHealth.healthy ? "success" : "warning";
  const failedQueue = data?.queueCounts.failed ?? 0;
  const queueState: HealthState = failedQueue === 0 ? "success" : "warning";
  const webhookState: HealthState = data?.webhookFailures.length ? "error" : "success";
  const tokenState: HealthState = data?.tokenRefreshFailures.length ? "error" : "success";

  return (
    <div className="mx-auto max-w-5xl space-y-6 stagger">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-extrabold text-brand">
            Diagnóstico de Produção
          </h1>
          <p className="mt-1 text-sm text-muted">
            Saúde, filas, falhas de webhook, eventos de cobrança e alertas do worker.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refreshDiagnostics()}
          disabled={loading}
          className="btn btn-secondary"
        >
          <RefreshCw size={18} aria-hidden="true" />
          Atualizar
        </button>
      </div>

      <div className="grid gap-3 sm:gap-4 md:grid-cols-2">
        <HealthCard
          state={workerState}
          title="Saúde do worker"
          detail={
            workerAgeSeconds == null
              ? "Nenhum heartbeat encontrado"
              : `Último heartbeat há ${workerAgeSeconds}s`
          }
        />
        <HealthCard
          state={queueState}
          title="Fila de envios"
          detail={
            failedQueue === 0
              ? "Nenhum job com falha"
              : `${failedQueue} job${failedQueue === 1 ? "" : "s"} com falha`
          }
        />
        <HealthCard
          state={webhookState}
          title="Webhooks"
          detail={
            data?.webhookFailures.length
              ? `${data.webhookFailures.length} falha${data.webhookFailures.length === 1 ? "" : "s"} recente${data.webhookFailures.length === 1 ? "" : "s"}`
              : "Nenhuma falha recente"
          }
        />
        <HealthCard
          state={tokenState}
          title="Renovação de token"
          detail={
            data?.tokenRefreshFailures.length
              ? `${data.tokenRefreshFailures.length} falha${data.tokenRefreshFailures.length === 1 ? "" : "s"} registrada${data.tokenRefreshFailures.length === 1 ? "" : "s"}`
              : "Nenhuma falha registrada"
          }
        />
      </div>

      <div className="card p-4 sm:p-6">
        <div className="flex items-center gap-3">
          <span className="icon-tile bg-brand-soft text-brand" aria-hidden="true">
            <ListChecks size={20} />
          </span>
          <h2 className="text-base font-extrabold text-foreground">Filas</h2>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {["waiting", "active", "delayed", "failed"].map((key) => {
            const meta = QUEUE_META[key];
            return (
              <div
                key={key}
                className="rounded-2xl border border-border bg-surface-hover p-3 sm:p-4"
              >
                <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-muted">
                  <meta.Icon size={14} aria-hidden="true" />
                  {meta.label}
                </p>
                <p className="mt-2 text-2xl font-extrabold text-foreground">
                  {data?.queueCounts[key] ?? 0}
                </p>
              </div>
            );
          })}
        </div>
      </div>

      <Section title="Alertas Recentes do Worker" icon={<Bell size={20} />}>
        {data?.workerAlerts.length ? (
          <div className="space-y-3">
            {data.workerAlerts.map((alert) => (
              <div
                key={`${alert.createdAt}-${alert.jobId ?? alert.message}`}
                className="rounded-2xl border border-border bg-surface-hover p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                  <p className="min-w-0 flex-1 break-words text-sm font-bold text-foreground">
                    {alert.message}
                  </p>
                  <span className="badge badge-error">{alert.level}</span>
                </div>
                <p className="mt-2 text-xs text-muted">
                  {formatDate(alert.createdAt)}
                  {alert.commentId ? ` · ${alert.commentId}` : ""}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState label="Nenhum alerta do worker registrado." />
        )}
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section
          title="Falhas e DMs Ignoradas nas Campanhas"
          icon={<MessageSquareWarning size={20} />}
        >
          {data?.dmFailures.length ? (
            <div className="space-y-3">
              {data.dmFailures.map((item) => (
                <div key={item.id} className="border-b border-border pb-3 last:border-0">
                  <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                    <p className="min-w-0 flex-1 truncate text-sm font-bold text-foreground">
                      {item.automation.name}
                    </p>
                    <StatusBadge status={item.status} />
                  </div>
                  <p className="mt-1 truncate text-xs text-muted">
                    {item.commentText}
                  </p>
                  {item.errorMessage && (
                    <p className="mt-1 text-xs text-error">{item.errorMessage}</p>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <EmptyState label="Nenhuma falha ou DM ignorada." />
          )}
        </Section>

        <Section title="Falhas de Webhook" icon={<Webhook size={20} />}>
          {data?.webhookFailures.length ? (
            <div className="space-y-3">
              {data.webhookFailures.map((event) => (
                <div key={event.id} className="border-b border-border pb-3 last:border-0">
                  <p className="text-sm font-bold text-foreground">
                    {event.object ?? "Webhook do Instagram"}
                  </p>
                  <p className="mt-1 text-xs text-error">
                    {event.errorMessage ?? "Erro desconhecido"}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {formatDate(event.createdAt)}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState label="Nenhum evento de webhook com falha." />
          )}
        </Section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Falhas na Renovação de Token" icon={<KeyRound size={20} />}>
          {data?.tokenRefreshFailures.length ? (
            <div className="space-y-3">
              {data.tokenRefreshFailures.map((event) => (
                <div key={event.id} className="border-b border-border pb-3 last:border-0">
                  <p className="text-sm font-bold text-foreground">
                    {event.message}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {formatDate(event.createdAt)}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState label="Nenhuma falha na renovação de token." />
          )}
        </Section>
      </div>

      <Section title="Linha do Tempo de Eventos Operacionais" icon={<Activity size={20} />}>
        {data?.operationalEvents.length ? (
          <div className="space-y-3">
            {data.operationalEvents.map((event) => (
              <div
                key={event.id}
                className="grid gap-2 border-b border-border pb-3 last:border-0 sm:grid-cols-[140px_1fr_auto]"
              >
                <p className="text-xs font-bold uppercase tracking-wide text-muted">
                  {event.source}
                </p>
                <p className="text-sm text-foreground">{event.message}</p>
                <p className="text-xs text-muted">{formatDate(event.createdAt)}</p>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState label="Nenhum evento operacional registrado." />
        )}
      </Section>
    </div>
  );
}
