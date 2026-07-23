-- AlterEnum
ALTER TYPE "FileSource" ADD VALUE 'PIPELINE';

-- CreateTable
CREATE TABLE "PipelineDelivery" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "clipId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PipelineDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PipelineDelivery_jobId_clipId_folderId_key" ON "PipelineDelivery"("jobId", "clipId", "folderId");
