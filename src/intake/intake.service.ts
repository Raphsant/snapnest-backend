import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Agency,
  FileType,
  FolderType,
  IntakeSessionStatus,
  PipelineJobStatus,
  PipelineSourceType,
  Prisma,
  UploadStatus,
} from '@prisma/client';
import { AgencyService } from '../agency/agency.service';
import {
  PipelineService,
  TERMINAL_STATUSES,
} from '../pipeline/pipeline.service';
import { PrismaService } from '../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';
import { AcceptNdaDto } from './dto/accept-nda.dto';
import { SetAnswerDto } from './dto/set-answer.dto';
import { SetSessionStatusDto } from './dto/set-session-status.dto';
import { StepProgressDto } from './dto/step-progress.dto';
import {
  IntakeAnswerView,
  IntakeProgramView,
  IntakeResponse,
  IntakeSessionSummary,
  IntakeSessionView,
  IntakeStaffAnswerView,
  IntakeStaffSessionView,
  IntakeStepProgressView,
  IntakeTranscriptView,
  NdaStatusResponse,
} from './intake.types';

const INTAKE_URL_TTL_SECONDS = 60 * 60;
/** Slack for players that stop a hair short of the reported duration. */
const WATCHED_TOLERANCE_SECONDS = 2;
const INTAKE_ANSWERS_FOLDER_NAME = 'Intake answers';
/** Worker route that transcribes an intake answer into pipeline/<jobId>/transcript.srt. */
const TRANSCRIBE_STAGE = 'transcribe';

/** Statuses in which the client may still change progress and answers. */
const WRITABLE_STATUSES: IntakeSessionStatus[] = [
  IntakeSessionStatus.NOT_STARTED,
  IntakeSessionStatus.IN_PROGRESS,
];

/** The only transitions staff may make: SUBMITTED -> PROCESSING -> COMPLETE. */
const STAFF_TRANSITIONS: Partial<
  Record<IntakeSessionStatus, IntakeSessionStatus>
> = {
  [IntakeSessionStatus.SUBMITTED]: IntakeSessionStatus.PROCESSING,
  [IntakeSessionStatus.PROCESSING]: IntakeSessionStatus.COMPLETE,
};

const programInclude = {
  steps: {
    orderBy: { order: Prisma.SortOrder.asc },
    include: { questions: { orderBy: { order: Prisma.SortOrder.asc } } },
  },
} satisfies Prisma.IntakeProgramInclude;

type ProgramWithSteps = Prisma.IntakeProgramGetPayload<{
  include: typeof programInclude;
}>;

const sessionInclude = {
  stepProgress: true,
  answers: {
    include: {
      file: {
        select: {
          uploadStatus: true,
          fileName: true,
          durationSeconds: true,
          s3Key: true,
        },
      },
      pipelineJob: { select: { id: true, status: true, error: true } },
    },
  },
} satisfies Prisma.IntakeSessionInclude;

type SessionWithState = Prisma.IntakeSessionGetPayload<{
  include: typeof sessionInclude;
}>;

interface ClientContext {
  program: ProgramWithSteps;
  session: SessionWithState;
}

@Injectable()
export class IntakeService {
  private readonly logger = new Logger(IntakeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly agencyService: AgencyService,
    private readonly uploadsService: UploadsService,
    private readonly pipelineService: PipelineService,
  ) {}

  // ---- Client ----

  async getNdaStatus(
    userId: string,
    agencyId: string,
  ): Promise<NdaStatusResponse> {
    await this.agencyService.assertAgencyMembership(userId, agencyId);
    const agency = await this.loadAgency(agencyId);

    if (agency.ndaVersion === null) {
      return {
        required: false,
        version: null,
        text: agency.ndaText,
        accepted: null,
      };
    }

    const acceptance = await this.prisma.ndaAcceptance.findUnique({
      where: {
        agencyId_userId_version: {
          agencyId,
          userId,
          version: agency.ndaVersion,
        },
      },
    });

    return {
      required: acceptance === null,
      version: agency.ndaVersion,
      text: agency.ndaText,
      accepted:
        acceptance === null
          ? null
          : {
              version: acceptance.version,
              acceptedAt: acceptance.acceptedAt.toISOString(),
            },
    };
  }

