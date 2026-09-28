import { getResendAlertConfig } from "@/lib/env";

/**
 * Fire-and-forget alert email via the Resend HTTP API.
 *
 * Deliberately not the existing `nodemailer` dependency: that ships a SMTP
 * transport, and this project's SMTP (`EMAIL_SERVER`) is not configured — see
 * docs/2026-09-27-agendados-comentarios.md. Resend's API needs only
 * `RESEND_API_KEY`, which self-hosters already set for magic-link login.
 *
 * Never throws: a failed alert must not fail the cron run it is reporting on.
 * Without RESEND_FROM/ALERT_EMAIL_TO configured, it just logs.
 */
async function sendAlertEmail(subject: string, text: string, logContext: unknown): Promise<void> {
  const config = getResendAlertConfig();
  if (!config) {
    console.warn(
      "[Agendados] alerta sem RESEND_API_KEY/RESEND_FROM/ALERT_EMAIL_TO configurados — sem e-mail",
      logContext
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
        subject,
        text,
      }),
      // Rodada 3, achado 11: a hung Resend request must not hang the cron
      // tick that triggered this alert — this is fire-and-forget by design.
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`[Agendados] envio de alerta falhou (${response.status}): ${body}`);
    }
  } catch (err) {
    console.error("[Agendados] envio de alerta lançou exceção:", err);
  }
}

export async function sendPublishFailureAlert(params: {
  workspaceId: string;
  scheduledPostId: string;
  username: string;
  errorMessage: string;
}): Promise<void> {
  await sendAlertEmail(
    `Falha ao publicar post agendado de @${params.username}`,
    [
      `O post agendado ${params.scheduledPostId} (workspace ${params.workspaceId}) falhou definitivamente.`,
      "",
      `Erro: ${params.errorMessage}`,
    ].join("\n"),
    params
  );
}

/**
 * The container ended PUBLISHED but the engine could not match it back to a
 * media id via `listRecentMedia` (bloqueador 2) — the post is marked
 * PUBLISHED with `mediaId: null` rather than left stuck, but this needs a
 * human to look at the account and fill the permalink in by hand.
 */
export async function sendPublishWarningAlert(params: {
  workspaceId: string;
  scheduledPostId: string;
  username: string;
  message: string;
}): Promise<void> {
  await sendAlertEmail(
    `Post agendado de @${params.username} publicado sem confirmação de mediaId`,
    [
      `O post agendado ${params.scheduledPostId} (workspace ${params.workspaceId}) foi marcado como PUBLICADO`,
      "porque o container do Instagram voltou PUBLISHED, mas não foi possível achar o media",
      "correspondente em listRecentMedia (para casar o permalink).",
      "",
      `Detalhe: ${params.message}`,
      "",
      "Confira manualmente no perfil do Instagram e, se necessário, preencha o link à mão.",
    ].join("\n"),
    params
  );
}
