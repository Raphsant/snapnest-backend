import type { IntakeSessionStatus, UploadStatus } from '@prisma/client';

/**
 * Response contracts for the client intake flow. Exported so the mobile app
 * can mirror them. All timestamps are ISO-8601 strings.
 */

export interface NdaStatusResponse {
  /** True when the agency has an ndaVersion and the user has not accepted it. */
  required: boolean;
  version: string | null;
  text: string | null;
  accepted: { version: string; acceptedAt: string } | null;
}

export interface IntakeQuestionView {
  id: string;
  order: number;
  prompt: string;
  maxDurationSec: number | null;
}

export interface IntakeStepView {
  id: string;
  order: number;
  title: string;
  /** Presigned GET, 1 hour expiry. */
  explainerUrl: string;
  explainerDurationSec: number;
  questions: IntakeQuestionView[];
}

export interface IntakeProgramView {
  id: string;
  title: string;
  version: number;
  steps: IntakeStepView[];
}

export interface IntakeStepProgressView {
  watchedSeconds: number;
  watchedAt: string | null;
}

export interface IntakeAnswerView {
  fileId: string;
  uploadStatus: UploadStatus;
}

export interface IntakeSessionView {
  id: string;
  status: IntakeSessionStatus;
  submittedAt: string | null;
  answersFolderId: string;
  /** Keyed by stepId. */
  stepProgress: Record<string, IntakeStepProgressView>;
  /** Keyed by questionId. */
  answers: Record<string, IntakeAnswerView>;
  /** Computed server-side. */
  unlockedStepIds: string[];
}

export interface IntakeResponse {
  program: IntakeProgramView;
  session: IntakeSessionView;
}

export interface IntakeSessionSummary {
  id: string;
  userId: string;
  userEmail: string;
  userFirstName: string | null;
  status: IntakeSessionStatus;
  submittedAt: string | null;
  answeredCount: number;
  questionCount: number;
  /** Answers whose linked pipeline job is COMPLETED. */
  transcriptsReady: number;
  /** Answers with a linked pipeline job. */
  transcriptsTotal: number;
}

export type IntakeTranscriptStatus =
  | 'none'
  | 'queued'
  | 'running'
  | 'ready'
  | 'failed';

export interface IntakeTranscriptView {
  status: IntakeTranscriptStatus;
  /** Presigned GET of the job's transcript.srt, 1 hour expiry; set only when ready. */
  srtUrl: string | null;
  /** Job error; set only when failed. */
  error: string | null;
}

export interface IntakeStaffAnswerView extends IntakeAnswerView {
  fileName: string;
  durationSeconds: number | null;
  /** Presigned GET; null when the file is not UPLOADED. */
  viewUrl: string | null;
  transcript: IntakeTranscriptView;
}

export interface IntakeStaffSessionView extends Omit<
  IntakeSessionView,
  'answers'
> {
  /** Keyed by questionId. */
  answers: Record<string, IntakeStaffAnswerView>;
}
