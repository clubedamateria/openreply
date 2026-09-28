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

## Fase 4: TikTok e YouTube Shorts via Zernio (2026-09-28)

Pedido do coordenador: acrescentar TikTok e YouTube Shorts como destinos do
Agendados, publicando pelo [Zernio](https://zernio.com) (`https://zernio.com/api/v1`,
`Authorization: Bearer $ZERNIO_API_KEY`) — o mesmo repo, a mesma branch `deploy`, a
Rodada 3 já em produção (`1a393b7`). Explicitamente **não** é o `ZernioConnection` do
banco nem o fluxo de Configurações (esse é o webhook de inbox do Instagram, outro caso
de uso) — só reaproveitado o helper HTTP de baixo nível (`zernioRequest`) de
`lib/zernio/client.ts`.

### O que a API do Zernio confirmou

- `GET /accounts` → `[{_id, platform: "tiktok"|"youtube", username, displayName,
  profileId, isActive}]`. Conta TikTok do Clube `6aba6d01acc350b0ac4a845c`, YouTube
  `6aba6d8c3973c2c3f0277733`.
- `POST /posts` **verificado de verdade contra o TikTok** (publicou em ~18s):
  ```json
  {"content":"...","mediaItems":[{"type":"video","url":"<url pública>"}],
   "platforms":[{"platform":"tiktok","accountId":"..."}],
   "tiktokSettings":{"privacy_level":"PUBLIC_TO_EVERYONE","allow_comment":true,
     "allow_duet":true,"allow_stitch":true,"content_preview_confirmed":true,
     "express_consent_given":true},
   "publishNow":true}
  ```
  Resposta: `{"post":{"_id","status":"published","platforms":[{"status":"published",
  "platformPostId":"...","platformPostUrl":null,"errorMessage":null,"publishedAt"}]}}`
  — `platformPostUrl` chega `null` na resposta do `POST`; `GET /posts/{id}` é quem
  eventualmente traz a URL final.
- **YouTube — o que a doc (`docs.zernio.com/platforms/youtube`) diz, nunca testado
  contra a API de verdade**: o corpo do `POST /posts` para YouTube usa
  `platforms[0].platformSpecificData` (não um `youtubeSettings` de nível raiz como o
  TikTok) com os campos `title` (obrigatório), `visibility`
  (`"public"|"unlisted"|"private"`) e `madeForKids` (booleano, sem valor implícito —
  é o campo que satisfaz a obrigação legal do COPPA do YouTube). Isso ficou
  documentado como não-verificado em `lib/zernio/client.ts` — a primeira publicação
  real no YouTube deve confirmar o shape antes de confiar cegamente nele.
- **Idempotência (`docs.zernio.com/guides/idempotency`)**: o header
  `Idempotency-Key` é escopado por credencial (API key) + endpoint, com janela de
  24h — uma repetição da MESMA chave dentro da janela devolve a resposta original em
  vez de criar um post novo; a checagem é só pela chave, não pelo corpo. Usado aqui
  como `sp-${scheduledPostId}-${attempts}`: estável entre retentativas ambíguas da
  MESMA tentativa (uma resposta perdida por rede não gera um post duplicado se o
  processo tentar de novo), mas muda numa tentativa genuinamente nova (depois que um
  humano confirma manualmente que a anterior falhou — o mesmo gate de
  `checkRetrySafety` da Fase 3).
- TikTok: conta Business (a única que o Zernio conecta) só aceita vídeo público de
  verdade — `PUBLIC_TO_EVERYONE`, os outros três níveis de privacidade existem na API
  mas o painel avisa que só funcionam numa conta Creator; limite de 15 vídeos/dia;
  `content_preview_confirmed`/`express_consent_given` têm que vir de uma confirmação
  humana explícita na UI, nunca de um default.
- `GET /posts` (listagem, usada só na reconciliação de resposta perdida) **não tem a
  forma confirmada** pela doc — só que "existe algum filtro". Tratado a fricho: toda
  falha dela (404, formato inesperado, erro de rede) vira "não deu pra reconciliar
  neste tick", nunca "o post não existe".

### Modelo e migration