  async acceptNda(
    userId: string,
    agencyId: string,
    dto: AcceptNdaDto,
  ): Promise<NdaStatusResponse> {
    await this.agencyService.assertAgencyMembership(userId, agencyId);
    const agency = await this.loadAgency(agencyId);

    if (agency.ndaVersion === null) {
      throw new BadRequestException('Agency has no NDA');
    }
    if (dto.version !== agency.ndaVersion) {
      throw new ConflictException('NDA version is out of date');
    }

    // Re-accepting the same version is a no-op: the first acceptance (name
    // and timestamp) is the record and is never overwritten.
    await this.prisma.ndaAcceptance.upsert({
      where: {
        agencyId_userId_version: {
          agencyId,
          userId,
          version: agency.ndaVersion,
        },
      },
      create: {
        agencyId,
        userId,
        version: agency.ndaVersion,
        fullName: dto.fullName,
        acceptedAt: new Date(),
      },
      update: {},
    });

    return this.getNdaStatus(userId, agencyId);
  }

  async getIntake(userId: string, agencyId: string): Promise<IntakeResponse> {
    const { program, session } = await this.loadClientContext(userId, agencyId);
    return {
      program: await this.toProgramView(program),
      session: this.toSessionView(program, session),
    };
  }

  async recordStepProgress(
    userId: string,
    agencyId: string,
    stepId: string,
    dto: StepProgressDto,
  ): Promise<IntakeSessionView> {
    const { program, session } = await this.loadClientContext(userId, agencyId);
    this.assertSessionWritable(session);

    const step = program.steps.find((s) => s.id === stepId);
    if (step === undefined) {
      throw new NotFoundException('Intake step not found');
    }
    if (!this.computeUnlockedStepIds(program, session).includes(stepId)) {
      throw new ForbiddenException('Intake step is locked');
    }

    await this.prisma.$transaction(async (tx) => {
      await this.claimWritableSession(tx, session);
      // Create-if-missing as ON CONFLICT DO NOTHING: a caught P2002 would
      // abort the surrounding Postgres transaction.
      await tx.intakeStepProgress.createMany({
        data: [{ sessionId: session.id, stepId, watchedSeconds: 0 }],
        skipDuplicates: true,
      });
      // Monotonic in one statement: only ever raises watchedSeconds.
      await tx.intakeStepProgress.updateMany({
        where: {
          sessionId: session.id,
          stepId,
          watchedSeconds: { lt: dto.watchedSeconds },
        },
        data: { watchedSeconds: dto.watchedSeconds },
      });
      await tx.intakeStepProgress.updateMany({
        where: {
          sessionId: session.id,
          stepId,
          watchedAt: null,
          watchedSeconds: {
            gte: step.explainerDurationSec - WATCHED_TOLERANCE_SECONDS,
          },
        },
        data: { watchedAt: new Date() },
      });
    });

    return this.toSessionView(
      program,
      await this.reloadSession(session.id, agencyId),
    );
  }

  async setAnswer(
    userId: string,
    agencyId: string,
    questionId: string,
    dto: SetAnswerDto,
  ): Promise<IntakeSessionView> {
    const { program, session } = await this.loadClientContext(userId, agencyId);
    this.assertSessionWritable(session);

    const step = program.steps.find((s) =>
      s.questions.some((q) => q.id === questionId),
    );
    if (step === undefined) {
      throw new NotFoundException('Intake question not found');
    }
    const progress = session.stepProgress.find((p) => p.stepId === step.id);
    if (
      !this.computeUnlockedStepIds(program, session).includes(step.id) ||
      progress === undefined ||
      progress.watchedAt === null
    ) {
      throw new ForbiddenException('Watch the step explainer before answering');
    }

    const file = await this.prisma.mediaFile.findUnique({
      where: { id: dto.fileId },
    });
    if (file === null) {
      throw new NotFoundException('Media file not found');
    }
    if (file.ownerId !== userId || file.agencyId !== agencyId) {
      throw new ForbiddenException('Media file not accessible');
    }
    if (file.fileType !== FileType.VIDEO) {
      throw new BadRequestException('Intake answers must be videos');
    }
    if (file.uploadStatus === UploadStatus.FAILED) {
      throw new ConflictException('Media file upload failed');
    }

    await this.prisma.$transaction(async (tx) => {
      await this.claimWritableSession(tx, session);
      const reused = await tx.intakeAnswer.findFirst({
        where: {
          sessionId: session.id,
          session: { agencyId },
          fileId: file.id,
          questionId: { not: questionId },
        },
        select: { id: true },
      });
      if (reused !== null) {
        throw new ConflictException('File already used for another answer');
      }
      await tx.intakeAnswer.upsert({
        where: {
          sessionId_questionId: { sessionId: session.id, questionId },
        },
        create: { sessionId: session.id, questionId, fileId: file.id },
        update: { fileId: file.id },
      });
      if (file.folderId !== session.answersFolderId) {
        await tx.mediaFile.update({
          where: { id: file.id, agencyId, ownerId: userId },
          data: { folderId: session.answersFolderId },
        });
      }
    });

    return this.toSessionView(
      program,
      await this.reloadSession(session.id, agencyId),
    );
  }

