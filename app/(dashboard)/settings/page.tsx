"use client";

import { Suspense, useEffect, useState } from "react";
import {
  AtSign,
  Users,
  Mail,
  Copy,
  Trash2,
  RefreshCw,
  Unplug,
  MessageSquare,
  Link2,
} from "lucide-react";
import type { AccountOption } from "@/components/account-select";
import { ZernioConnection } from "@/components/zernio-connection";
import { InstagramConnectNotice } from "@/components/instagram-connect-notice";

interface SettingsData {
  workspace: {
    name: string;
    dmsSentThisPeriod: number;
  };
  instagramAccount: {
    id: string;
    username: string;
    instagramId: string;
    tokenExpiresAt: string | null;
    webhookSubscribed: boolean;
  } | null;
  instagramAccounts: Array<
    AccountOption & {
      provider?: "META" | "ZERNIO";
      tokenExpiresAt: string | null;
      webhookSubscribed: boolean;
    }
  >;
}

interface WorkspaceMembersData {
  currentUserRole: "OWNER" | "ADMIN" | "MEMBER";
  members: Array<{
    id: string;
    role: "OWNER" | "ADMIN" | "MEMBER";
    createdAt: string;
    user: {
      id: string;
      email: string | null;
      name: string | null;
    };
  }>;
  invitations: Array<{
    id: string;
    email: string;
    role: "OWNER" | "ADMIN" | "MEMBER";
    inviteUrl: string;
    expiresAt: string;
  }>;
}

const ROLE_LABELS: Record<"OWNER" | "ADMIN" | "MEMBER", string> = {
  OWNER: "Dono",
  ADMIN: "Admin",
  MEMBER: "Membro",
};