`ScheduledPost` ganhou: `platform` (enum `INSTAGRAM|TIKTOK|YOUTUBE`, default
`INSTAGRAM`), `instagramAccountId` virou opcional (`CHECK` garante que só é
obrigatório quando `platform = 'INSTAGRAM'`), `zernioAccountId?` (`CHECK` garante que
é obrigatório quando `platform <> 'INSTAGRAM'`), `zernioPostId?` (único quando
presente — o equivalente ao `containerId`/`mediaId` do Instagram como identificador
de chamada única), `platformSettings Json?` (o payload de TikTok/YouTube, validado
pelos MESMOS schemas zod na escrita e na leitura), `permalink` passou a servir tanto
o link do Instagram quanto o `platformPostUrl` do TikTok/YouTube. Migration nova em
`prisma/migrations/20260928120000_zernio_platforms/` (a Rodada 3 já está aplicada em
produção — nenhuma migration antiga foi tocada). Conferida como nas fases
anteriores: `npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma
--script` (sem depender de um banco local — o Postgres desta máquina é de outro
projeto, `gupe`/`gupe_test`, deliberadamente não usado) e o `CREATE TABLE
"ScheduledPost"`/índices novos gerados batem, coluna a coluna, com o SQL escrito à
mão — o mesmo método usado para o índice GIN da Fase 3 (achado 5 acima).

### Motor: publicar e reconciliar (Fase 2b/3b em `lib/scheduled-posts/engine.ts`)

Zernio não tem um "container" pra preparar com antecedência como o Instagram — um
único `POST /posts` (com `publishNow: true`) cria E, geralmente, termina a
publicação (TikTok levou ~18s no teste real), então um post SCHEDULED devido vai
direto pra PUBLISHING, sem etapa PREPARING. O mesmo rigor de publicação dupla da
Fase 3 foi replicado 1:1, trocando `containerId` por `zernioPostId` como o
identificador de chamada única: `updateMany` condicional por status exato pra
reivindicar SCHEDULED→PUBLISHING; `zernioPostId` gravado IMEDIATAMENTE após a
resposta do `POST /posts`, antes até de saber se o TikTok/YouTube já terminou —
nenhum tick seguinte pode chamar `POST /posts` de novo pra essa linha; uma resposta
ambígua (erro de rede, timeout, JSON inválido, 5xx) nunca é repetida — a linha fica
em PUBLISHING sem `zernioPostId`, resolvida depois por uma busca em `GET /posts`
(listagem) por conteúdo + URL da mídia + a mesma janela de tempo do momento do claim
que a reconciliação do Instagram já usa; um 4xx explícito no `POST /posts` é FALHA
certa, sem retentativa. Uma vez com `zernioPostId` conhecido, cada tick seguinte faz
`GET /posts/{id}` até o status da própria plataforma virar `published` (grava
`platformPostUrl`) ou `failed`; sem resolver depois de 30+ minutos (mesmo limiar do
`STUCK_POLLING_THRESHOLD_MS` da Fase 3), escala pra FAILED com
`outcomeUncertain: true` — o mesmo campo que trava um retry/reagendamento às cegas.
`checkRetrySafety` em `app/api/scheduled-posts/[id]/route.ts` ganhou o espelho
`checkZernioRetrySafety`, reusando `applyZernioPlatformResult`/
`reconcileZernioByList` com `fromStatus: "FAILED"` — mesma lógica de "confere antes
de deixar recriar" que o Instagram já tinha. Um retry/reagendamento zera
`zernioPostId` no mesmo `PATCH` guardado — sem isso, o próximo `publishZernioReadyPosts`
não conseguiria gravar o id novo (o guard é justamente `zernioPostId: null`) e
recriaria um post real na Zernio sem o banco nunca aprender o id dele.

### Arquivos compartilhados entre destinos

O mesmo arquivo enviado pode agora ser nomeado por 2-3 `ScheduledPost` (um por
destino, do mesmo lote/upload na UI ou no CLI). A limpeza de disco (`cleanupFilesFor`)
passou a consultar, antes de apagar, se ALGUMA outra linha (qualquer status,
qualquer plataforma) ainda referencia o mesmo nome de arquivo — só remove do disco
os nomes que sobram depois disso; o ponteiro (`storagePaths`/`coverPath`) da linha
sendo limpa é sempre zerado, como antes. Cenário de teste do pedido (replicado em
`__tests__/scheduled-posts-zernio-engine.test.ts`): um post do Instagram publicado há
2 dias (já fora da própria retenção de 24h) e um post do TikTok do MESMO arquivo
agendado pra amanhã — o arquivo sobrevive porque o TikTok ainda o referencia.

### UI, API e CLI

- `POST /api/scheduled-posts`: `platform` (default INSTAGRAM); pra TIKTOK/YOUTUBE, o
  `zernioAccountId` é resolvido no servidor a partir do env
  (`getZernioAccountIdForPlatform`), nunca do corpo da requisição — um único par
  fixo de contas por instância. O dedup por hash de conteúdo (e o lock que o
  serializa) passou a ser escopado por `(platform, conta)`: o mesmo arquivo pode
  legitimamente virar um post do Instagram E um do TikTok sem colidir.
  `instagramAccountId`/`username` continuam obrigatórios em TODA plataforma — é a
  "conta de contexto" que resolve o `workspaceId` mesmo quando quem publica de
  verdade é a conta Zernio.
