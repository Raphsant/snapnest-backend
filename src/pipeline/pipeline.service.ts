import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  FileType,
  PipelineJob,
  PipelineJobStatus,
  Prisma,
  UploadStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ApprovePipelineJobDto } from './dto/approve-pipeline-job.dto';
import { CreatePipelineJobDto } from './dto/create-pipeline-job.dto';

type ManifestClip = Prisma.JsonObject & {
  id: string;
  approved: boolean | null;
  hook_prompt?: string | null;
  close_prompt?: string | null;
  post_copy?: string | null;
};

type PipelineManifest = Prisma.JsonObject & {
  clips: ManifestClip[];
};

function isJsonObject(value: Prisma.JsonValue): value is Prisma.JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPipelineManifest(
  value: Prisma.JsonValue,
): value is PipelineManifest {
  if (!isJsonObject(value) || !Array.isArray(value.clips)) {
    return false;
  }

  const clipIds = new Set<string>();
  for (const clip of value.clips) {
    if (!isJsonObject(clip)) {
      return false;
    }
    const creativeFields = [
      clip.hook_prompt,
      clip.close_prompt,
      clip.post_copy,
    ];
    if (
      typeof clip.id !== 'string' ||
      (clip.approved !== null && typeof clip.approved !== 'boolean') ||
      creativeFields.some(
        (field) =>
          field !== undefined && field !== null && typeof field !== 'string',
      ) ||
      clipIds.has(clip.id)
    ) {
      return false;
    }
    clipIds.add(clip.id);
  }

  return true;
}

const TERMINAL_STATUSES: PipelineJobStatus[] = [
  PipelineJobStatus.COMPLETED,
  PipelineJobStatus.FAILED,
];

const pipelineJobSourceFileInclude = {
  sourceFile: { select: { id: true, fileName: true } },
} satisfies Prisma.PipelineJobInclude;

export type PipelineJobListItem = Prisma.PipelineJobGetPayload<{
  include: typeof pipelineJobSourceFileInclude;
}>;