  async submit(userId: string, agencyId: string): Promise<IntakeSessionView> {
    const { program, session } = await this.loadClientContext(userId, agencyId);
    this.assertSessionWritable(session);

    const questionIds: string[] = program.steps.flatMap((s) =>
      s.questions.map((q) => q.id),
    );
    const submittedAt = new Date();

    const createdJobIds = await this.prisma.$transaction(async (tx) => {
      // Flip status first: the row lock serializes this against a concurrent
      // setAnswer, so the completeness check below sees final answers.
      const { count } = await tx.intakeSession.updateMany({
        where: {
          id: session.id,
          agencyId,
          status: { in: WRITABLE_STATUSES },
        },
        data: { status: IntakeSessionStatus.SUBMITTED, submittedAt },
      });
      if (count === 0) {
        throw new ConflictException('Intake already submitted');
      }

      const answers = await tx.intakeAnswer.findMany({
        where: { sessionId: session.id, session: { agencyId } },
        include: { file: { select: { uploadStatus: true } } },
      });
      const uploadedQuestionIds = new Set(
        answers
          .filter((a) => a.file.uploadStatus === UploadStatus.UPLOADED)
          .map((a) => a.questionId),
      );
      const incomplete = questionIds.filter(
        (id) => !uploadedQuestionIds.has(id),
      );

      const watched = await tx.intakeStepProgress.findMany({
        where: {
          sessionId: session.id,
          session: { agencyId },
          watchedAt: { not: null },
        },
        select: { stepId: true },
      });
      const watchedStepIds = new Set(watched.map((p) => p.stepId));
      const unwatched = program.steps
        .map((s) => s.id)
        .filter((id) => !watchedStepIds.has(id));

      if (incomplete.length > 0 || unwatched.length > 0) {
        const problems: string[] = [];
        if (unwatched.length > 0) {
          problems.push(`Unwatched steps: ${unwatched.join(', ')}`);
        }
        if (incomplete.length > 0) {
          problems.push(
            `Unanswered or not yet uploaded questions: ${incomplete.join(', ')}`,
          );
        }
        throw new ConflictException(problems.join('; '));
      }

      return this.linkTranscriptionJobs(tx, answers, {
        sessionId: session.id,
        agencyId,
        userId,
      });
    });

    // After commit, so the worker never sees a job the submit rolled back.
    await this.sendTranscribeMessages(createdJobIds);

    return this.toSessionView(
      program,
      await this.reloadSession(session.id, agencyId),
    );
  }

  // ---- Staff ----

  async listSessions(
    userId: string,
    agencyId: string,
    status?: IntakeSessionStatus,
  ): Promise<IntakeSessionSummary[]> {
    await this.agencyService.assertAgencyStaff(userId, agencyId);

    const sessions = await this.prisma.intakeSession.findMany({
      where: { agencyId, ...(status !== undefined ? { status } : {}) },
      include: {
        user: { select: { email: true, firstName: true } },
        _count: { select: { answers: true } },
        answers: { select: { pipelineJob: { select: { status: true } } } },
        program: {
          select: {
            steps: { select: { _count: { select: { questions: true } } } },
          },
        },
      },
      orderBy: [
        {
          submittedAt: {
            sort: Prisma.SortOrder.desc,
            nulls: Prisma.NullsOrder.last,
          },
        },
        { updatedAt: Prisma.SortOrder.desc },
      ],
    });

    return sessions.map((s) => ({
      id: s.id,
      userId: s.userId,
      userEmail: s.user.email,
      userFirstName: s.user.firstName,
      status: s.status,
      submittedAt: s.submittedAt?.toISOString() ?? null,
      answeredCount: s._count.answers,
      questionCount: s.program.steps.reduce(
        (sum, step) => sum + step._count.questions,
        0,
      ),
      transcriptsReady: s.answers.filter(
        (a) => a.pipelineJob?.status === PipelineJobStatus.COMPLETED,
      ).length,
      transcriptsTotal: s.answers.filter((a) => a.pipelineJob !== null).length,
    }));
  }

