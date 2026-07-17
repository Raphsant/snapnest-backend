-- AlterTable
ALTER TABLE "Folder" ADD COLUMN     "isSystem" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
-- Partial unique index: at most one system folder per owner. Non-system
-- folders are unconstrained. Not declarable in schema.prisma (Prisma 7 has no
-- filtered-index support), so it lives here only; custom name signals that.
CREATE UNIQUE INDEX "Folder_one_system_per_owner_idx" ON "Folder"("ownerId") WHERE "isSystem" = true;
