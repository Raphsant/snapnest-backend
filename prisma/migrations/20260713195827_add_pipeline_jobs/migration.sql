-- CreateEnum
CREATE TYPE "PipelineJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'AWAITING_MANIFEST_APPROVAL', 'APPROVED', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "PipelineJob" (
    "id" TEXT NOT NULL,
    "sourceFileId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "status" "PipelineJobStatus" NOT NULL DEFAULT 'QUEUED',
    "currentStage" TEXT,
    "error" TEXT,
    "manifest" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PipelineJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PipelineJob_sourceFileId_idx" ON "PipelineJob"("sourceFileId");

-- CreateIndex
CREATE INDEX "PipelineJob_agencyId_idx" ON "PipelineJob"("agencyId");

-- CreateIndex
CREATE INDEX "PipelineJob_status_idx" ON "PipelineJob"("status");

-- CreateIndex
CREATE INDEX "PipelineJob_createdAt_idx" ON "PipelineJob"("createdAt" DESC);

-- AddForeignKey
ALTER TABLE "PipelineJob" ADD CONSTRAINT "PipelineJob_sourceFileId_fkey" FOREIGN KEY ("sourceFileId") REFERENCES "MediaFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineJob" ADD CONSTRAINT "PipelineJob_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineJob" ADD CONSTRAINT "PipelineJob_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One active (non-terminal) job per source file
CREATE UNIQUE INDEX "PipelineJob_one_active_per_file"
  ON "PipelineJob"("sourceFileId")
  WHERE "status" NOT IN ('COMPLETED', 'FAILED');