- `GET /api/scheduled-posts/destinations`: expõe só `{tiktok: boolean, youtube:
  boolean}` (se os envs existem) — o painel usa isso pra desabilitar os checkboxes
  sem nunca vazar os IDs de conta.
- "Novo post" (`components/scheduled-post-form.tsx`): checkboxes de destino, uma
  linha por destino marcado no mesmo lote (mesmos arquivos/horário); ao marcar
  TikTok/YouTube, o tipo de mídia trava em REELS (vídeo). Bloco TikTok: select de
  privacidade SEM valor padrão (com aviso de que a conta Business só aceita
  "Público"), toggles de comentário/dueto/costura, um checkbox de consentimento
  único alimentando os dois campos booleanos do TikTok. Bloco YouTube: título
  obrigatório (≤100, default = 1ª linha da legenda), select de visibilidade, "Feito
  para crianças?" obrigatório sem padrão. Upload acontece uma vez só; um destino que
  falhar não desfaz os que já agendaram — a tela mostra sucesso parcial e o que
  falhou, sem navegar embora.
- `/agendados`: ícone/rótulo por plataforma (lucide-react desta versão não tem ícones
  de marca — `Camera` pro Instagram, `Music2` pro TikTok, `SquarePlay` pro YouTube),
  filtro por plataforma, `@username` só quando a linha tem `instagramAccount` (agora
  `null` numa linha TikTok/YouTube).
- `scripts/agendar-lote.ts`: `--destinos instagram,tiktok,youtube` (default
  `instagram`) publica o MESMO upload em um `POST /api/scheduled-posts` por destino.
  TikTok exige `--tiktok-privacidade` (sem default) e `--tiktok-consentimento` (flag
  — a ausência aborta o lote inteiro antes de subir qualquer arquivo, explicando por
  quê); `--tiktok-sem-dueto`/`--tiktok-sem-costura` são opt-outs opcionais. YouTube
  exige `--youtube-infantil sim|nao` (sem default); título vem de um
  `<nome>-titulo.txt` irmão do arquivo, senão a 1ª linha da legenda cortada em 100
  caracteres; `--youtube-visibilidade` default `public`. O dedup por hash pulado
  passou a ser por (conta, destino) — um arquivo já agendado no Instagram ainda é
  agendado no TikTok/YouTube se ainda não estiver lá.

### Testes novos

`__tests__/scheduled-posts-zernio-engine.test.ts` (publicação feliz TikTok/YouTube,
resposta do `POST` perdida nunca repetida, reconciliação por `GET /posts/{id}` e por
listagem com janela de tempo, 4xx imediato, escalonamento por 30+min, limpeza de
arquivo compartilhado entre plataformas), `__tests__/scheduled-posts-schema.test.ts`
(consentimento do TikTok sem default, privacidade fora do enum, `madeForKids` sem
default, título do YouTube ≤100), `__tests__/scheduled-posts-create-dedup.test.ts`
(um post do TikTok não colide com um do Instagram do mesmo conteúdo),
`__tests__/agendar-lote.test.ts` (parsing de `--destinos`, validação agregada de
`--tiktok-*`/`--youtube-*`, grade do `--dry-run` mostrando os destinos, e uma
integração real de `main()` provando que só o destino faltante é agendado quando o
outro já existe). `scripts/agendar-lote.ts` ganhou um guarda
`import.meta.url === file://process.argv[1]` pra só rodar `main()` quando chamado
direto — sem isso, importar o módulo num teste dispararia o CLI de verdade.

## Retomada (pausa em 2026-09-28)

**Estado:** a produção está no commit 1a393b7 (Instagram: Agendados + Comentários). A Fase 4 (TikTok/YouTube via Zernio, commits f92f60e..e859b82) está SÓ LOCAL, sem push. A migration `20260928120000_zernio_platforms` não foi aplicada em lugar nenhum, então ainda pode ser editada no lugar.

**Feito por último:** a revisão adversarial da Fase 4 deu "pode subir, sem bloqueador", com 5 itens "corrigir logo" e 6 menores. A rodada 5 de correção rodou em duas passagens (pausa em 2026-09-28) e terminou com todos os 11 itens fechados.

