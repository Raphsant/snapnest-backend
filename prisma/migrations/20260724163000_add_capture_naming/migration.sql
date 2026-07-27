-- AlterTable
ALTER TABLE "Folder" ADD COLUMN     "captureSeq" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "MediaFile" ADD COLUMN     "displayName" TEXT;
