-- AlterTable
ALTER TABLE "IntakeAnswer" ADD COLUMN     "pipelineJobId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "IntakeAnswer_pipelineJobId_key" ON "IntakeAnswer"("pipelineJobId");

-- AddForeignKey
ALTER TABLE "IntakeAnswer" ADD CONSTRAINT "IntakeAnswer_pipelineJobId_fkey" FOREIGN KEY ("pipelineJobId") REFERENCES "PipelineJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

