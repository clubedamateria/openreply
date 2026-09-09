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
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Importar campanhas</h1>
        <p className="text-sm text-muted mt-1">
          Cole um CSV com uma linha por campanha. Cada linha abre no construtor
          preenchida e editável, para você revisar e escolher o reel antes de
          salvar. As colunas obrigatórias são{" "}
          <code className="text-accent">keywords</code> and{" "}
          <code className="text-accent">dm_message</code>. Opcionais:{" "}
          <code className="text-accent">name</code>,{" "}
          <code className="text-accent">public_reply</code>,{" "}
          <code className="text-accent">tracked_url</code>,{" "}
          <code className="text-accent">opening_dm</code>,{" "}
          <code className="text-accent">opening_dm_button</code>. As palavras-chave
          vão em uma única célula, separadas por vírgula. Use{" "}
          <code className="text-accent">{"{link}"}</code> na mensagem para
          inserir o link rastreado.
        </p>
      </div>

      {error && (
        <div className="p-4 rounded bg-error/10 border border-error/20 text-error text-sm">
          {error}
        </div>
      )}

      {accounts.length > 1 && (
        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">
            Conta do Instagram
          </label>
          <AccountSelect
            accounts={accounts}
            value={selectedAccountId}
            onChange={setSelectedAccountId}
            includeAll={false}
            label="Conta"
          />
        </div>
      )}

      <div className="space-y-2">
        <label className="block text-sm font-medium text-foreground">CSV</label>
        <textarea
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          placeholder={SAMPLE}
          rows={10}
          className="w-full px-4 py-3 rounded bg-surface border border-border text-sm font-mono text-foreground placeholder:text-zinc-600 focus:border-accent/40 focus:outline-none resize-y"
        />
        <button
          type="button"
          onClick={() => setCsv(SAMPLE)}
          className="text-xs text-muted hover:text-foreground"
        >
          Preencher com exemplo
        </button>
      </div>

      <div className="flex items-center gap-4">
        <button
          onClick={startImport}
          className="px-5 py-2 rounded bg-accent text-sm font-medium text-white hover:bg-accent-hover"
        >
          Revisar e importar
        </button>
        <button
          onClick={() => router.push("/campaigns")}
          className="px-5 py-2 rounded text-sm text-muted hover:text-foreground border border-border"
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}
