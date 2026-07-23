import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  FileSource,
  FileType,
  PipelineDelivery,
  PipelineJob,
  PipelineJobStatus,
  Prisma,
  UploadStatus,
} from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../prisma/prisma.service';
import { ThumbnailService } from '../uploads/thumbnail.service';
import { ApprovePipelineJobDto } from './dto/approve-pipeline-job.dto';
import { CreatePipelineJobDto } from './dto/create-pipeline-job.dto';
import { DeliverClipDto } from './dto/deliver-clip.dto';

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
  sourceFile: {
    select: {
      id: true,
      fileName: true,
      owner: { select: { id: true, firstName: true, email: true } },
    },
  },
} satisfies Prisma.PipelineJobInclude;

export type PipelineJobListItem = Prisma.PipelineJobGetPayload<{
  include: typeof pipelineJobSourceFileInclude;
}>;

/** GET /admin/pipeline/jobs/:id — same source-file/owner shape as the list. */
export type PipelineJobDetail = PipelineJobListItem;

export interface PipelineJobOutput {
  clipId: string;
  s3Key: string;
  sizeBytes: number;
  presignedUrl: string;
  deliveries: PipelineDelivery[];
}

export interface DeliverClipResult {
  fileId: string;
  folderId: string;
}

/** Basename parser for an assembled clip: final_<clipId>_9x16.mp4 */
const FINAL_CLIP_KEY_PATTERN = /^final_(.+)_9x16\.mp4$/;

/**
 * Defensive re-check of the clipId charset. DeliverClipDto's @Matches is the
 * primary 400 gate; this mirrors it so no path separator/traversal can ever
 * reach an S3 key even if the DTO layer is somehow bypassed.
 */
const CLIP_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Presigned GET lifetime for assembled-clip outputs. */
const OUTPUT_URL_TTL_SECONDS = 15 * 60;