**Rodada 5 — concluída (commits `4a4b115`, `26ec00a`, `d3bb687`, `0bd9c3c`, `39be9e6`):**
`ZernioApiError.httpStatus` real (com teste usando a classe de verdade, não mais o `MetaApiError` falso); chave de idempotência nova por claim (`zernioIdempotencyKey` + `claimedAt`, `randomUUID()` a cada tentativa, zerada no retry/reagendar); `metadata {scheduledPostId, claimKey}` no POST do Zernio, casamento por ela primeiro na reconciliação (`fromDate = claimedAt - 5min`), sem mais `?? platforms[0]`; `ZERNIO_CREATE_POST_TIMEOUT_MS` (240s) ligado no `createZernioPost`, wget do `publish-scheduled` a 600s no `cron.sh`, no máx. 3 posts Zernio por tick; TikTok com interações desmarcadas por padrão, schema sem `.default(true)`, consulta ao creator-info do Zernio na UI; CLI só aceita `--tiktok-consentimento` sem valor ou `sim`, e exige `--tiktok-comentarios|dueto|costura sim|nao`; backfill de permalink do TikTok/YouTube (`getZernioPost`, até 5/tick); sem `ZERNIO_API_KEY`, posts presos em PUBLISHING por 30+ min viram FAILED com alerta; `?platform=` inválido responde 400; guarda do `main()` do CLI trocado por `realpathSync`. Migration `20260928120000_zernio_platforms` editada no lugar (ainda só local) com as duas colunas novas — verificada por `prisma migrate diff --from-empty` (bate coluna a coluna) e pela aplicação completa das 24 migrations num Postgres descartável (sem erro). Typecheck, lint e os 451 testes (`npx vitest run`) verdes.

Depois: `git push origin deploy` → o dono roda `bash .tmp/publicar-fase4.sh` (backup, 3 chaves ZERNIO_* copiadas do vault para a VM, pull, teste da migration numa cópia, up, conferência). Esse arquivo está fora do git.

**Esperando o dono:** teste do "Estou..." no YouTube (público, privado ou não testar) e o ritmo dos 30 Reels do quiz (IG + TikTok + YT, sem a lista-01; mostrar o `--dry-run` antes).

## Fatia 2, reforma completa (achados do dono em produção, 2026-09-28)

O dono achou a tela ruim (cards de 1-3 comentários virando ruído, card de
emoji vazio) e a coleta furada (30 posts/dia não cobre quem publica 30+ posts
num dia; anúncio/dark-post nunca aparece em `/me/media`). Branch
`fix/comentarios`.

- **`app/api/cron/sync-comments/route.ts`**: trocou "últimos 30 posts" por
  paginar a mídia mais nova primeiro até passar de 90 dias ou 500 posts
  (`getAllUserMedia`'s novo `until`), só varrendo posts com
  `comments_count > 0` ou o campo ausente (Zernio nunca manda esse campo —
  `selectMediaWithComments`, em `lib/comments/sync.ts`, pura e testada).
  Anúncio/dark-post: os `mediaId` já gravados em `InstagramComment` (90 dias)
  que a listagem não trouxe voltam a ser varridos também, teto 100
  (`selectMissingMediaIds`, idem). Orçamento de tempo de 50s com
  `partial: true` no JSON quando estoura, em vez de depender só do
  `maxDuration` da rota.
- **`app/api/instagram/comments/route.ts`**: resposta reformulada —
  `summary` (totalComments/uniquePeople/questions/postsWithComments),
  `comments` (200 mais recentes, com `isQuestion`), `posts` (top 20 por
  contagem, com permalink/legenda/tipo AD|REELS|FEED|STORY/thumbnail via
  Graph `/{media-id}`, cache de 1h, teto de 30 mediaId por request — nunca
  mais o `getPermalinkMap` limitado aos últimos 30 posts, que não achava
  anúncio nem post antigo). `wordStats` com `minCount: 2`.
- **`lib/comments/questions.ts`** (novo): `isQuestion(text)` — `?` literal OU
  frase que começa com interrogativo depois de tirar saudação
  ("Boa tarde, gostaria de saber..." → true).
- **`lib/comments/stopwords.ts`**: saudações/muletas (oi, boa, tarde,
  gostaria, saber, obrigado, gente, kkk, rs...).
- **`lib/comments/word-stats.ts`**: `minCount` opcional; letra repetida 3+
  colapsa numa só ("oiii"→"oi", "kkkk"→"k") e token de 1 letra é descartado.
- **`app/(dashboard)/comentarios/page.tsx`**: refeita — 4 números, "Perguntas
  do público", "Posts com mais comentários" / "Do que o público fala" lado a
  lado, "Todos os comentários" com filtro Todos/Só perguntas e paginação de
  50, campanhas só se houver (senão linha discreta). Sem cards de 1-3
  comentários nem card de emoji vazio.
- `npm run typecheck`, `npm run lint` e `npm test` verdes (406 testes, 37
  novos). `npx prisma generate` precisa rodar neste worktree antes (client
  vai para `app/generated/prisma`, não commitado).
