-- Fase 4: TikTok e YouTube Shorts como destinos do Agendados, via Zernio.
--
-- A migration anterior (20260927170000_scheduled_posts) já foi aplicada em
-- produção — esta é NOVA, incremental, gerada à mão a partir de
-- `npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`
-- (offline, sem banco: não há shadow database configurado neste projeto para
-- diffar a partir do histórico de migrations real — ver
-- docs/2026-09-27-agendados-comentarios.md, seção "Fase 4", para a
-- comparação linha a linha).

-- CreateEnum
CREATE TYPE "ScheduledPostPlatform" AS ENUM ('INSTAGRAM', 'TIKTOK', 'YOUTUBE');

-- AlterTable
ALTER TABLE "ScheduledPost"
  ADD COLUMN "platform" "ScheduledPostPlatform" NOT NULL DEFAULT 'INSTAGRAM',
  ADD COLUMN "zernioAccountId" TEXT,
  ADD COLUMN "zernioPostId" TEXT,
  ADD COLUMN "platformSettings" JSONB,
  -- Rodada 5 (revisão adversarial da Fase 4, ainda não aplicada em produção —
  -- editada no lugar em vez de virar uma migration nova): achado 2
  -- (idempotency key nova a cada reivindicação, não presa a `attempts`) e
  -- achado 3 (janela de reconciliação pelo momento do claim, não por
  -- `updatedAt`, que numa linha FAILED é o momento da falha).
  ADD COLUMN "zernioIdempotencyKey" TEXT,
  ADD COLUMN "claimedAt" TIMESTAMP(3),
  ALTER COLUMN "instagramAccountId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledPost_zernioPostId_key" ON "ScheduledPost"("zernioPostId");

-- CreateIndex
CREATE INDEX "ScheduledPost_platform_zernioAccountId_idx" ON "ScheduledPost"("platform", "zernioAccountId");

-- CheckConstraint: an INSTAGRAM row always has its instagramAccountId (the
-- original two-phase container flow needs the Meta account); a TIKTOK/
-- YOUTUBE row always has its zernioAccountId instead. Enforced first in app
-- code (lib/scheduled-posts/schema.ts's createScheduledPostSchema) — this is
-- the belt-and-suspenders database-level backstop the coordinator asked for
-- ("se der, em SQL").
ALTER TABLE "ScheduledPost" ADD CONSTRAINT "ScheduledPost_instagram_requires_account"
  CHECK (platform <> 'INSTAGRAM' OR "instagramAccountId" IS NOT NULL);

ALTER TABLE "ScheduledPost" ADD CONSTRAINT "ScheduledPost_zernio_requires_account"
  CHECK (platform = 'INSTAGRAM' OR "zernioAccountId" IS NOT NULL);
