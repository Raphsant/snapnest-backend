-- CreateEnum
CREATE TYPE "PipelineSourceType" AS ENUM ('FILE', 'YOUTUBE');

-- AlterTable
-- YouTube-sourced jobs have no MediaFile and no agency, so sourceFileId and
-- agencyId become optional. sourceUrl/sourceS3Key hold the YouTube URL and the
-- key the worker writes after download. Existing rows default to FILE.
ALTER TABLE "PipelineJob"
  ADD COLUMN "sourceType" "PipelineSourceType" NOT NULL DEFAULT 'FILE',
  ADD COLUMN "sourceUrl" TEXT,
  ADD COLUMN "sourceS3Key" TEXT,
  ALTER COLUMN "sourceFileId" DROP NOT NULL,
  ALTER COLUMN "agencyId" DROP NOT NULL;

-- Rebuild the "one active job per source file" partial unique index so it only
-- constrains file-sourced jobs. YouTube jobs carry a NULL sourceFileId; the
-- explicit IS NOT NULL predicate keeps them out of the constraint entirely.
DROP INDEX "PipelineJob_one_active_per_file";
CREATE UNIQUE INDEX "PipelineJob_one_active_per_file"
  ON "PipelineJob"("sourceFileId")
  WHERE "sourceFileId" IS NOT NULL AND "status" NOT IN ('COMPLETED', 'FAILED');
