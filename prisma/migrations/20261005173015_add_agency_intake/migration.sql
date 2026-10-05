-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "IntakeSessionStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED', 'PROCESSING', 'COMPLETE');

-- AlterTable
ALTER TABLE "Agency" ADD COLUMN     "ndaText" TEXT,
ADD COLUMN     "ndaVersion" TEXT;

-- AlterTable
ALTER TABLE "AgencyMembership" ADD COLUMN     "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE';

-- CreateTable
CREATE TABLE "NdaAcceptance" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NdaAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntakeProgram" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntakeProgram_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntakeStep" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "explainerS3Key" TEXT NOT NULL,
    "explainerDurationSec" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntakeStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntakeQuestion" (
    "id" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "maxDurationSec" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntakeQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntakeSession" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "IntakeSessionStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "answersFolderId" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntakeSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntakeStepProgress" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "watchedSeconds" INTEGER NOT NULL DEFAULT 0,
    "watchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntakeStepProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntakeAnswer" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntakeAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NdaAcceptance_userId_idx" ON "NdaAcceptance"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "NdaAcceptance_agencyId_userId_version_key" ON "NdaAcceptance"("agencyId", "userId", "version");

-- CreateIndex
CREATE INDEX "IntakeProgram_agencyId_isActive_idx" ON "IntakeProgram"("agencyId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "IntakeStep_programId_order_key" ON "IntakeStep"("programId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "IntakeQuestion_stepId_order_key" ON "IntakeQuestion"("stepId", "order");

-- CreateIndex
CREATE INDEX "IntakeSession_agencyId_status_idx" ON "IntakeSession"("agencyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "IntakeSession_programId_userId_key" ON "IntakeSession"("programId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "IntakeStepProgress_sessionId_stepId_key" ON "IntakeStepProgress"("sessionId", "stepId");

-- CreateIndex
CREATE INDEX "IntakeAnswer_fileId_idx" ON "IntakeAnswer"("fileId");

-- CreateIndex
CREATE UNIQUE INDEX "IntakeAnswer_sessionId_questionId_key" ON "IntakeAnswer"("sessionId", "questionId");

-- CreateIndex
CREATE INDEX "AgencyMembership_userId_status_idx" ON "AgencyMembership"("userId", "status");

-- AddForeignKey
ALTER TABLE "NdaAcceptance" ADD CONSTRAINT "NdaAcceptance_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NdaAcceptance" ADD CONSTRAINT "NdaAcceptance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeProgram" ADD CONSTRAINT "IntakeProgram_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeStep" ADD CONSTRAINT "IntakeStep_programId_fkey" FOREIGN KEY ("programId") REFERENCES "IntakeProgram"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeQuestion" ADD CONSTRAINT "IntakeQuestion_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "IntakeStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeSession" ADD CONSTRAINT "IntakeSession_programId_fkey" FOREIGN KEY ("programId") REFERENCES "IntakeProgram"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeSession" ADD CONSTRAINT "IntakeSession_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeSession" ADD CONSTRAINT "IntakeSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeSession" ADD CONSTRAINT "IntakeSession_answersFolderId_fkey" FOREIGN KEY ("answersFolderId") REFERENCES "Folder"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeStepProgress" ADD CONSTRAINT "IntakeStepProgress_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "IntakeSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeStepProgress" ADD CONSTRAINT "IntakeStepProgress_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "IntakeStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeAnswer" ADD CONSTRAINT "IntakeAnswer_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "IntakeSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeAnswer" ADD CONSTRAINT "IntakeAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "IntakeQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeAnswer" ADD CONSTRAINT "IntakeAnswer_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "MediaFile"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
