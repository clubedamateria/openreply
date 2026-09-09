"use client";

/**
 * Import Campaigns Page
 *
 * Paste a CSV of everything except the post. Each row is queued and opened in
 * the campaign builder prefilled and editable, one at a time, so you review
 * each campaign and pick its reel before saving.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, FileUp, Sparkles, AlertCircle } from "lucide-react";
import AccountSelect, { type AccountOption } from "@/components/account-select";
import { parseCsv } from "@/lib/utils/csv";
import { IMPORT_QUEUE_KEY, IMPORT_ACCOUNT_KEY } from "@/lib/import-queue";

const SAMPLE = `keywords,dm_message,public_reply,tracked_url,opening_dm,opening_dm_button
"yc","here it is: {link}","sent. check dms","https://events.ycombinator.com/startup-school-2026","hey! click below for the referral","send link"
"LINK,SHOP","grab it here: {link}","dmed u",,,`;

export default function ImportCampaignsPage() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [csv, setCsv] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/dashboard/stats")
      .then((res) => res.json())
      .then((payload) => {
        if (payload.success) {
          const next = payload.data.instagramAccounts ?? [];
          setAccounts(next);
          setSelectedAccountId(next[0]?.id ?? "");
        }
      })
      .catch(() => setAccounts([]));
  }, []);

  function startImport() {
    setError(null);
    const parsed = parseCsv(csv);
    if (parsed.length === 0) {
      setError("Cole um CSV com uma linha de cabeçalho e pelo menos uma campanha.");
      return;
    }

    const rows = [];
    for (let i = 0; i < parsed.length; i++) {
      const r = parsed[i];
      const keywords = (r.keywords ?? "")
        .split(/[,;]/)
        .map((k) => k.trim())
        .filter(Boolean)
        .slice(0, 10);
      const dmMessage = (r.dm_message ?? r.message ?? "").trim();
      if (keywords.length === 0 || !dmMessage) {
        setError(`A linha ${i + 1} está sem palavras-chave ou sem mensagem.`);
        return;
      }
      rows.push({
        name: (r.name ?? "").trim(),
        keywords,
        dmMessage,
        publicReply: (r.public_reply ?? "").trim(),
        trackedUrl: (r.tracked_url ?? "").trim(),
        openingDmMessage: (r.opening_dm ?? "").trim(),
        openingDmButtonLabel: (r.opening_dm_button ?? "").trim(),
      });
    }

    try {
      window.localStorage.setItem(IMPORT_QUEUE_KEY, JSON.stringify(rows));
      if (selectedAccountId) {
        window.localStorage.setItem(IMPORT_ACCOUNT_KEY, selectedAccountId);
      }
    } catch {
      setError("Não foi possível preparar a importação neste navegador.");
      return;
    }
    router.push("/campaigns/new");
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-extrabold text-brand">Importar campanhas</h1>
        <p className="mt-1 text-sm text-muted">
          Cole um CSV com uma linha por campanha. Cada linha abre no construtor
          preenchida e editável, para você revisar e escolher o reel antes de
          salvar. As colunas obrigatórias são{" "}
          <code className="text-brand">keywords</code> e{" "}
          <code className="rounded-md bg-brand-soft px-1 font-mono text-xs text-brand">dm_message</code>. Opcionais:{" "}
          <code className="rounded-md bg-brand-soft px-1 font-mono text-xs text-brand">name</code>,{" "}
          <code className="rounded-md bg-brand-soft px-1 font-mono text-xs text-brand">public_reply</code>,{" "}
          <code className="rounded-md bg-brand-soft px-1 font-mono text-xs text-brand">tracked_url</code>,{" "}
          <code className="rounded-md bg-brand-soft px-1 font-mono text-xs text-brand">opening_dm</code>,{" "}
          <code className="rounded-md bg-brand-soft px-1 font-mono text-xs text-brand">opening_dm_button</code>. As palavras-chave
          vão em uma única célula, separadas por vírgula. Use{" "}
          <code className="rounded-md bg-brand-soft px-1 font-mono text-xs text-brand">{"{link}"}</code> na mensagem para
          inserir o link rastreado.
        </p>
      </div>

      <div className="card space-y-5 p-5 sm:p-6">
        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-[10px] bg-error-soft px-4 py-3 text-sm font-bold text-error"
          >
            <AlertCircle size={18} aria-hidden="true" className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {accounts.length > 1 && (
          <div>
            <AccountSelect
              accounts={accounts}
              value={selectedAccountId}
              onChange={setSelectedAccountId}
              includeAll={false}
              label="Conta do Instagram"
            />
            <p className="helper">As campanhas importadas ficam nesta conta.</p>
          </div>
        )}

        <div>
          <label htmlFor="import-csv" className="label">
            CSV
          </label>
          <textarea
            id="import-csv"
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={SAMPLE}
            rows={10}
            className="field resize-y font-mono text-xs"
          />
          <p className="helper">
            Uma linha por campanha. A primeira linha é o cabeçalho.
          </p>
          <button
            type="button"
            onClick={() => setCsv(SAMPLE)}
            className="btn btn-sm btn-ghost mt-2 -ml-2"
          >
            <Sparkles size={16} aria-hidden="true" />
            Preencher com exemplo
          </button>
        </div>

        <div className="flex flex-col-reverse gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-end">
          <button
            type="button"
            onClick={() => router.push("/campaigns")}
            className="btn btn-secondary"
          >
            <ArrowLeft size={18} aria-hidden="true" />
            Cancelar
          </button>
          <button type="button" onClick={startImport} className="btn btn-primary">
            <FileUp size={18} aria-hidden="true" />
            Revisar e importar
          </button>
        </div>
      </div>
    </div>
  );
}