@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);
  private readonly sqsClient: SQSClient;
  private readonly s3Client: S3Client;
  private readonly queueUrl: string;
  private readonly bucketName: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly thumbnailService: ThumbnailService,
    configService: ConfigService,
  ) {
    const region = configService.getOrThrow<string>('AWS_REGION');
    const credentials = {
      accessKeyId: configService.getOrThrow<string>('AWS_ACCESS_KEY_ID'),
      secretAccessKey: configService.getOrThrow<string>(
        'AWS_SECRET_ACCESS_KEY',
      ),
    };
    this.sqsClient = new SQSClient({ region, credentials });
    this.s3Client = new S3Client({ region, credentials });
    this.queueUrl = configService.getOrThrow<string>('PIPELINE_QUEUE_URL');
    this.bucketName = configService.getOrThrow<string>('S3_BUCKET');
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

  async getJobDetail(id: string): Promise<PipelineJobDetail> {
    const job = await this.prisma.pipelineJob.findUnique({
      where: { id },
      include: pipelineJobSourceFileInclude,
    });
    if (job === null) {
      throw new NotFoundException(`Pipeline job ${id} not found`);
    }
    return job;
  }

  /**
   * Assembled outputs for a job, resolved from S3 (the worker records final
   * clips under pipeline/<jobId>/final/), not the manifest. 404 only for an
   * unknown job; empty array when nothing has been assembled yet.
   */
  async getJobOutputs(jobId: string): Promise<PipelineJobOutput[]> {
    const job = await this.prisma.pipelineJob.findUnique({
      where: { id: jobId },
      select: { id: true },
    });
    if (job === null) {
      throw new NotFoundException(`Pipeline job ${jobId} not found`);
    }

    const prefix = `pipeline/${jobId}/final/`;
    const objects = await this.listObjectsUnderPrefix(prefix);

    const parsed: { clipId: string; s3Key: string; sizeBytes: number }[] = [];
    for (const object of objects) {
      const basename = object.key.slice(object.key.lastIndexOf('/') + 1);
      const match = FINAL_CLIP_KEY_PATTERN.exec(basename);
      if (match === null) {
        continue;
      }
      parsed.push({
        clipId: match[1],
        s3Key: object.key,
        sizeBytes: object.sizeBytes,
      });
    }
    if (parsed.length === 0) {
      return [];
    }

    const deliveries = await this.prisma.pipelineDelivery.findMany({
      where: { jobId },
    });
    const deliveriesByClipId = new Map<string, PipelineDelivery[]>();
    for (const delivery of deliveries) {
      const existing = deliveriesByClipId.get(delivery.clipId);
      if (existing === undefined) {
        deliveriesByClipId.set(delivery.clipId, [delivery]);
      } else {
        existing.push(delivery);
      }
    }

    const outputs: PipelineJobOutput[] = [];
    for (const item of parsed) {
      const presignedUrl = await this.presignGetUrl(
        item.s3Key,
        OUTPUT_URL_TTL_SECONDS,
      );
      outputs.push({
        clipId: item.clipId,
        s3Key: item.s3Key,
        sizeBytes: item.sizeBytes,
        presignedUrl,
        deliveries: deliveriesByClipId.get(item.clipId) ?? [],
      });
    }
    return outputs;
  }

  /**
   * Copies an assembled clip into an agency client's folder as a normal-shaped
   * MediaFile, recording the delivery. All folder invariants are validated
   * server-side before any write.
   */
  async deliverClip(
    jobId: string,
    dto: DeliverClipDto,
  ): Promise<DeliverClipResult> {
    const { clipId, folderId } = dto;
    // Never build an S3 key from an unchecked clipId (the DTO already 400s bad
    // charsets; this is defense in depth).
    if (!CLIP_ID_PATTERN.test(clipId)) {
      throw new BadRequestException('Invalid clipId');
    }

    const job = await this.prisma.pipelineJob.findUnique({
      where: { id: jobId },
      include: { sourceFile: { select: { ownerId: true } } },
    });
    if (job === null) {
      throw new NotFoundException(`Pipeline job ${jobId} not found`);
    }

    // Resolve the assembled clip deterministically and confirm it exists.
    const sourceKey = `pipeline/${jobId}/final/final_${clipId}_9x16.mp4`;
    const sizeBytes = await this.headObjectSize(sourceKey);
    if (sizeBytes === null) {
      throw new NotFoundException('no assembled output for that clipId');
    }

    // Destination-folder invariants — ordered, each its own 422.
    const folder = await this.prisma.folder.findUnique({
      where: { id: folderId },
    });
    if (folder === null) {
      throw new UnprocessableEntityException(
        'destination folder does not exist',
      );
    }
    if (folder.agencyId === null) {
      throw new UnprocessableEntityException(
        'destination folder is not agency-scoped',
      );
    }
    if (folder.isSystem) {
      throw new UnprocessableEntityException(
        'destination folder is a system folder',
      );
    }
    if (folder.agencyId !== job.agencyId) {
      throw new UnprocessableEntityException(
        "destination folder belongs to a different agency than the job's source file",
      );
    }
    if (folder.ownerId !== job.sourceFile.ownerId) {
      throw new UnprocessableEntityException(
        "destination folder belongs to a different agency client than the job's source file",
      );
    }

    // Copy the assembled clip into the client's standard raw key layout.
    const fileName = `final_${clipId}_9x16.mp4`;
    const destinationKey = `users/${folder.ownerId}/raw/${Date.now()}-${uuidv4()}-${fileName}`;
    await this.s3Client.send(
      new CopyObjectCommand({
        Bucket: this.bucketName,
        CopySource: `${this.bucketName}/${sourceKey}`,
        Key: destinationKey,
      }),
    );

    let fileId: string;
    try {
      fileId = await this.prisma.$transaction(async (tx) => {
        const mediaFile = await tx.mediaFile.create({
          data: {
            ownerId: folder.ownerId,
            agencyId: job.agencyId,
            folderId: folder.id,
            fileName,
            mimeType: 'video/mp4',
            sizeBytes: BigInt(sizeBytes),
            s3Key: destinationKey,
            fileType: FileType.VIDEO,
            source: FileSource.PIPELINE,
            uploadStatus: UploadStatus.UPLOADED,
            thumbnailS3Key: null,
          },
        });
        await tx.pipelineDelivery.create({
          data: {
            jobId,
            clipId,
            fileId: mediaFile.id,
            folderId: folder.id,
          },
        });
        return mediaFile.id;
      });
    } catch (error: unknown) {
      // The object was copied before the transaction; on any failure remove the
      // orphaned copy before surfacing the error.
      await this.deleteObjectBestEffort(destinationKey);

      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.pipelineDelivery.findUnique({
          where: {
            jobId_clipId_folderId: { jobId, clipId, folderId },
          },
        });
        if (existing !== null) {
          throw new ConflictException({
            message: 'clip already delivered to this folder',
            fileId: existing.fileId,
            folderId,
          });
        }
      }
      throw error;
    }

    // Mirror the upload-complete thumbnail fallback. This is a no-op for VIDEO
    // (ThumbnailService generates for PHOTO only), so the delivered clip keeps
    // thumbnailS3Key = null; wired for parity and future support.
    await this.thumbnailService.generateThumbnailForFile(fileId);

    return { fileId, folderId };
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

  private async listObjectsUnderPrefix(
    prefix: string,
  ): Promise<{ key: string; sizeBytes: number }[]> {
    const objects: { key: string; sizeBytes: number }[] = [];
    let continuationToken: string | undefined;
    do {
      const response = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: this.bucketName,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const object of response.Contents ?? []) {
        if (object.Key === undefined) {
          continue;
        }
        objects.push({ key: object.Key, sizeBytes: object.Size ?? 0 });
      }
      continuationToken =
        response.IsTruncated === true
          ? response.NextContinuationToken
          : undefined;
    } while (continuationToken !== undefined);
    return objects;
  }

  private async headObjectSize(key: string): Promise<number | null> {
    try {
      const response = await this.s3Client.send(
        new HeadObjectCommand({ Bucket: this.bucketName, Key: key }),
      );
      return response.ContentLength ?? 0;
    } catch (error: unknown) {
      if (this.isS3NotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  private async presignGetUrl(
    key: string,
    ttlSeconds: number,
  ): Promise<string> {
    return getSignedUrl(
      this.s3Client,
      new GetObjectCommand({ Bucket: this.bucketName, Key: key }),
      { expiresIn: ttlSeconds },
    );
  }

  private async deleteObjectBestEffort(key: string): Promise<void> {
    try {
      await this.s3Client.send(
        new DeleteObjectCommand({ Bucket: this.bucketName, Key: key }),
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Rollback S3 delete failed for key ${key}: ${message}`);
    }
  }

  private isS3NotFound(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }
    const candidate = error as {
      name?: string;
      $metadata?: { httpStatusCode?: number };
    };
    return (
      candidate.name === 'NotFound' ||
      candidate.name === 'NoSuchKey' ||
      candidate.$metadata?.httpStatusCode === 404
    );
  }
}
