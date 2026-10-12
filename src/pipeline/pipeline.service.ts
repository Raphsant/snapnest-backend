import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
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
  PipelineSourceType,
  Prisma,
  UploadStatus,
} from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { ThumbnailService } from '../uploads/thumbnail.service';
import {
  CaptionBlock,
  CaptionEditError,
  CaptionParseError,
  formatClipSrt,
  mergeEditedText,
  parseClipSrt,
} from './clip-captions';
import { ApprovePipelineJobDto } from './dto/approve-pipeline-job.dto';
import { CreatePipelineJobDto } from './dto/create-pipeline-job.dto';
import { CreateYoutubePipelineJobDto } from './dto/create-youtube-pipeline-job.dto';
import { DeliverClipDto } from './dto/deliver-clip.dto';
import { ListOutputsQueryDto } from './dto/list-outputs-query.dto';
import { SaveClipCaptionsDto } from './dto/save-clip-captions.dto';
import { SetOutputPostedDto } from './dto/set-output-posted.dto';

type ManifestClip = Prisma.JsonObject & {
  id: string;
  approved: boolean | null;
  hook_asset_id?: string | null;
  outro_asset_id?: string | null;
  hook_text?: string | null;
  close_text?: string | null;
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
      clip.hook_asset_id,
      clip.outro_asset_id,
      clip.hook_text,
      clip.close_text,
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

/**
 * The worker writes `{ s3Key, completedAt }` into manifest.clips[].assembled
 * once a final clip is uploaded, which makes the manifest a DB-side record of
 * every assembled output — no ListObjectsV2 needed to enumerate them.
 *
 * Returns null for any clip whose checkpoint is absent or malformed: such a
 * clip is simply not an output yet. This is never an error, because the
 * manifest is written by a separate service and one bad entry must not take
 * down a listing that spans every job. s3Key is the validity gate; a missing
 * or unparseable completedAt still yields an output, just an undated one.
 */
function parseAssembledCheckpoint(
  clip: ManifestClip,
): { completedAt: string | null } | null {
  const raw = clip.assembled;
  if (raw === undefined || !isJsonObject(raw)) {
    return null;
  }
  const s3Key = raw.s3Key;
  if (typeof s3Key !== 'string' || s3Key.trim().length === 0) {
    return null;
  }
  const rawCompletedAt = raw.completedAt;
  const completedAt =
    typeof rawCompletedAt === 'string' &&
    !Number.isNaN(Date.parse(rawCompletedAt))
      ? new Date(rawCompletedAt).toISOString()
      : null;

  return { completedAt };
}

const REQUIRED_CREATIVE_FIELDS = [
  'hook_asset_id',
  'outro_asset_id',
  'hook_text',
  'close_text',
  'post_copy',
] as const;

/**
 * Cap on how many clips a single job may approve. This mirrors the size of the
 * hook/outro asset-library pool: the creative stage draws one hook and one
 * outro per approved clip and never repeats an asset within a job, so a job
 * with more approved clips than the pool holds cannot be filled. Rejecting at
 * the approval gate keeps that failure in the dashboard instead of surfacing
 * it mid-run from the worker.
 */
const MAX_APPROVED_CLIPS_PER_JOB = 10;

export const TERMINAL_STATUSES: PipelineJobStatus[] = [
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
  /** ISO timestamp when this output was marked posted to social, else null. */
  postedAt: string | null;
}

/**
 * One row of the cross-job outputs listing. Metadata only — deliberately no
 * presignedUrl, so a wide listing never fans out into per-row S3 signing.
 * sizeBytes is absent for the same reason: the assemble checkpoint records no
 * size, so it would cost one HeadObject per row. Playback and size stay on
 * GET /admin/pipeline/jobs/:id/outputs.
 */
export interface PipelineOutputListItem {
  jobId: string;
  clipId: string;
  postedAt: string | null;
  /** From the assemble checkpoint; null when absent or unparseable. */
  completedAt: string | null;
  /** Parent job's createdAt — also the sort fallback when completedAt is null. */
  jobCreatedAt: string;
}

export interface PipelineOutputListResult {
  items: PipelineOutputListItem[];
  /** Matches before limit/offset, so the caller knows whether more remain. */
  total: number;
  limit: number;
  offset: number;
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

/** Page size for the cross-job outputs listing when the caller sends none. */
const DEFAULT_OUTPUTS_PAGE_SIZE = 50;

/** Hostnames accepted for a YouTube-sourced pipeline job. */
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
]);

