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

## Mudanças pós-revisão (revisão adversarial da Fatia 1 + 2 itens da Fatia 2)

Uma revisão adversarial encontrou bloqueadores de deploy na Fatia 1 (risco real de
publicar o mesmo post 2x) e 2 bugs de memória/dado na Fatia 2. Trocou-se também o
storage: saem Supabase Storage + service role key, entra o disco da própria VM.

### Storage: Supabase → disco da VM
- **Por quê**: uma dependência a menos (sem conta/chave externa), e o disco já
  existe (a VM roda tudo num container só). `MEDIA_DIR` (default `/data/media`,
  volume Docker `media`) montado **rw** no `web` e **ro** no `caddy`; Caddy serve
  `/media/*` direto do disco (`deploy/Caddyfile`, `handle_path` antes do
  `reverse_proxy`) — é essa URL pública que a Meta busca para criar o container.
  URL pública derivada de `NEXTAUTH_URL + /media`, com override em
  `MEDIA_PUBLIC_BASE_URL`.
- **Upload novo**: `POST /api/scheduled-posts/upload` (`lib/scheduled-posts/`
  auth/paths, `lib/storage/media.ts`), autenticado por sessão OU
  `Authorization: Bearer $SCHEDULER_API_TOKEN` (`timingSafeEqual`, fecha se o
  token não estiver configurado). Corpo é o arquivo cru, **streamado** direto
  pro disco (`Readable.fromWeb` → arquivo temporário → rename atômico) — nunca
  bufferizado inteiro em memória (VM de 1 GB). Limite 200 MB, aborta no meio do
  stream se passar. Só `video/mp4` e `image/jpeg` (a Content Publishing API não
  aceita PNG pra imagem — form e CLI recusam antes de enviar). sha256 calculado
  durante o próprio stream; nome do arquivo é `<sha256 16>-<id aleatório>.(mp4|jpg)`
  (sem pasta por conta, sem nome do usuário — fecha path traversal e colisão de
  nome ao mesmo tempo, e é a base do dedup permanente abaixo).
- **Limpeza**: PUBLISHED com +24h apaga os arquivos (sem zerar `contentHash`);
  FAILED/CANCELED apaga depois de 7 dias; órfão no disco (não referenciado por
  nenhum post ativo) some depois de 48h.
- `scripts/agendar-lote.ts` usa só `PAINEL_URL` + `SCHEDULER_API_TOKEN`.

### Dupla publicação (bloqueadores; `lib/scheduled-posts/engine.ts` reescrito)
O motor original tratava qualquer erro depois de `media_publish` como "não
publicou, volta pra PREPARING" — mas uma resposta perdida (timeout, conexão
caiu) não prova que a Meta não publicou de verdade. Corrigido com:
1. `mediaId` é gravado no instante em que `media_publish` responde, **antes**
   de buscar o permalink (permalink vira melhor esforço, com retry no tick
   seguinte se falhar).
2. Container com `status_code=PUBLISHED` que a nossa linha não sabia = a
   publicação já aconteceu antes (resposta perdida). Acha o media por
   `listRecentMedia` casando a legenda; sem match único, marca PUBLICADO do
   mesmo jeito (nunca republica) com `mediaId` nulo e manda alerta por e-mail.
3. Container só é recriado em `status_code` explícito `ERROR`/`EXPIRED`. Uma
   exceção de rede/Meta ao consultar o status **não** recria nada — tenta de
   novo no próximo minuto; depois de 30 min travado assim, FAILED com alerta.
4. Erro ambíguo em `media_publish` (rede, timeout, JSON inválido, 5xx) **não**
   volta pra PREPARING — fica em PUBLISHING pro reconciliador (item 6) resolver
   pelo status do container. Só um erro 4xx explícito da Meta, com o container
   ainda FINISHED (confirmado com nova consulta), volta pra PREPARING.
5. Toda escrita de transição é `updateMany` condicional (`where: { id, status,
   containerId }`, conferindo `count === 1`) — inclusive `markFailed`,
   recriação de container e cancelamento (a rota `[id]` usava `update` puro).
6. Reconciliação: linha em PUBLISHING com `updatedAt` > 3 min olha o container
   direto. PUBLISHED → item 2. FINISHED → volta pra PREPARING (condicional).
   ERROR/EXPIRED → FAILED com alerta. Nunca recria container a partir de
   PUBLISHING.
7. Lock global no início de cada tick (`pg_try_advisory_lock`/`unlock`, sessão
   dedicada — ver `lib/scheduled-posts/advisory-lock.ts` para o porquê de não
   usar `pg_try_advisory_xact_lock` dentro de uma `$transaction` gigante: isso
   arriscaria desfazer, por rollback, a gravação de um `mediaId` de um post que
   a Meta **já publicou de verdade** minutos antes no mesmo tick). Sem o lock,
   `{ skipped: "locked" }`.
8. `AbortSignal.timeout(30_000)` em toda chamada Meta do caminho de publicação.
9. `scripts/cron.sh`: `wget --tries=1`; `sync-comments` roda em background
   (`&`) pra nunca travar o `publish-scheduled` de cada minuto.
