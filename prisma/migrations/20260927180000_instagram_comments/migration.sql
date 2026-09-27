-- CreateTable
CREATE TABLE "InstagramComment" (
    "id" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "username" TEXT,
    "commentedAt" TIMESTAMP(3) NOT NULL,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstagramComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InstagramComment_commentId_key" ON "InstagramComment"("commentId");

-- CreateIndex
CREATE INDEX "InstagramComment_instagramAccountId_commentedAt_idx" ON "InstagramComment"("instagramAccountId", "commentedAt");

-- CreateIndex
CREATE INDEX "InstagramComment_mediaId_idx" ON "InstagramComment"("mediaId");

-- AddForeignKey
ALTER TABLE "InstagramComment" ADD CONSTRAINT "InstagramComment_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