/** A YouTube video id is exactly 11 characters of this charset. */
const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/** Pulls the video id out of the supported YouTube URL shapes, or null. */
function extractYoutubeVideoId(host: string, url: URL): string | null {
  // youtu.be/<id>
  if (host === 'youtu.be') {
    return url.pathname.split('/').filter(Boolean)[0] ?? null;
  }
  // youtube.com/watch?v=<id>
  if (url.pathname === '/watch') {
    return url.searchParams.get('v');
  }
  // youtube.com/{shorts,embed,live,v}/<id>
  const segments = url.pathname.split('/').filter(Boolean);
  if (
    segments.length >= 2 &&
    ['shorts', 'embed', 'live', 'v'].includes(segments[0])
  ) {
    return segments[1];
  }
  return null;
}

/**
 * Validates a client-supplied YouTube URL and returns its canonical form
 * (https://www.youtube.com/watch?v=<id>). Throws BadRequestException for
 * anything that isn't https, isn't a recognized YouTube host, or has no
 * extractable 11-character video id.
 */
function normalizeYoutubeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new BadRequestException('sourceUrl must be a valid URL');
  }
  if (url.protocol !== 'https:') {
    throw new BadRequestException('sourceUrl must use https');
  }
  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) {
    throw new BadRequestException('sourceUrl must be a YouTube URL');
  }
  const videoId = extractYoutubeVideoId(host, url);
  if (videoId === null || !YOUTUBE_VIDEO_ID_PATTERN.test(videoId)) {
    throw new BadRequestException(
      'sourceUrl does not contain a valid YouTube video id',
    );
  }
  return `https://www.youtube.com/watch?v=${videoId}`;
}

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
    private readonly notificationsService: NotificationsService,
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

  /**
   * Creates a YouTube-sourced pipeline job. No MediaFile and no agency: the
   * worker downloads the URL (currentStage "download") and fills sourceS3Key.
   * Mirrors createJob's SQS-failure handling and return shape.
   */
  async createYoutubeJob(
    dto: CreateYoutubePipelineJobDto,
    requestedById: string,
  ): Promise<PipelineJob> {
    const sourceUrl = normalizeYoutubeUrl(dto.sourceUrl);

    const existingActive = await this.prisma.pipelineJob.findFirst({
      where: {
        sourceUrl,
        status: { notIn: TERMINAL_STATUSES },
      },
    });
    if (existingActive !== null) {
      throw new ConflictException({
        message: `An active pipeline job already exists for ${sourceUrl}`,
        jobId: existingActive.id,
      });
    }

    const job = await this.prisma.pipelineJob.create({
      data: {
        sourceType: PipelineSourceType.YOUTUBE,
        sourceFileId: null,
        agencyId: null,
        sourceUrl,
        requestedById,
        status: PipelineJobStatus.QUEUED,
        currentStage: 'download',
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

    const manifestClipIds = new Set(job.manifest.clips.map((clip) => clip.id));
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

    // Assembled clips are locked as approved: a reopened job must not un-approve delivered clips, and the gate UI defaults every clip to rejected.
    const lockedClipIds = new Set(
      job.manifest.clips
        .filter(
          (clip) => clip.assembled !== undefined && clip.assembled !== null,
        )
        .map((clip) => clip.id),
    );

    const approvedCount = dto.approvals.filter(
      (decision) => decision.approved && !lockedClipIds.has(decision.clipId),
    ).length;
    if (approvedCount === 0) {
      throw new BadRequestException('at least one clip must be approved');
    }
    if (approvedCount > MAX_APPROVED_CLIPS_PER_JOB) {
      throw new ConflictException(
        `at most ${MAX_APPROVED_CLIPS_PER_JOB} clips can be approved per job; got ${approvedCount}`,
      );
    }

    const updatedClips = job.manifest.clips.map((clip) => {
      const approved = approvalsByClipId.get(clip.id);
      if (approved === undefined) {
        throw new InternalServerErrorException(
          `Pipeline job ${jobId} approval validation failed`,
        );
      }
      return {
        ...clip,
        approved: lockedClipIds.has(clip.id) ? true : approved,
      };
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

    const incompleteClips = job.manifest.clips
      .filter((clip) => clip.approved === true)
      .map((clip) => ({
        id: clip.id,
        missingFields: REQUIRED_CREATIVE_FIELDS.filter(
          (field) => !isNonEmptyString(clip[field]),
        ),
      }))
      .filter((clip) => clip.missingFields.length > 0);
    if (incompleteClips.length > 0) {
      throw new ConflictException(
        `creative fields incomplete for clip ids: ${incompleteClips
          .map(
            (clip) => `${clip.id} (missing ${clip.missingFields.join(', ')})`,
          )
          .join('; ')}`,
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

  async reopenJob(jobId: string): Promise<PipelineJob> {
    const job = await this.prisma.pipelineJob.findUnique({
      where: { id: jobId },
    });
    if (job === null) {
      throw new NotFoundException(`Pipeline job ${jobId} not found`);
    }
    if (job.manifest === null || !isPipelineManifest(job.manifest)) {
      throw new ConflictException(
        `Pipeline job ${jobId} cannot be reopened without a valid manifest`,
      );
    }

    const result = await this.prisma.pipelineJob.updateMany({
      where: {
        id: jobId,
        status: PipelineJobStatus.COMPLETED,
      },
      data: {
        status: PipelineJobStatus.AWAITING_MANIFEST_APPROVAL,
        error: null,
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
        `Pipeline job ${jobId} cannot be reopened while its status is ${currentJob.status}`,
      );
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

    const posts = await this.prisma.pipelineOutputPost.findMany({
      where: { jobId },
    });
    const postedAtByClipId = new Map(
      posts.map((post) => [post.clipId, post.postedAt]),
    );

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
        postedAt: postedAtByClipId.get(item.clipId)?.toISOString() ?? null,
      });
    }
    return outputs;
  }

  /**
   * Presigns a single assembled clip for download. Unlike getJobOutputs'
   * inline-playback URLs, this forces a save via Content-Disposition with a
   * stable filename. S3 presence is the source of truth for existence.
   */
  async getOutputDownloadUrl(
    jobId: string,
    clipId: string,
  ): Promise<{ url: string; fileName: string }> {
    const job = await this.prisma.pipelineJob.findUnique({
      where: { id: jobId },
      select: { id: true },
    });
    if (job === null) {
      throw new NotFoundException(`Pipeline job ${jobId} not found`);
    }

    // clipId arrives from a URL param; never let an unvalidated value reach S3
    // key construction (mirrors deliverClip's defense-in-depth check).
    if (!CLIP_ID_PATTERN.test(clipId)) {
      throw new BadRequestException('Invalid clipId');
    }

    const fileName = `final_${clipId}_9x16.mp4`;
    const key = `pipeline/${jobId}/final/${fileName}`;

    // S3 presence is the source of truth — do not consult the DB for existence.
    if ((await this.headObjectSize(key)) === null) {
      throw new NotFoundException('Output not found');
    }

    const url = await getSignedUrl(
      this.s3Client,
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${fileName}"`,
        ResponseContentType: 'video/mp4',
      }),
      { expiresIn: OUTPUT_URL_TTL_SECONDS },
    );

    return { url, fileName };
  }

  /**
   * Shared guard for the posted-flag endpoints. The job must exist, the clipId
   * must be key-safe (it reaches an S3 key), and the assembled output must
   * actually be in S3 — the same source of truth getOutputDownloadUrl uses.
   * Without the S3 check a typo'd clipId would write a row that no listing can
   * ever surface and no toggle can ever clear.
   */
  private async assertOutputExists(
    jobId: string,
    clipId: string,
  ): Promise<void> {
    const job = await this.prisma.pipelineJob.findUnique({
      where: { id: jobId },
      select: { id: true },
    });
    if (job === null) {
      throw new NotFoundException(`Pipeline job ${jobId} not found`);
    }
    if (!CLIP_ID_PATTERN.test(clipId)) {
      throw new BadRequestException('Invalid clipId');
    }
    const key = `pipeline/${jobId}/final/final_${clipId}_9x16.mp4`;
    if ((await this.headObjectSize(key)) === null) {
      throw new NotFoundException('Output not found');
    }
  }

  /**
   * Marks an assembled output as posted to social. Idempotent: a second call
   * updates the existing row's timestamp rather than creating a duplicate,
   * which the (jobId, clipId) unique index would reject anyway.
   */
  async setOutputPosted(
    jobId: string,
    clipId: string,
    dto: SetOutputPostedDto,
  ): Promise<{ clipId: string; postedAt: string }> {
    await this.assertOutputExists(jobId, clipId);

    const postedAt =
      dto.postedAt === undefined ? new Date() : new Date(dto.postedAt);
    const record = await this.prisma.pipelineOutputPost.upsert({
      where: { jobId_clipId: { jobId, clipId } },
      create: { jobId, clipId, postedAt },
      update: { postedAt },
    });

    return { clipId: record.clipId, postedAt: record.postedAt.toISOString() };
  }

  /**
   * Clears the posted flag by deleting the row — row presence is the state.
   * deleteMany, not delete, so clearing an already-unposted output is a no-op
   * instead of a P2025: the endpoint stays idempotent under a double click.
   */
  async clearOutputPosted(jobId: string, clipId: string): Promise<void> {
    await this.assertOutputExists(jobId, clipId);
    await this.prisma.pipelineOutputPost.deleteMany({
      where: { jobId, clipId },
    });
  }

  /**
   * Generated and operator-edited caption slices for one clip. Readable in
   * any status so the dashboard can show captions read-only; `edited` is
   * null when no edit has been saved.
   */
  async getClipCaptions(
    jobId: string,
    clipId: string,
  ): Promise<{ generated: CaptionBlock[]; edited: CaptionBlock[] | null }> {
    await this.assertCaptionClip(jobId, clipId, { editable: false });

    const keys = this.captionKeys(jobId, clipId);
    const generated = await this.loadGeneratedCaptions(jobId, clipId);
    const editedText = await this.getObjectText(keys.edited);
    const edited =
      editedText === null
        ? null
        : this.parseStoredCaptions(keys.edited, editedText, clipId);

    return { generated, edited };
  }

  /**
   * Saves a text-only caption edit. Timings and indexes come from the
   * generated slice; the client supplies text only. Written in the worker's
   * own serialisation so creative and assemble re-validate it unchanged.
   */
  async saveClipCaptions(
    jobId: string,
    clipId: string,
    dto: SaveClipCaptionsDto,
  ): Promise<{ blocks: CaptionBlock[] }> {
    await this.assertCaptionClip(jobId, clipId, { editable: true });

    const generated = await this.loadGeneratedCaptions(jobId, clipId);
    let merged: CaptionBlock[];
    try {
      merged = mergeEditedText(generated, dto.blocks);
    } catch (error: unknown) {
      if (error instanceof CaptionEditError) {
        throw new UnprocessableEntityException({
          message: error.message,
          position: error.position,
        });
      }
      throw error;
    }

    await this.putObjectText(
      this.captionKeys(jobId, clipId).edited,
      formatClipSrt(merged),
    );
    return { blocks: merged };
  }

  /**
   * Reverts a clip to its generated captions by deleting the edit. S3
   * DeleteObject succeeds on a missing key, so a repeat revert is a no-op.
   */
  async deleteClipCaptions(jobId: string, clipId: string): Promise<void> {
    await this.assertCaptionClip(jobId, clipId, { editable: true });

    await this.s3Client.send(
      new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: this.captionKeys(jobId, clipId).edited,
      }),
    );
  }

  /**
   * Shared guard for the caption endpoints. clipId reaches an S3 key, so its
   * charset is checked before anything else. The clip must be in the job's
   * manifest, since the worker only slices captions for manifest clips.
   * `editable` adds the edit-gate checks: the job must be at manifest
   * approval, and an assembled clip stays locked, matching approveJob.
   */
  private async assertCaptionClip(
    jobId: string,
    clipId: string,
    { editable }: { editable: boolean },
  ): Promise<{ job: PipelineJob; clip: ManifestClip }> {
    if (!CLIP_ID_PATTERN.test(clipId)) {
      throw new BadRequestException('Invalid clipId');
    }

    const job = await this.prisma.pipelineJob.findUnique({
      where: { id: jobId },
    });
    if (job === null) {
      throw new NotFoundException(`Pipeline job ${jobId} not found`);
    }

    const manifest = job.manifest;
    if (manifest === null) {
      // Queued or still running: no manifest means no clips yet.
      throw new NotFoundException(
        `clip ${clipId} not found in job ${jobId} manifest`,
      );
    }
    if (!isPipelineManifest(manifest)) {
      throw new InternalServerErrorException(
        `Pipeline job ${jobId} has an invalid manifest`,
      );
    }
    const clip = manifest.clips.find((candidate) => candidate.id === clipId);
    if (clip === undefined) {
      throw new NotFoundException(
        `clip ${clipId} not found in job ${jobId} manifest`,
      );
    }

    if (editable) {
      if (job.status !== PipelineJobStatus.AWAITING_MANIFEST_APPROVAL) {
        throw new ConflictException(
          `Pipeline job ${jobId} cannot edit captions while its status is ${job.status}`,
        );
      }
      if (clip.assembled !== undefined && clip.assembled !== null) {
        throw new ConflictException(
          `clip ${clipId} is already assembled; captions are locked`,
        );
      }
    }

    return { job, clip };
  }

  /**
   * Must match snapnest-worker worker/artifacts.py clip_caption_key and
   * edited_clip_caption_key.
   */
  private captionKeys(
    jobId: string,
    clipId: string,
  ): { generated: string; edited: string } {
    return {
      generated: `pipeline/${jobId}/clips/captions/${clipId}.srt`,
      edited: `pipeline/${jobId}/clips/captions/${clipId}.edited.srt`,
    };
  }

  /** 404 when the worker has not written the slice; 500 when it is malformed. */
  private async loadGeneratedCaptions(
    jobId: string,
    clipId: string,
  ): Promise<CaptionBlock[]> {
    const key = this.captionKeys(jobId, clipId).generated;
    const text = await this.getObjectText(key);
    if (text === null) {
      throw new NotFoundException(`captions not generated for clip ${clipId}`);
    }
    return this.parseStoredCaptions(key, text, clipId);
  }

  /**
   * Both stored files are written by trusted code (the worker, or this
   * service's own serialiser), so a parse failure is a server fault, not a
   * client one: log the key and detail, surface a 500.
   */
  private parseStoredCaptions(
    key: string,
    text: string,
    clipId: string,
  ): CaptionBlock[] {
    try {
      return parseClipSrt(text);
    } catch (error: unknown) {
      if (error instanceof CaptionParseError) {
        this.logger.error(`Malformed captions at ${key}: ${error.message}`);
        throw new InternalServerErrorException(
          `stored captions for clip ${clipId} are malformed`,
        );
      }
      throw error;
    }
  }

  /**
   * Cross-job listing of assembled outputs, enumerated from the manifests the
   * worker checkpoints into PipelineJob.manifest rather than from S3 — two
   * queries total instead of one ListObjectsV2 per job. The posted flag is
   * left-joined in memory; "unposted" is the absence of a row, which is why
   * this cannot be answered from S3 alone.
   */
  async listOutputs(
    query: ListOutputsQueryDto,
  ): Promise<PipelineOutputListResult> {
    const limit = query.limit ?? DEFAULT_OUTPUTS_PAGE_SIZE;
    const offset = query.offset ?? 0;

    const jobs = await this.prisma.pipelineJob.findMany({
      select: { id: true, createdAt: true, manifest: true },
      orderBy: { createdAt: 'desc' },
    });
    const posts = await this.prisma.pipelineOutputPost.findMany();
    const postedAtByKey = new Map(
      posts.map((post) => [`${post.jobId}:${post.clipId}`, post.postedAt]),
    );

    const items: PipelineOutputListItem[] = [];
    for (const job of jobs) {
      if (job.manifest === null) {
        // Queued job, nothing generated yet.
        continue;
      }
      if (!isPipelineManifest(job.manifest)) {
        // Written by the worker, so a shape this API can't read is possible.
        // Skip the job and keep going — never fail the whole listing.
        this.logger.warn(
          `listOutputs: skipping job ${job.id} with an unreadable manifest`,
        );
        continue;
      }

      for (const clip of job.manifest.clips) {
        const checkpoint = parseAssembledCheckpoint(clip);
        if (checkpoint === null) {
          continue;
        }
        const postedAt = postedAtByKey.get(`${job.id}:${clip.id}`);
        items.push({
          jobId: job.id,
          clipId: clip.id,
          postedAt: postedAt === undefined ? null : postedAt.toISOString(),
          completedAt: checkpoint.completedAt,
          jobCreatedAt: job.createdAt.toISOString(),
        });
      }
    }

    const filtered =
      query.posted === undefined
        ? items
        : items.filter((item) => (item.postedAt !== null) === query.posted);

    // Newest assembled first, falling back to the job's own createdAt for an
    // output whose checkpoint carried no usable timestamp. clipId breaks ties
    // so paging can't reorder rows between two requests.
    filtered.sort((a, b) => {
      const byTime =
        Date.parse(b.completedAt ?? b.jobCreatedAt) -
        Date.parse(a.completedAt ?? a.jobCreatedAt);
      return byTime !== 0 ? byTime : a.clipId.localeCompare(b.clipId);
    });

    return {
      items: filtered.slice(offset, offset + limit),
      total: filtered.length,
      limit,
      offset,
    };
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

    // YouTube-sourced jobs have no MediaFile owner and no agency, so the
    // destination-folder invariants below (folder.agencyId === job.agencyId,
    // folder.ownerId === job.sourceFile.ownerId) would compare against
    // null/undefined and either mismatch confusingly or match by accident.
    // Refuse before any S3 or folder work. This also narrows job.sourceFile to
    // non-null for the ownership check further down.
    if (
      job.sourceType === PipelineSourceType.YOUTUBE ||
      job.sourceFileId === null ||
      job.sourceFile === null
    ) {
      throw new BadRequestException(
        "YouTube-sourced jobs don't support folder delivery yet.",
      );
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

    // Fire-and-forget push to the destination folder's owner (the agency client
    // who receives the delivered clip). sendToUser never throws, but we still
    // void + .catch so a push failure can never delay or fail delivery.
    void this.notificationsService
      .sendToUser(
        folder.ownerId,
        'New content ready',
        `A new clip was delivered to ${folder.name}`,
        { fileId, folderId },
      )
      .catch((error: unknown) => {
        this.logger.error(
          `[push] clip-delivery notification failed for file ${fileId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });

    return { fileId, folderId };
  }

  async sendPipelineMessage(jobId: string, stage?: string): Promise<void> {
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

  /*
   * Server-side reads and writes of small caption SRTs, the same pattern as
   * ThumbnailService. This is a deliberate exception to the presigned-only
   * rule, which governs client access: the dashboard never touches these
   * objects directly, and the backend must validate edits against the
   * generated slice before anything reaches S3.
   */

  /** Object body as UTF-8 text, or null when the key does not exist. */
  private async getObjectText(key: string): Promise<string | null> {
    try {
      const response = await this.s3Client.send(
        new GetObjectCommand({ Bucket: this.bucketName, Key: key }),
      );
      if (response.Body === undefined) {
        throw new Error(`Empty S3 object body for key ${key}`);
      }
      return await response.Body.transformToString('utf-8');
    } catch (error: unknown) {
      if (this.isS3NotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  private async putObjectText(key: string, body: string): Promise<void> {
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: Buffer.from(body, 'utf-8'),
        ContentType: 'application/x-subrip; charset=utf-8',
      }),
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