  async getSession(
    userId: string,
    agencyId: string,
    sessionId: string,
  ): Promise<IntakeStaffSessionView> {
    await this.agencyService.assertAgencyStaff(userId, agencyId);
    const session = await this.findAgencySession(sessionId, agencyId);
    const program = await this.loadProgramById(session.programId, agencyId);

    const answers: Record<string, IntakeStaffAnswerView> = {};
    for (const answer of session.answers) {
      answers[answer.questionId] = {
        fileId: answer.fileId,
        uploadStatus: answer.file.uploadStatus,
        fileName: answer.file.fileName,
        durationSeconds: answer.file.durationSeconds,
        viewUrl:
          answer.file.uploadStatus === UploadStatus.UPLOADED
            ? await this.uploadsService.presignGetUrl(
                answer.file.s3Key,
                INTAKE_URL_TTL_SECONDS,
              )
            : null,
        transcript: await this.toTranscriptView(answer.pipelineJob),
      };
    }

    return { ...this.toSessionView(program, session), answers };
  }

  async setSessionStatus(
    userId: string,
    agencyId: string,
    sessionId: string,
    dto: SetSessionStatusDto,
  ): Promise<IntakeSessionView> {
    await this.agencyService.assertAgencyStaff(userId, agencyId);
    const session = await this.findAgencySession(sessionId, agencyId);

    if (STAFF_TRANSITIONS[session.status] !== dto.status) {
      throw new ConflictException(
        `Cannot move intake from ${session.status} to ${dto.status}`,
      );
    }

    // Conditional on the status we validated, so a concurrent transition
    // cannot be skipped over.
    const { count } = await this.prisma.intakeSession.updateMany({
      where: { id: session.id, agencyId, status: session.status },
      data: { status: dto.status },
    });
    if (count === 0) {
      throw new ConflictException('Intake status changed; reload and retry');
    }

    const program = await this.loadProgramById(session.programId, agencyId);
    return this.toSessionView(
      program,
      await this.reloadSession(session.id, agencyId),
    );
  }

  // ---- Helpers ----

  /** Client preamble: membership, NDA, active program, session. */
  private async loadClientContext(
    userId: string,
    agencyId: string,
  ): Promise<ClientContext> {
    await this.agencyService.assertAgencyMembership(userId, agencyId);
    const agency = await this.loadAgency(agencyId);
    await this.assertNdaSatisfied(userId, agency);
    const program = await this.loadActiveProgram(agencyId);
    const session = await this.loadOrCreateSession(userId, agencyId, program);
    return { program, session };
  }

  private async loadAgency(agencyId: string): Promise<Agency> {
    const agency = await this.prisma.agency.findUnique({
      where: { id: agencyId },
    });
    if (agency === null) {
      throw new NotFoundException('Agency not found');
    }
    return agency;
  }

  private async loadActiveProgram(agencyId: string): Promise<ProgramWithSteps> {
    const programs = await this.prisma.intakeProgram.findMany({
      where: { agencyId, isActive: true },
      include: programInclude,
      take: 2,
    });
    if (programs.length === 0) {
      throw new NotFoundException('No active intake program');
    }
    if (programs.length > 1) {
      throw new InternalServerErrorException(
        `Agency ${agencyId} has more than one active intake program`,
      );
    }
    return programs[0];
  }

  private async loadProgramById(
    programId: string,
    agencyId: string,
  ): Promise<ProgramWithSteps> {
    const program = await this.prisma.intakeProgram.findFirst({
      where: { id: programId, agencyId },
      include: programInclude,
    });
    if (program === null) {
      throw new NotFoundException('Intake program not found');
    }
    return program;
  }