export default function SettingsPage() {
  const [data, setData] = useState<SettingsData | null>(null);
  const [membersData, setMembersData] = useState<WorkspaceMembersData | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"ADMIN" | "MEMBER">("MEMBER");
  const [memberError, setMemberError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/dashboard/stats").then((res) => res.json()),
      fetch("/api/workspace/members").then((res) => res.json()),
    ])
      .then(([statsPayload, membersPayload]) => {
        if (statsPayload.success) setData(statsPayload.data);
        if (membersPayload.success) setMembersData(membersPayload.data);
      })
      .finally(() => setLoading(false));
  }, []);

  async function refreshMembers() {
    const res = await fetch("/api/workspace/members");
    const payload = await res.json();
    if (payload.success) setMembersData(payload.data);
  }

  async function disconnectInstagram(instagramAccountId: string) {
    if (!confirm("Desconectar o Instagram? As campanhas desta conta vão parar de enviar DMs.")) {
      return;
    }

    setBusy(`disconnect:${instagramAccountId}`);
    await fetch("/api/instagram/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instagramAccountId }),
    });
    window.location.reload();
  }

  async function inviteMember(event: React.FormEvent) {
    event.preventDefault();
    setMemberError(null);
    setBusy("invite");
    const res = await fetch("/api/workspace/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
    });
    const payload = await res.json();
    if (payload.success) {
      setMembersData(payload.data);
      setInviteEmail("");
    } else {
      setMemberError(payload.error ?? "Não foi possível convidar o membro");
    }
    setBusy(null);
  }

  async function removeInvitation(invitationId: string) {
    setBusy(`invite:${invitationId}`);
    await fetch("/api/workspace/members", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invitationId }),
    });
    await refreshMembers();
    setBusy(null);
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <div className="skeleton h-56 rounded-2xl" />
        <div className="skeleton h-48 rounded-2xl" />
        <div className="skeleton h-24 rounded-2xl" />
      </div>
    );
  }

  const accounts = data?.instagramAccounts ?? [];
  const canManageMembers =
    membersData?.currentUserRole === "OWNER" ||
    membersData?.currentUserRole === "ADMIN";

  return (
    <div className="mx-auto max-w-2xl space-y-6 stagger">
      {/* Surfaces the ?instagram= code the OAuth routes redirect back with.
          Needs a Suspense boundary: useSearchParams in a prerendered client
          page fails the production build without one. */}
      <Suspense fallback={null}>
        <InstagramConnectNotice />
      </Suspense>

      <ZernioConnection canManage={canManageMembers} />

      {/* Conta do Instagram */}
      <section className="card p-4 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="icon-tile bg-brand-soft text-brand" aria-hidden="true">
              <AtSign size={20} />
            </span>
            <div>
              <h2 className="text-base font-extrabold text-foreground">
                Conta do Instagram
              </h2>
              <p className="helper mt-0">
                Os webhooks de comentários e as respostas privadas dependem desta conexão.
              </p>
            </div>
          </div>
          <span
            className={`badge ${
              accounts.length > 0 ? "badge-success" : "badge-warning"
            }`}
          >
            {accounts.length > 0 ? "Conectado" : "Não conectado"}
          </span>
        </div>

        <div className="mt-5 space-y-3">
          {accounts.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <span className="icon-tile bg-sun-soft text-warning" aria-hidden="true">
                <Link2 size={22} />
              </span>
              <p className="text-sm text-muted">
                Conecte uma conta profissional do Instagram para lançar campanhas.
              </p>
            </div>
          )}
          {accounts.map((account) => (
            <div
              key={account.id}
              className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand text-base font-extrabold uppercase text-white"
                  aria-hidden="true"
                >
                  {account.username.charAt(0)}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-extrabold text-foreground">
                    @{account.username}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    {account.provider === "ZERNIO" ? (
                      "Conectado via integração"
                    ) : (
                      <>
                        Token válido até{" "}
                        {account.tokenExpiresAt
                          ? new Date(account.tokenExpiresAt).toLocaleDateString("pt-BR")
                          : "data indisponível"}
                      </>
                    )}
                  </p>
                  <span
                    className={`badge mt-2 ${
                      account.webhookSubscribed ? "badge-success" : "badge-warning"
                    }`}
                  >
                    {account.webhookSubscribed ? "Webhook pronto" : "Webhook pendente"}
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <a href="/api/instagram/connect" className="btn btn-secondary btn-sm">
                  <RefreshCw size={16} aria-hidden="true" />
                  Reconectar
                </a>
                <button
                  type="button"
                  onClick={() => disconnectInstagram(account.id)}
                  disabled={busy === `disconnect:${account.id}`}
                  className="btn btn-danger btn-sm"
                >
                  <Unplug size={16} aria-hidden="true" />
                  {busy === `disconnect:${account.id}`
                    ? "Desconectando..."
                    : "Desconectar"}
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted">
            {accounts.length > 0
              ? `${accounts.length} perfil${accounts.length === 1 ? "" : "s"} conectado${accounts.length === 1 ? "" : "s"}`
              : "Nenhum perfil conectado"}
          </p>
          <a href="/api/instagram/connect" className="btn btn-primary">
            <AtSign size={18} aria-hidden="true" />
            Conectar usando seu próprio app da Meta
          </a>
        </div>
      </section>

      {/* Equipe */}
      <section className="card p-4 sm:p-6">
        <div className="flex items-center gap-3">
          <span className="icon-tile bg-accent-soft text-accent" aria-hidden="true">
            <Users size={20} />
          </span>
          <div>
            <h2 className="text-base font-extrabold text-foreground">Equipe</h2>
            <p className="helper mt-0">Quem pode acessar este painel.</p>
          </div>
        </div>

        <div className="mt-5 divide-y divide-border">
          {membersData?.members.map((member) => (
            <div
              key={member.id}
              className="flex items-center justify-between gap-4 py-3"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-soft text-sm font-extrabold uppercase text-brand"
                  aria-hidden="true"
                >
                  {(member.user.name ?? member.user.email ?? "?").charAt(0)}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-foreground">
                    {member.user.name ?? member.user.email ?? "Membro desconhecido"}
                  </p>
                  <p className="truncate text-xs text-muted">{member.user.email}</p>
                </div>
              </div>
              <span className="badge badge-neutral">{ROLE_LABELS[member.role]}</span>
            </div>
          ))}
        </div>

        {membersData?.invitations.length ? (
          <div className="mt-5 border-t border-border pt-5">
            <p className="mb-3 text-xs font-bold uppercase tracking-wide text-muted">
              Convites pendentes
            </p>
            <div className="space-y-3">
              {membersData.invitations.map((invitation) => (
                <div
                  key={invitation.id}
                  className="flex flex-col gap-3 rounded-2xl border border-border bg-surface-hover p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="icon-tile bg-sun-soft text-warning" aria-hidden="true">
                      <Mail size={18} />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-foreground">
                        {invitation.email}
                      </p>
                      <p className="truncate text-xs text-muted">
                        {ROLE_LABELS[invitation.role]} · {invitation.inviteUrl}
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        void navigator.clipboard?.writeText(invitation.inviteUrl)
                      }
                      className="btn btn-secondary btn-sm"
                    >
                      <Copy size={16} aria-hidden="true" />
                      Copiar
                    </button>
                    <button
                      type="button"
                      onClick={() => removeInvitation(invitation.id)}
                      disabled={busy === `invite:${invitation.id}`}
                      className="btn btn-danger btn-sm"
                    >
                      <Trash2 size={16} aria-hidden="true" />
                      Revogar
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {canManageMembers && (
          <form
            onSubmit={inviteMember}
            className="mt-5 grid gap-3 border-t border-border pt-5 sm:grid-cols-[1fr_150px_auto] sm:items-end"
          >
            <div>
              <label htmlFor="invite-email" className="label">
                E-mail do convidado
              </label>
              <input
                id="invite-email"
                type="email"
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                placeholder="colega@agencia.com"
                className="field"
                required
              />
            </div>
            <div>
              <label htmlFor="invite-role" className="label">
                Papel
              </label>
              <select
                id="invite-role"
                value={inviteRole}
                onChange={(event) =>
                  setInviteRole(event.target.value as "ADMIN" | "MEMBER")
                }
                className="field"
              >
                <option value="MEMBER">Membro</option>
                <option value="ADMIN">Admin</option>
              </select>
            </div>
            <button
              type="submit"
              disabled={busy === "invite"}
              className="btn btn-brand"
            >
              <Mail size={18} aria-hidden="true" />
              {busy === "invite" ? "Convidando..." : "Convidar"}
            </button>
            {memberError && (
              <p className="text-xs text-error sm:col-span-3">{memberError}</p>
            )}
          </form>
        )}
      </section>

      {/* Uso */}
      <section className="card p-4 sm:p-6">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="icon-tile bg-success-soft text-success" aria-hidden="true">
              <MessageSquare size={20} />
            </span>
            <div>
              <p className="text-sm font-bold text-foreground">
                DMs enviadas este mês
              </p>
              <p className="helper mt-0">Sem limites de plano.</p>
            </div>
          </div>
          <span className="text-2xl font-extrabold text-foreground">
            {data?.workspace.dmsSentThisPeriod ?? 0}
          </span>
        </div>
      </section>
    </div>
  );
}
