# Agendados + Comentários + Ranking (2026-09-27)

Pedido do dono: agendar muitos posts no Instagram (Reels e carrossel) sem o Mac ligado, e ver no painel os posts, as palavras mais comentadas (as duas leituras: o que o público escreve e o desempenho das palavras-chave das campanhas) e os números.

Contexto verificado hoje:
- App Meta "OpenReply Clube", fluxo Instagram API with Instagram Login (`graph.instagram.com`). `instagram_business_content_publish` já adicionada ao caso de uso (acesso padrão, conta própria, sem App Review). Cota real de publicação: 100/24h (`content_publishing_limit`).
- Teste manual ok: container REELS com `video_url` público do Supabase processou em ~40 s (IN_PROGRESS → FINISHED).
- Mídia: bucket público `social` no Supabase `nnoasoadhznnsrlmrsuj` (supabase-cdm), limite 50 MB/arquivo, mime mp4/jpeg/png. Caminho `instagram/<username>/<arquivo>`.
- Alerta por e-mail: Resend conta resend-clube (API, não SMTP; `EMAIL_FROM` do painel ainda é placeholder).
- Scheduler: `scripts/cron.sh` (container `cron`) chama `/api/cron/<rota>` com `Authorization: Bearer $CRON_SECRET`. Migrations rodam sozinhas no start do `web` (`prisma migrate deploy`).
- VM e2-micro (1 GB). Nada de processamento pesado no servidor; upload vai direto do browser para o Supabase por URL assinada.

## Fatia 1: Agendados

Modelo `ScheduledPost` (Prisma, migration SQL escrita à mão em `prisma/migrations/20260927xxxxxx_scheduled_posts/`):
- `id`, `workspaceId`, `instagramAccountId`, `mediaType` (REELS | IMAGE | CAROUSEL), `mediaUrls String[]` (ordem = ordem do carrossel), `storagePaths String[]`, `coverUrl?`, `caption` (≤ 2.200 chars, ≤ 30 hashtags), `shareToFeed` (default true), `scheduledFor` (UTC), `status` (SCHEDULED | PREPARING | PUBLISHING | PUBLISHED | FAILED | CANCELED), `containerId?`, `childContainerIds String[]`, `mediaId?` (único quando presente), `permalink?`, `attempts`, `errorMessage?`, `publishedAt?`, `source` (PAINEL | LOTE), timestamps. Índices por `status, scheduledFor` e `workspaceId`.

Publicação em 2 fases, cron `/api/cron/publish-scheduled` a cada 1 min:
1. Preparar: posts SCHEDULED com `scheduledFor <= agora + 15 min` → cria container(s) (REELS com `video_url`, `share_to_feed`, `cover_url` opcional; CAROUSEL cria filhos `is_carousel_item=true` e depois o pai `media_type=CAROUSEL&children=`) → PREPARING.
2. Publicar: PREPARING com `scheduledFor <= agora` e container `status_code=FINISHED` → `media_publish` → PUBLISHED com `mediaId`, `permalink`, `publishedAt`. `ERROR`/`EXPIRED` → recria container até 3 tentativas, depois FAILED com a mensagem da Meta.
- Transição de status com UPDATE condicional (`where: { id, status: <anterior> }`) para nunca publicar 2x mesmo com cron sobreposto. `mediaId` preenchido = nunca chamar `media_publish` de novo.
- Antes de publicar, respeitar `content_publishing_limit` (se `quota_usage >= quota_total`, deixa para o próximo minuto e registra no log).
- Só provider META publica; conta ZERNIO → FAILED com mensagem clara.
- Depois de PUBLISHED há 24 h, apagar os arquivos do bucket (`storagePaths`) para não estourar o Supabase grátis.
- FAILED dispara e-mail na hora (Resend, `RESEND_API_KEY`, `ALERT_EMAIL_TO`). Sem env de e-mail: só log, sem quebrar.

API e UI:
- `app/(dashboard)/agendados/page.tsx` + item no sidebar ("Agendados"). Lista por dia (fuso America/Sao_Paulo), status com badge, miniatura (vídeo com `preload=metadata`), link do post publicado, erro legível. Ações: cancelar, reagendar, tentar de novo (FAILED → SCHEDULED), publicar agora.
- "Novo post": conta, tipo, arquivo(s) (1 vídeo, ou 2 a 10 imagens), legenda com contador, data e hora locais, "mostrar no feed". Upload direto do browser pelo `createSignedUploadUrl` do Supabase Storage (rota do servidor gera a URL; env `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` só no servidor).
- Rota para lote `POST /api/scheduled-posts` com `Authorization: Bearer $SCHEDULER_API_TOKEN` (env novo), validação zod.
- OAuth: incluir `instagram_business_content_publish` no escopo de `lib/meta/oauth.ts` (o dono reconecta a conta uma vez).
- CLI `scripts/agendar-lote.ts`: pasta com `*.mp4`/`*.jpg` + `<nome>-legenda.txt` (padrão dos renders do reels-quiz-ingles) ou CSV (`arquivo,data,hora,conta,tipo`), ou slots automáticos (`--inicio AAAA-MM-DD --horarios 12:00,19:00 --por-dia N`). Sobe para o bucket e chama a rota. `--dry-run` mostra a grade sem subir nada. Não reagenda arquivo já agendado (checa por `storagePaths`).

## Fatia 2: Comentários + Ranking

Modelo `InstagramComment`: `commentId` único, `instagramAccountId`, `mediaId`, `text`, `username?`, `commentedAt`, `parentId?` (resposta), timestamps. Índices por conta+data e mediaId.
- Alimentado por: (a) o handler de webhook de comentários que já existe (gravar todo comentário recebido, inclusive os que não batem campanha, sem mudar a lógica de DM); (b) cron diário `/api/cron/sync-comments` que busca comentários dos últimos 30 posts (backfill e correção).
- Ignorar comentários da própria conta (respostas públicas da automação) na contagem.

`app/(dashboard)/comentarios/page.tsx` + item no sidebar ("Comentários"). Período 7/30/90 dias.
1. Palavras e expressões mais escritas pelo público: tokenização pt-br com minúsculas, sem acento para agrupar, stopwords pt-br, emojis contados à parte, bigramas ("eu quero"). Barras horizontais com contagem.
2. Palavras-chave das campanhas: por campanha e palavra (`DmLog.matchedKeyword`): comentários que bateram, DMs enviadas, cliques (`LinkClick` da campanha), taxa DM → clique.
3. Comentários recentes com link para o post.

Ranking na Visão geral: tabela "Melhores posts" ordenável por alcance, salvos, compartilhamentos e comentários, usando os insights que a página já carrega.

## Critérios de pronto
- `npm run typecheck`, `npm run lint` e `npm test` verdes; testes novos para a máquina de estados da publicação (sem chamadas reais: mock do fetch), tokenização/stopwords e agregação de palavras-chave.
- Nenhum segredo commitado. Envs novos documentados em `.env.example` e `docs/setup.md`.
- Deploy: push na branch `deploy` → imagem no GHCR → `git pull && docker compose ... pull && up -d` na VM.