  /**
   * Resolves the caller's session for the program, creating it (and its
   * answers folder) on first use. Race-safe the same way as
   * UploadsService.findOrCreateUnfiledFolder: a losing concurrent create
   * surfaces as P2002 on (programId, userId), rolls back its folder, and we
   * re-read the winner.
   */
  private async loadOrCreateSession(
    userId: string,
    agencyId: string,
    program: ProgramWithSteps,
  ): Promise<SessionWithState> {
    const where = {
      programId_userId: { programId: program.id, userId },
      agencyId,
    } satisfies Prisma.IntakeSessionWhereUniqueInput;

    const existing = await this.prisma.intakeSession.findUnique({
      where,
      include: sessionInclude,
    });
    if (existing !== null) {
      return existing;
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const folder = await tx.folder.create({
          data: {
            ownerId: userId,
            agencyId,
            name: INTAKE_ANSWERS_FOLDER_NAME,
            type: FolderType.AGENCY_INTAKE,
            isSystem: false,
          },
        });
        return tx.intakeSession.create({
          data: {
            programId: program.id,
            agencyId,
            userId,
            status: IntakeSessionStatus.NOT_STARTED,
            answersFolderId: folder.id,
          },
          include: sessionInclude,
        });
      });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const raced = await this.prisma.intakeSession.findUnique({
          where,
          include: sessionInclude,
        });
        if (raced !== null) {
          return raced;
        }
      }
      throw error;
    }
  }

  private async findAgencySession(
    sessionId: string,
    agencyId: string,
  ): Promise<SessionWithState> {
    const session = await this.prisma.intakeSession.findFirst({
      where: { id: sessionId, agencyId },
      include: sessionInclude,
    });
    if (session === null) {
      throw new NotFoundException('Intake session not found');
    }
    return session;
  }

  private async reloadSession(
    sessionId: string,
    agencyId: string,
  ): Promise<SessionWithState> {
    return this.prisma.intakeSession.findUniqueOrThrow({
      where: { id: sessionId, agencyId },
      include: sessionInclude,
    });
  }

  private async assertNdaSatisfied(
    userId: string,
    agency: Agency,
  ): Promise<void> {
    if (agency.ndaVersion === null) {
      return;
    }
    const acceptance = await this.prisma.ndaAcceptance.findUnique({
      where: {
        agencyId_userId_version: {
          agencyId: agency.id,
          userId,
          version: agency.ndaVersion,
        },
      },
    });
    if (acceptance === null) {
      throw new ForbiddenException('NDA acceptance required');
    }
  }

  private assertSessionWritable(session: SessionWithState): void {
    if (!WRITABLE_STATUSES.includes(session.status)) {
      throw new ConflictException('Intake already submitted');
    }
  }

  /**
   * Inside a write transaction: moves NOT_STARTED to IN_PROGRESS and locks the
   * session row, failing if a concurrent submit got there first.
   */
  private async claimWritableSession(
    tx: Prisma.TransactionClient,
    session: SessionWithState,
  ): Promise<void> {
    const { count } = await tx.intakeSession.updateMany({
      where: {
        id: session.id,
        agencyId: session.agencyId,
        status: { in: WRITABLE_STATUSES },
      },
      data: { status: IntakeSessionStatus.IN_PROGRESS },
    });
    if (count === 0) {
      throw new ConflictException('Intake already submitted');
    }
  }

  /**
   * Inside the submit transaction: links each answer to a transcription job.
   * A file with an active job (per PipelineJob_one_active_per_file) reuses it
   * instead of inserting. Returns only the ids of jobs created here, which are
   * the ones that need a transcribe message.
   */
  private async linkTranscriptionJobs(
    tx: Prisma.TransactionClient,
    answers: { id: string; questionId: string; fileId: string }[],
    ctx: { sessionId: string; agencyId: string; userId: string },
  ): Promise<string[]> {
    const createdJobIds: string[] = [];
    for (const answer of answers) {
      const active = await tx.pipelineJob.findFirst({
        where: {
          sourceFileId: answer.fileId,
          status: { notIn: TERMINAL_STATUSES },
        },
        select: { id: true, intakeAnswer: { select: { id: true } } },
      });

      let pipelineJobId: string;
      if (active !== null) {
        // pipelineJobId is unique, so a job already linked to another answer
        // (the same file reused in another session) cannot be linked here too.
        if (
          active.intakeAnswer !== null &&
          active.intakeAnswer.id !== answer.id
        ) {
          this.logger.warn(
            `Intake answer left without transcript job: active pipeline job is linked to another answer ` +
              `(sessionId=${ctx.sessionId}, questionId=${answer.questionId}, ` +
              `fileId=${answer.fileId}, pipelineJobId=${active.id})`,
          );
          continue;
        }
        pipelineJobId = active.id;
      } else {
        const job = await tx.pipelineJob.create({
          data: {
            sourceType: PipelineSourceType.FILE,
            sourceFileId: answer.fileId,
            agencyId: ctx.agencyId,
            requestedById: ctx.userId,
            status: PipelineJobStatus.QUEUED,
            manifest: {
              intake: {
                sessionId: ctx.sessionId,
                questionId: answer.questionId,
              },
            },
          },
          select: { id: true },
        });
        pipelineJobId = job.id;
        createdJobIds.push(job.id);
      }

      await tx.intakeAnswer.update({
        where: { id: answer.id },
        data: { pipelineJobId },
      });
    }
    return createdJobIds;
  }

  /** A failed send marks that job FAILED and does not fail the caller. */
  private async sendTranscribeMessages(jobIds: string[]): Promise<void> {
    for (const jobId of jobIds) {
      try {
        await this.pipelineService.sendPipelineMessage(jobId, TRANSCRIBE_STAGE);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.prisma.pipelineJob.update({
          where: { id: jobId },
          data: {
            status: PipelineJobStatus.FAILED,
            error: `SQS enqueue failed: ${message}`,
          },
        });
      }
    }
  }

  private async toTranscriptView(
    job: { id: string; status: PipelineJobStatus; error: string | null } | null,
  ): Promise<IntakeTranscriptView> {
    if (job === null) {
      return { status: 'none', srtUrl: null, error: null };
    }
    switch (job.status) {
      case PipelineJobStatus.QUEUED:
        return { status: 'queued', srtUrl: null, error: null };
      case PipelineJobStatus.COMPLETED:
        return {
          status: 'ready',
          srtUrl: await this.uploadsService.presignGetUrl(
            `pipeline/${job.id}/transcript.srt`,
            INTAKE_URL_TTL_SECONDS,
          ),
          error: null,
        };
      case PipelineJobStatus.FAILED:
        return { status: 'failed', srtUrl: null, error: job.error };
      default:
        // RUNNING and every intermediate pipeline status.
        return { status: 'running', srtUrl: null, error: null };
    }
  }

  /**
   * Step 0 is always unlocked. Step i unlocks once step i-1's explainer is
   * watched and each of its questions has an UPLOADED answer. Stops at the
   * first locked step.
   */
  private computeUnlockedStepIds(
    program: ProgramWithSteps,
    session: SessionWithState,
  ): string[] {
    const watchedStepIds = new Set(
      session.stepProgress
        .filter((p) => p.watchedAt !== null)
        .map((p) => p.stepId),
    );
    const uploadedQuestionIds = new Set(
      session.answers
        .filter((a) => a.file.uploadStatus === UploadStatus.UPLOADED)
        .map((a) => a.questionId),
    );

    const unlocked: string[] = [];
    for (let i = 0; i < program.steps.length; i++) {
      if (i > 0) {
        const previous = program.steps[i - 1];
        const previousDone =
          watchedStepIds.has(previous.id) &&
          previous.questions.every((q) => uploadedQuestionIds.has(q.id));
        if (!previousDone) {
          break;
        }
      }
      unlocked.push(program.steps[i].id);
    }
    return unlocked;
  }

  private toSessionView(
    program: ProgramWithSteps,
    session: SessionWithState,
  ): IntakeSessionView {
    const stepProgress: Record<string, IntakeStepProgressView> = {};
    for (const p of session.stepProgress) {
      stepProgress[p.stepId] = {
        watchedSeconds: p.watchedSeconds,
        watchedAt: p.watchedAt?.toISOString() ?? null,
      };
    }

    const answers: Record<string, IntakeAnswerView> = {};
    for (const a of session.answers) {
      answers[a.questionId] = {
        fileId: a.fileId,
        uploadStatus: a.file.uploadStatus,
      };
    }

    return {
      id: session.id,
      status: session.status,
      submittedAt: session.submittedAt?.toISOString() ?? null,
      answersFolderId: session.answersFolderId,
      stepProgress,
      answers,
      unlockedStepIds: this.computeUnlockedStepIds(program, session),
    };
  }

  private async toProgramView(
    program: ProgramWithSteps,
  ): Promise<IntakeProgramView> {
    const steps = await Promise.all(
      program.steps.map(async (step) => ({
        id: step.id,
        order: step.order,
        title: step.title,
        explainerUrl: await this.uploadsService.presignGetUrl(
          step.explainerS3Key,
          INTAKE_URL_TTL_SECONDS,
        ),
        explainerDurationSec: step.explainerDurationSec,
        questions: step.questions.map((q) => ({
          id: q.id,
          order: q.order,
          prompt: q.prompt,
          maxDurationSec: q.maxDurationSec,
        })),
      })),
    );
    return {
      id: program.id,
      title: program.title,
      version: program.version,
      steps,
    };
  }
}