@Injectable()
export class PipelineService {
  private readonly sqsClient: SQSClient;
  private readonly queueUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.sqsClient = new SQSClient({
      region: configService.getOrThrow<string>('AWS_REGION'),
      credentials: {
        accessKeyId: configService.getOrThrow<string>('AWS_ACCESS_KEY_ID'),
        secretAccessKey: configService.getOrThrow<string>(
          'AWS_SECRET_ACCESS_KEY',
        ),
      },
    });
    this.queueUrl = configService.getOrThrow<string>('PIPELINE_QUEUE_URL');
  }

  async createJob(
    dto: CreatePipelineJobDto,
    requestedById: string,
  ): Promise<PipelineJob> {
    const file = await this.prisma.mediaFile.findUnique({
      where: { id: dto.fileId },
    });
    if (file === null) {
      throw new NotFoundException(`File ${dto.fileId} not found`);
    }
    if (file.agencyId === null) {
      throw new BadRequestException(
        'Pipeline jobs require an agency-owned file',
      );
    }
    if (file.fileType !== FileType.VIDEO) {
      throw new BadRequestException('Only video files can be pipelined');
    }
    if (file.uploadStatus !== UploadStatus.UPLOADED) {
      throw new BadRequestException(
        'File must be fully uploaded before pipelining',
      );
    }

    const existingActive = await this.prisma.pipelineJob.findFirst({
      where: {
        sourceFileId: dto.fileId,
        status: { notIn: TERMINAL_STATUSES },
      },
    });
    if (existingActive !== null) {
      throw new ConflictException(
        `An active pipeline job already exists for file ${dto.fileId}`,
      );
    }

    const job = await this.prisma.pipelineJob.create({
      data: {
        sourceFileId: dto.fileId,
        agencyId: file.agencyId,
        requestedById,
        status: PipelineJobStatus.QUEUED,
      },
    });

    try {
      await this.sendPipelineMessage(job.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.prisma.pipelineJob.update({
        where: { id: job.id },
        data: {
          status: PipelineJobStatus.FAILED,
          error: `SQS enqueue failed: ${message}`,
        },
      });
    }

    return job;
  }

  async approveJob(
    jobId: string,
    dto: ApprovePipelineJobDto,
  ): Promise<PipelineJob> {
    const job = await this.prisma.pipelineJob.findUnique({
      where: { id: jobId },
    });
    if (job === null) {
      throw new NotFoundException(`Pipeline job ${jobId} not found`);
    }
    if (
      job.status !== PipelineJobStatus.AWAITING_MANIFEST_APPROVAL ||
      job.manifest === null
    ) {
      const missingManifest =
        job.manifest === null ? ' and its manifest is missing' : '';
      throw new ConflictException(
        `Pipeline job ${jobId} cannot be approved while its status is ${job.status}${missingManifest}`,
      );
    }
    if (!isPipelineManifest(job.manifest)) {
      throw new InternalServerErrorException(
        `Pipeline job ${jobId} has an invalid manifest`,
      );
    }

    const approvalsByClipId = new Map<string, boolean>();
    for (const decision of dto.approvals) {
      if (approvalsByClipId.has(decision.clipId)) {
        throw new BadRequestException(
          `Duplicate approval for clip id: ${decision.clipId}`,
        );
      }
      approvalsByClipId.set(decision.clipId, decision.approved);
    }

    const manifestClipIds = new Set(
      job.manifest.clips.map((clip) => clip.id),
    );
    const unknownClipIds = dto.approvals
      .map((decision) => decision.clipId)
      .filter((clipId) => !manifestClipIds.has(clipId));
    if (unknownClipIds.length > 0) {
      throw new BadRequestException(
        `Unknown clip ids: ${unknownClipIds.join(', ')}`,
      );
    }

    const missingClipIds = job.manifest.clips
      .map((clip) => clip.id)
      .filter((clipId) => !approvalsByClipId.has(clipId));
    if (missingClipIds.length > 0) {
      throw new BadRequestException(
        `Missing approvals for clip ids: ${missingClipIds.join(', ')}`,
      );
    }
    if (!dto.approvals.some((decision) => decision.approved)) {
      throw new BadRequestException('at least one clip must be approved');
    }

    const updatedClips = job.manifest.clips.map((clip) => {
      const approved = approvalsByClipId.get(clip.id);
      if (approved === undefined) {
        throw new InternalServerErrorException(
          `Pipeline job ${jobId} approval validation failed`,
        );
      }
      return { ...clip, approved };
    });
    const updatedManifest: PipelineManifest = {
      ...job.manifest,
      clips: updatedClips,
      status: 'approved',
    };

    const result = await this.prisma.pipelineJob.updateMany({
      where: {
        id: jobId,
        status: PipelineJobStatus.AWAITING_MANIFEST_APPROVAL,
      },
      data: {
        manifest: updatedManifest,
        status: PipelineJobStatus.APPROVED,
      },
    });
    if (result.count !== 1) {
      const currentJob = await this.prisma.pipelineJob.findUnique({
        where: { id: jobId },
        select: { status: true },
      });
      if (currentJob === null) {
        throw new NotFoundException(`Pipeline job ${jobId} not found`);
      }
      throw new ConflictException(
        `Pipeline job ${jobId} cannot be approved while its status is ${currentJob.status}`,
      );
    }

    try {
      await this.sendPipelineMessage(jobId, 'cut');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.prisma.pipelineJob.update({
        where: { id: jobId },
        data: {
          status: PipelineJobStatus.FAILED,
          error: `SQS enqueue failed: ${message}`,
        },
      });
    }

    return this.getJob(jobId);
  }

  async approveCreative(jobId: string): Promise<PipelineJob> {
    const job = await this.prisma.pipelineJob.findUnique({
      where: { id: jobId },
    });
    if (job === null) {
      throw new NotFoundException(`Pipeline job ${jobId} not found`);
    }
    if (
      job.status !== PipelineJobStatus.AWAITING_CREATIVE_APPROVAL ||
      job.manifest === null
    ) {
      const missingManifest =
        job.manifest === null ? ' and its manifest is missing' : '';
      throw new ConflictException(
        `Pipeline job ${jobId} cannot approve creative while its status is ${job.status}${missingManifest}`,
      );
    }
    if (!isPipelineManifest(job.manifest)) {
      throw new InternalServerErrorException(
        `Pipeline job ${jobId} has an invalid manifest`,
      );
    }

    const incompleteClipIds = job.manifest.clips
      .filter(
        (clip) =>
          clip.approved === true &&
          (!isNonEmptyString(clip.hook_prompt) ||
            !isNonEmptyString(clip.close_prompt) ||
            !isNonEmptyString(clip.post_copy)),
      )
      .map((clip) => clip.id);
    if (incompleteClipIds.length > 0) {
      throw new ConflictException(
        `creative fields incomplete for clip ids: ${incompleteClipIds.join(', ')}`,
      );
    }

    const result = await this.prisma.pipelineJob.updateMany({
      where: {
        id: jobId,
        status: PipelineJobStatus.AWAITING_CREATIVE_APPROVAL,
      },
      data: {
        status: PipelineJobStatus.CREATIVE_APPROVED,
      },
    });
    if (result.count !== 1) {
      const currentJob = await this.prisma.pipelineJob.findUnique({
        where: { id: jobId },
        select: { status: true },
      });
      if (currentJob === null) {
        throw new NotFoundException(`Pipeline job ${jobId} not found`);
      }
      throw new ConflictException(
        `Pipeline job ${jobId} cannot approve creative while its status is ${currentJob.status}`,
      );
    }

    try {
      await this.sendPipelineMessage(jobId, 'generate');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.prisma.pipelineJob.update({
        where: { id: jobId },
        data: {
          status: PipelineJobStatus.FAILED,
          error: `SQS enqueue failed: ${message}`,
        },
      });
    }

    return this.getJob(jobId);
  }

  listJobs(): Promise<PipelineJobListItem[]> {
    return this.prisma.pipelineJob.findMany({
      include: pipelineJobSourceFileInclude,
      orderBy: { createdAt: 'desc' },
    });
  }

  async getJob(id: string): Promise<PipelineJob> {
    const job = await this.prisma.pipelineJob.findUnique({ where: { id } });
    if (job === null) {
      throw new NotFoundException(`Pipeline job ${id} not found`);
    }
    return job;
  }

  private async sendPipelineMessage(
    jobId: string,
    stage?: string,
  ): Promise<void> {
    const message = stage === undefined ? { jobId } : { jobId, stage };
    await this.sqsClient.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message),
      }),
    );
  }
}
