-- CreateEnum
CREATE TYPE "ScheduledPostMediaType" AS ENUM ('REELS', 'IMAGE', 'CAROUSEL');

-- CreateEnum
CREATE TYPE "ScheduledPostStatus" AS ENUM ('SCHEDULED', 'PREPARING', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "ScheduledPostSource" AS ENUM ('PAINEL', 'LOTE');

-- CreateTable
CREATE TABLE "ScheduledPost" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "mediaType" "ScheduledPostMediaType" NOT NULL,
    "mediaUrls" TEXT[],
    "storagePaths" TEXT[],
    "coverUrl" TEXT,
    "coverPath" TEXT,
    "contentHash" TEXT[] NOT NULL DEFAULT '{}',
    "caption" TEXT NOT NULL,
    "shareToFeed" BOOLEAN NOT NULL DEFAULT true,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "status" "ScheduledPostStatus" NOT NULL DEFAULT 'SCHEDULED',
    "containerId" TEXT,
    "childContainerIds" TEXT[],
    "mediaId" TEXT,
    "permalink" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "publishedAt" TIMESTAMP(3),
    "outcomeUncertain" BOOLEAN NOT NULL DEFAULT false,
    "source" "ScheduledPostSource" NOT NULL DEFAULT 'PAINEL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledPost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledPost_mediaId_key" ON "ScheduledPost"("mediaId");

-- CreateIndex
CREATE INDEX "ScheduledPost_status_scheduledFor_idx" ON "ScheduledPost"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "ScheduledPost_workspaceId_idx" ON "ScheduledPost"("workspaceId");

-- CreateIndex
-- GIN so `contentHash && ARRAY[...]` (Prisma's `hasSome`) can use an index as
-- a coarse pre-filter for the permanent-dedup check; exact-match confirmation
-- still happens in application code (see app/api/scheduled-posts/route.ts).
CREATE INDEX "ScheduledPost_contentHash_idx" ON "ScheduledPost" USING GIN ("contentHash");

-- AddForeignKey
ALTER TABLE "ScheduledPost" ADD CONSTRAINT "ScheduledPost_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledPost" ADD CONSTRAINT "ScheduledPost_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