10. `decryptToken` embrulhado por post: token corrompido falha só aquele post
    (FAILED + alerta), sem abortar o resto do tick.
11. Teto de 10 posts preparados + 10 publicados por tick.

Os 4 cenários de reprodução da dupla publicação viraram testes reais em
`__tests__/scheduled-posts-double-publish.test.ts` (resposta perdida, crash
depois do claim, falha do banco depois do `media_publish` OK, tick sobreposto)
— os 4 hoje não conseguem publicar 2x.

### Dedup permanente (bloqueador 3)
Coluna `contentHash String[]` em `ScheduledPost` (sha256 de cada arquivo, na
ordem; índice GIN), **nunca** zerada pela limpeza — mesmo depois do arquivo
sumir do disco, o hash continua bloqueando reagendar o mesmo conteúdo pra
mesma conta. `POST /api/scheduled-posts` rejeita com 409 se o conjunto de hash
bater com outro post não-CANCELED da mesma conta, a menos que venha
`force: true`. O CLI calcula o sha256 local e consulta
`GET /api/scheduled-posts?username=` (que devolve `contentHash`) antes de
subir qualquer arquivo — e **aborta o lote inteiro** se essa consulta falhar,
em vez de tratar silenciosamente como "nada agendado ainda" (bug antigo).

### Validações (bloqueador D)
- API rejeita `scheduledFor` mais de 5 min no passado (exceto "publicar agora",
  que nem manda `scheduledFor`).
- CLI aborta o lote inteiro (sem subir nada) se algum horário da grade já
  passou, e valida legenda/tipo antes de qualquer upload.
- Fuso America/Sao_Paulo calculado com `Intl.DateTimeFormat`
  (`lib/scheduled-posts/timezone.ts`), não mais um `"-03:00"` fixo — usado pelo
  formulário, pela ação de reagendar, pelo CLI e pela grade de horários. Teste
  prova que não é fixo comparando um horário de hoje com um de janeiro/2018
  (quando o Brasil ainda tinha horário de verão, offset -2h).
- CLI aceita `--horarios 9:00` (sem zero à esquerda) e datas de CSV em
  `dd/mm/aaaa` além de `aaaa-mm-dd`.
- Filho de vídeo num carrossel agora manda `media_type: "VIDEO"` explícito
  (`lib/meta/client.ts`) — sem isso a Meta rejeitava o slide.

### Fatia 2
- `app/api/instagram/comments/route.ts`: nada mais consulta sem limite —
  `count()` separado pra `totalComments` exato, leitura de agregação com
  `select: { text: true }` e `take: 20000`, comentários recentes numa query
  própria `take: 30` **sem** a conta embutida, `dmLogs` com `take`. As
  credenciais da conta (com `accessToken`) são buscadas uma vez só, pros
  poucos IDs distintos por trás dos 30 comentários recentes — nunca embutidas
  em cada linha da agregação (era o bug de memória: N linhas cada uma com um
  objeto de conta completo, token incluso).
- `lib/queue/process-webhook.ts` + `lib/comments/sync.ts`: o upsert do webhook
  não sobrescreve mais `commentedAt` num comentário já registrado (era
  atualizado a cada re-entrega/backfill); `parentId` é preenchido quando o
  payload trouxer `parent_id` (`lib/meta/webhook.ts` ganhou a extração), sem
  nunca apagar um `parentId` já gravado.

### Correções menores
- `/api/cron/publish-scheduled` fecha (`401`) se `CRON_SECRET`/`NEXTAUTH_SECRET`
  estiver vazio, comparando com `timingSafeEqual`.
- Cancelar/excluir um post agendado só funciona a partir de SCHEDULED/PREPARING,
  com `updateMany`/`deleteMany` condicional (não `update`/`delete` direto).

## Rodada 3 (segunda revisão adversarial — "sem bloqueador", mas 5 achados "corrigir logo" + 6 menores)

Reproduções em `scratchpad/ares/r2.test.ts` (cenários R1-R4) viraram testes reais
em `__tests__/scheduled-posts-double-publish.test.ts`.

### 1 — Retry/reagendar de um FAILED com resultado incerto (R3)
`ScheduledPost` ganhou `outcomeUncertain Boolean` (mesma migration
`20260927170000`, ainda não aplicada em lugar nenhum). O motor grava
`outcomeUncertain: true` só quando genuinamente não dá pra confirmar se a Meta
publicou (reconciliação de PUBLISHING que fica 30+min sem conseguir consultar
o status) — nunca no caminho "container nunca chegou a FINISHED" (esse é
seguro de recriar do zero). `app/api/scheduled-posts/[id]/route.ts` (retry e
reagendar-como-retry) chama `getContainerStatus` no container antigo antes de
zerar qualquer coisa: `PUBLISHED` → reconcilia (reusa
`reconcilePublishedContainer`, exportado do motor) e recusa o retry;
consulta falhou → `409` com `outcomeUncertain: true` pedindo confirmação
manual; qualquer outro status → confirma que não foi publicado, libera o
retry normal. `force: true` no corpo pula a checagem. A tela mostra o aviso e
troca "Tentar de novo" por "Já conferi, publicar de novo" (que manda `force`).

