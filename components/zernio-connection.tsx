'use client';

import { useCallback, useEffect, useState } from 'react';
import Image from 'next/image';
import { zernioLink } from '@/lib/zernio-links';

type ConnectionData = {
  configured: boolean; profileId?: string | null; webhookReady?: boolean;
  profiles: { id: string; name: string }[];
  accounts: { id: string; username: string; instagramId: string; connected?: boolean }[];
};

export function ZernioConnection({ canManage }: { canManage: boolean }) {
  const [data, setData] = useState<ConnectionData | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [profileId, setProfileId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    const response = await fetch('/api/zernio/settings', { cache: 'no-store' });
    const result = await response.json();
    if (!result.success) throw new Error(result.error);
    setData(result.data);
    setProfileId(result.data.profileId ?? '');
  }, []);
  useEffect(() => {
    if (canManage) {
      void fetch('/api/zernio/settings', { cache: 'no-store' }).then(r => r.json()).then(result => {
        if (!result.success) throw new Error(result.error);
        setData(result.data); setProfileId(result.data.profileId ?? '');
      }).catch(e => setError(e instanceof Error ? e.message : 'Não foi possível carregar a conexão.'));
    }
  }, [canManage, refresh]);

  async function act({ path = 'settings', method, body }: { path?: string; method: string; body?: unknown }) {
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/zernio/${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
      setApiKey('');
      if (result.data?.authUrl) { window.location.assign(result.data.authUrl); return; }
      if (path === 'accounts') { window.location.reload(); return; }
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível atualizar a conexão.'); }
    finally { setBusy(false); }
  }

  return (
    <section className="zernio-sponsor rounded-xl border p-5 sm:p-6" aria-labelledby="zernio-heading">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div><h2 id="zernio-heading" className="text-base font-semibold">Configuração mais fácil do Instagram</h2><p className="mt-1 text-sm">Provedor de conexão opcional</p></div>
        <a href={zernioLink({ placement: 'settings-logo' })} target="_blank" rel="noopener noreferrer" aria-label="Zernio, patrocinador do OpenReply"><Image src="/brand/zernio-primary.svg" alt="Zernio" width={106} height={32} className="h-auto" /></a>
      </div>
      <p className="mt-4 text-sm leading-6">Conecte o Instagram sem criar seu próprio app de desenvolvedor da Meta. O Zernio é um serviço pago e patrocinador do OpenReply. Suas campanhas e hospedagem continuam no OpenReply.</p>
      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-sm"><a className="underline underline-offset-4" href={zernioLink({ path: '/signup', placement: 'settings-signup' })} target="_blank" rel="noopener noreferrer">Obter uma chave de API do Zernio</a><a className="underline underline-offset-4" href={zernioLink({ path: '/pricing', placement: 'settings-pricing' })} target="_blank" rel="noopener noreferrer">Ver preços</a></p>
      {!canManage ? <p className="mt-4 text-sm">Peça ao dono ou administrador do workspace para configurar o Zernio.</p> : <>
        {error && <p role="alert" className="mt-4 rounded border border-error/30 bg-white p-3 text-sm text-error">{error}</p>}
        {!data?.configured ? <form className="mt-5 space-y-3" onSubmit={e => { e.preventDefault(); void act({ method: 'POST', body: { apiKey } }); }}>
          <label className="block text-sm font-medium" htmlFor="zernio-api-key">Chave de API do Zernio</label>
          <input id="zernio-api-key" type="password" autoComplete="off" value={apiKey} onChange={e => setApiKey(e.target.value)} required className="w-full rounded-lg border border-zernio-border bg-white px-3 py-2 text-sm" />
          <p className="text-xs leading-5">Use uma chave sem restrições, de leitura e escrita, com acesso à Caixa de entrada. O OpenReply registra um webhook para este workspace. A chave é criptografada e nunca é exibida de novo.</p>
          <button disabled={busy || !apiKey} className="zernio-action rounded-xl px-4 py-3 text-sm font-medium disabled:opacity-50">{busy ? 'Salvando…' : 'Salvar chave de API'}</button>
        </form> : <div className="mt-5 space-y-4">
          <p className="text-sm">Chave de API salva com segurança.</p>
          <form className="space-y-3" onSubmit={e => { e.preventDefault(); void act({ method: 'PUT', body: { profileId } }); }}>
            <label htmlFor="zernio-profile" className="block text-sm font-medium">Perfil do Zernio</label>
            <select id="zernio-profile" value={profileId} onChange={e => setProfileId(e.target.value)} required className="w-full rounded-lg border border-zernio-border bg-white px-3 py-2 text-sm"><option value="">Selecione um perfil</option>{data.profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            {!data.profiles.length && <p className="text-sm">Crie um perfil no Zernio e depois atualize esta página.</p>}
            <button disabled={busy || !profileId} className="zernio-action rounded-xl px-4 py-3 text-sm font-medium disabled:opacity-50">{busy ? 'Configurando…' : data.webhookReady && profileId === data.profileId ? 'Reparar conexão do webhook' : 'Salvar perfil e configurar webhook'}</button>
          </form>
          {data.webhookReady && <div className="space-y-3 border-t border-zernio-border pt-4">
            <p className="text-sm">Webhook configurado. Escolha uma conta do Instagram para o OpenReply:</p>
            {data.accounts.map(a => <div key={a.id} className="flex flex-wrap items-center justify-between gap-3 text-sm"><span>@{a.username}</span><button disabled={busy || a.connected} onClick={() => void act({ path: 'accounts', method: 'POST', body: { accountId: a.id } })} className="rounded-lg border border-zernio-border bg-white px-3 py-2 disabled:opacity-50">{a.connected ? 'Conectada' : 'Usar no OpenReply'}</button></div>)}
            <button disabled={busy} onClick={() => void act({ path: 'connect', method: 'POST' })} className="rounded-lg border border-zernio-border bg-white px-3 py-2 text-sm disabled:opacity-50">Conectar outra conta do Instagram</button>
            <p className="text-xs leading-5">Depois de conectar o Instagram, volte aqui e selecione a conta para o OpenReply. Mantenha as automações do Zernio desligadas para essas campanhas, para evitar envios duplicados.</p>
          </div>}
          <button disabled={busy} onClick={() => { if (confirm('Remover a chave do Zernio e este webhook do OpenReply? Desconecte as contas do Instagram dele no OpenReply primeiro.')) void act({ method: 'DELETE' }); }} className="text-xs underline underline-offset-4 disabled:opacity-50">Remover conexão com o Zernio</button>
        </div>}
      </>}
    </section>
  );
}
