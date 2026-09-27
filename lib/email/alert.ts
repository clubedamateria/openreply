import { getResendAlertConfig } from "@/lib/env";

/**
 * Fire-and-forget "a scheduled post failed" email via the Resend HTTP API.
 *
 * Deliberately not the existing `nodemailer` dependency: that ships a SMTP
 * transport, and this project's SMTP (`EMAIL_SERVER`) is not configured — see
 * docs/2026-09-27-agendados-comentarios.md. Resend's API needs only
 * `RESEND_API_KEY`, which self-hosters already set for magic-link login.
 *
 * Never throws: a failed alert must not fail the cron run it is reporting on.
 * Without RESEND_FROM/ALERT_EMAIL_TO configured, it just logs.
 */
export async function sendPublishFailureAlert(params: {
  workspaceId: string;
  scheduledPostId: string;
  username: string;
  errorMessage: string;
}): Promise<void> {
  const config = getResendAlertConfig();
  if (!config) {
    console.warn(
      "[Agendados] post falhou mas RESEND_API_KEY/RESEND_FROM/ALERT_EMAIL_TO não estão configurados — sem e-mail de alerta",
      params
    );
    return;
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        from: config.from,
        to: config.to,
        subject: `Falha ao publicar post agendado de @${params.username}`,
        text: [
          `O post agendado ${params.scheduledPostId} (workspace ${params.workspaceId}) falhou definitivamente.`,
          "",
          `Erro: ${params.errorMessage}`,
        ].join("\n"),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`[Agendados] envio de alerta falhou (${response.status}): ${body}`);
    }
  } catch (err) {
    console.error("[Agendados] envio de alerta lançou exceção:", err);
  }
}