### 2 — Lock perdido em silêncio (R4)
`lib/scheduled-posts/advisory-lock.ts`: `client.on("error")` marca a conexão
como perdida e o handle passa a expor `isHeld()`. O motor confere `isHeld()`
antes de cada criação de container e de cada `media_publish`, abortando o
resto do tick (`LockLostError`, capturada uma vez em
`runPublishScheduledCron`) se o lock caiu. Mais importante na prática:
`markFailed`/`handleContainerFailure` passaram a casar por **status exato**
(não mais `{in:[PREPARING,PUBLISHING]}`) mais `containerId` — assim, mesmo
sem lock nenhum (R4 testa exatamente esse cenário, dois ticks rodando de
verdade em paralelo), uma chamada de `markFailed` com um snapshot velho vira
no-op em vez de sobrescrever o status que outro tick já publicou.

### 3 — Corrida no dedup (`POST /api/scheduled-posts`)
O check-then-create virou uma `prisma.$transaction` com
`pg_advisory_xact_lock(hashtext(instagramAccountId))` logo no início —
serializa criações concorrentes do MESMO conteúdo na MESMA conta (contas
diferentes nunca se bloqueiam), liberado automaticamente ao fim da
transação. `force: true` continua pulando a checagem, mas dentro do mesmo
lock. Testado com um fake `$transaction`/`$executeRaw` que simula filas por
chave, replicando o comportamento real do Postgres.

### 4 — Varredura de órfãos apagava arquivo de post ainda dentro da retenção (R2)
`cleanupOrphanFiles` passou a considerar "referenciado" o `storagePaths`/
`coverPath` de **qualquer** `ScheduledPost`, não só SCHEDULED/PREPARING/
PUBLISHING — como `cleanupPublishedFiles`/`cleanupAbandonedFiles` já zeram
esses campos assim que a própria retenção (24h/7 dias) vence, e rodam antes
no mesmo tick, o efeito final é idêntico ao pedido ("PUBLISHED <24h ou
FAILED/CANCELED <7 dias contam como referenciados") só que sem duplicar a
lógica de idade em dois lugares. Retry/reagendar agora exigem que todo
`storagePaths`/`coverPath` ainda exista em disco (`409` com "arquivo
expirou" se não). `cleanupFilesFor` passou a limpar os campos com
`updateMany` guardado pelo status exato que a própria busca encontrou (não
`update` incondicional), pra nunca zerar os arquivos de um post que foi
reagendado bem no meio da limpeza.

### 5 — Índice do `contentHash` divergia da migration
`prisma/schema.prisma` estava com `@@index([contentHash])` (BTree implícito);
a migration já usava `USING GIN` manualmente. Corrigido para
`@@index([contentHash], type: Gin)`. Conferido com
`npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`:
a única linha de índice de `contentHash` gerada bate exatamente com a da
migration (`CREATE INDEX "ScheduledPost_contentHash_idx" ON "ScheduledPost"
USING GIN ("contentHash");`).

### 6 — Reconciliação por legenda sem janela de tempo (R1)
`reconcilePublishedContainer` (motor) só aceita um candidato do
`listRecentMedia` cujo `timestamp` seja `>= updatedAt do claim - 2min`. Com
legenda preenchida, ainda exige exatamente 1 candidato dentro da janela;
legenda vazia nunca casa por legenda — só aceita um único candidato na janela
por timestamp puro. Sem candidato válido, o post ainda é marcado PUBLISHED
(recriar seria pior), mas com `mediaId: null` e alerta por e-mail.

### Menores (6/6)
- Cancelar volta a aceitar FAILED (a UI já mostrava o botão; a API dava 409
  sempre) — libera o `contentHash` pra reagendar o mesmo conteúdo.
- Upload confere os bytes mágicos do primeiro chunk (`FF D8 FF` pra JPEG,
  `ftyp` no offset 4 pra MP4) contra o `content-type` declarado; divergência
  ou arquivo curto demais pra checar = `415` e apaga o `.tmp-*`.
- Limite de upload caiu de 200MB pra 100MB (já cobre um Reels de 90s em
  1080p) depois de um upload lento perto do teto antigo bater no timeout de
  ~300s do proxy reverso antes de terminar o stream; `agendar-lote` avisa
  antes de subir qualquer arquivo acima de 100MB.
- `.tmp-*` abandonado (upload que nunca terminou) é varrido depois de 1h,
  bem antes da regra de 48h dos arquivos órfãos normais — nenhuma linha do
  banco pode referenciar um nome `.tmp-*` de qualquer forma.
- `lib/email/alert.ts` usa `AbortSignal.timeout(10_000)` no fetch da Resend,
  pra um alerta travado nunca travar o tick do cron que o disparou.
