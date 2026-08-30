-- Additive only: one new table, no changes to existing columns or indexes.
-- Row presence marks an assembled output as posted to social; clearing the
-- flag deletes the row. No foreign keys — assembled outputs live in S3 and
-- have no row to reference, matching the PipelineDelivery table's shape.

-- CreateTable
CREATE TABLE "PipelineOutputPost" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "clipId" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PipelineOutputPost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PipelineOutputPost_jobId_clipId_key" ON "PipelineOutputPost"("jobId", "clipId");

-- CreateIndex
CREATE INDEX "PipelineOutputPost_postedAt_idx" ON "PipelineOutputPost"("postedAt");
