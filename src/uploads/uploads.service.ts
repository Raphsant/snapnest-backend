import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  FileSource,
  FileType,
  JobStatus,
  Prisma,
  UploadStatus,
} from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { AgencyService } from '../agency/agency.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUploadDto, UploadSource } from './dto/create-upload.dto';
import { ThumbnailService } from './thumbnail.service';

const PRESIGN_TTL_SECONDS = 15 * 60;
const VIEW_URL_TTL_SECONDS = 60 * 60;
const MAX_BATCH_VIEW_URL_IDS = 100;

export interface FileViewUrlResponse {
  viewUrl: string;
  expiresAt: string;
  mimeType: string;
  fileName: string;
}
const DEFAULT_FILES_LIMIT = 50;
const MAX_FILES_LIMIT = 200;

/** Query param value for GET /files?folderId=none → files with folderId IS NULL. */
export const UNFILED_FOLDER_QUERY = 'none';

const mediaFileFolderInclude = {
  folder: { select: { id: true, name: true } },
} satisfies Prisma.MediaFileInclude;

export interface PresignedUploadResponse {
  uploadId: string;
  fileId: string;
  uploadUrl: string;
  s3Key: string;
  expiresAt: string;
}

export type MediaFileWithFolder = Prisma.MediaFileGetPayload<{
  include: typeof mediaFileFolderInclude;
}>;

/** API shape: BigInt sizeBytes as string for JSON clients. */
export type SerializedMediaFile = Omit<MediaFileWithFolder, 'sizeBytes'> & {
  sizeBytes: string;
};

export interface GetUserFilesOptions {
  folderId?: string;
  limit?: number;
  before?: Date;
}

export interface BatchFileViewUrlItem {
  fileId: string;
  fullUrl: string;
  thumbnailUrl: string | null;
}

export interface DeleteFileResult {
  success: true;
  deletedFileId: string;
}

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);
  private readonly s3Client: S3Client;
  private readonly bucketName: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly thumbnailService: ThumbnailService,
    private readonly agencyService: AgencyService,
  ) {
    const region: string = this.configService.get<string>('AWS_REGION', '');
    const accessKeyId: string = this.configService.get<string>(
      'AWS_ACCESS_KEY_ID',
      '',
    );
    const secretAccessKey: string = this.configService.get<string>(
      'AWS_SECRET_ACCESS_KEY',
      '',
    );
    this.bucketName = this.configService.get<string>('S3_BUCKET', '');

    this.s3Client = new S3Client({
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
  }

  async createPresignedUploadUrl(
    userId: string,
    dto: CreateUploadDto,
  ): Promise<PresignedUploadResponse> {
    if (dto.agencyId !== undefined) {
      // Agency submission: authorize by membership, and any target folder must belong to the agency.
      await this.agencyService.assertAgencyMembership(userId, dto.agencyId);
      if (dto.folderId !== undefined) {
        await this.assertFolderInAgency(dto.folderId, dto.agencyId);
      }
    } else if (dto.folderId !== undefined) {
      await this.assertFolderOwnedByUser(dto.folderId, userId);
    }

    const timestamp: number = Date.now();
    const keySegmentUuid: string = uuidv4();
    const sanitizedFileName: string = this.sanitizeFileName(dto.fileName);
    const s3Key: string = `users/${userId}/raw/${timestamp}-${keySegmentUuid}-${sanitizedFileName}`;

    const putObjectCommand = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: s3Key,
      ContentType: dto.mimeType,
    });

    const uploadUrl: string = await getSignedUrl(
      this.s3Client,
      putObjectCommand,
      { expiresIn: PRESIGN_TTL_SECONDS },
    );

    const expiresAt: Date = new Date(Date.now() + PRESIGN_TTL_SECONDS * 1000);
    const fileType: FileType = this.fileTypeFromMimeType(dto.mimeType);
    const source: FileSource = this.fileSourceFromDto(dto.source);
    const sizeBytes: bigint = BigInt(dto.sizeBytes);

    const { mediaFile, uploadJob } = await this.prisma.$transaction(
      async (tx) => {
        const mediaFile = await tx.mediaFile.create({
          data: {
            ownerId: userId,
            agencyId: dto.agencyId ?? null,
            folderId: dto.folderId ?? null,
            fileName: dto.fileName,
            mimeType: dto.mimeType,
            sizeBytes,
            s3Key,
            fileType,
            source,
            uploadStatus: UploadStatus.PENDING,
          },
        });
        const uploadJob = await tx.uploadJob.create({
          data: {
            userId,
            fileId: mediaFile.id,
            status: JobStatus.REQUESTED,
            expiresAt,
          },
        });
        return { mediaFile, uploadJob };
      },
    );

    return {
      uploadId: uploadJob.id,
      fileId: mediaFile.id,
      uploadUrl,
      s3Key,
      expiresAt: uploadJob.expiresAt.toISOString(),
    };
  }

  async completeUpload(
    uploadId: string,
    userId: string,
  ): Promise<SerializedMediaFile> {
    const job = await this.prisma.uploadJob.findUnique({
      where: { id: uploadId },
      include: { file: { include: mediaFileFolderInclude } },
    });

    if (job === null) {
      throw new NotFoundException('Upload job not found');
    }
    if (job.userId !== userId) {
      throw new ForbiddenException('Upload job not accessible');
    }

    const { file } = job;
    if (
      job.status === JobStatus.COMPLETED &&
      file.uploadStatus === UploadStatus.UPLOADED
    ) {
      return this.serializeMediaFile(file);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.uploadJob.update({
        where: { id: uploadId },
        data: { status: JobStatus.COMPLETED },
      });
      await tx.mediaFile.update({
        where: { id: file.id },
        data: { uploadStatus: UploadStatus.UPLOADED },
      });
    });

    await this.thumbnailService.generateThumbnailForFile(file.id);

    const refreshed = await this.prisma.mediaFile.findUnique({
      where: { id: file.id },
      include: mediaFileFolderInclude,
    });
    if (refreshed === null) {
      throw new NotFoundException('Media file not found');
    }
    return this.serializeMediaFile(refreshed);
  }

  async getBatchViewUrls(
    userId: string,
    fileIds: string[],
    agencyId?: string,
  ): Promise<BatchFileViewUrlItem[]> {
    if (fileIds.length > MAX_BATCH_VIEW_URL_IDS) {
      throw new BadRequestException(
        `At most ${MAX_BATCH_VIEW_URL_IDS} file IDs per request`,
      );
    }

    // Agency scope authorizes by membership (files owned by other members are allowed);
    // personal scope restricts strictly to the caller's own files.
    let scopeWhere: Pick<Prisma.MediaFileWhereInput, 'ownerId' | 'agencyId'>;
    if (agencyId !== undefined) {
      await this.agencyService.assertAgencyMembership(userId, agencyId);
      scopeWhere = { agencyId };
    } else {
      scopeWhere = { ownerId: userId, agencyId: null };
    }

    const files = await this.prisma.mediaFile.findMany({
      where: {
        id: { in: fileIds },
        ...scopeWhere,
        uploadStatus: UploadStatus.UPLOADED,
      },
    });

    const results: BatchFileViewUrlItem[] = [];
    for (const file of files) {
      const fullUrl = await this.presignGetUrl(file.s3Key);
      const thumbnailUrl =
        file.thumbnailS3Key !== null
          ? await this.presignGetUrl(file.thumbnailS3Key)
          : null;
      results.push({ fileId: file.id, fullUrl, thumbnailUrl });
    }
    return results;
  }

  async getFileViewUrl(
    fileId: string,
    userId: string,
  ): Promise<FileViewUrlResponse> {
    const file = await this.prisma.mediaFile.findUnique({
      where: { id: fileId },
    });
    if (file === null) {
      throw new NotFoundException('Media file not found');
    }
    if (file.ownerId !== userId) {
      throw new ForbiddenException('Media file not accessible');
    }
    if (file.uploadStatus !== UploadStatus.UPLOADED) {
      throw new NotFoundException('Media file is not ready to view');
    }

    const objectKey = file.thumbnailS3Key ?? file.s3Key;
    const viewUrl = await this.presignGetUrl(objectKey);
    const expiresAt = new Date(Date.now() + VIEW_URL_TTL_SECONDS * 1000);

    return {
      viewUrl,
      expiresAt: expiresAt.toISOString(),
      mimeType: file.mimeType,
      fileName: file.fileName,
    };
  }

  async getUserFiles(
    userId: string,
    opts: GetUserFilesOptions,
  ): Promise<SerializedMediaFile[]> {
    const limitRaw: number = opts.limit ?? DEFAULT_FILES_LIMIT;
    const limit: number = Math.min(Math.max(limitRaw, 1), MAX_FILES_LIMIT);

    const rows = await this.prisma.mediaFile.findMany({
      where: {
        ownerId: userId,
        agencyId: null,
        uploadStatus: UploadStatus.UPLOADED,
        ...this.buildFolderIdWhere(opts.folderId),
        ...(opts.before !== undefined
          ? { createdAt: { lt: opts.before } }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: mediaFileFolderInclude,
    });

    return rows.map((row) => this.serializeMediaFile(row));
  }

  async moveFileToFolder(
    userId: string,
    fileId: string,
    folderId: string | null,
  ): Promise<SerializedMediaFile> {
    const file = await this.prisma.mediaFile.findUnique({
      where: { id: fileId },
      include: mediaFileFolderInclude,
    });
    if (file === null) {
      throw new NotFoundException('Media file not found');
    }
    if (file.ownerId !== userId) {
      throw new ForbiddenException('Media file not accessible');
    }
    if (file.agencyId !== null) {
      throw new ForbiddenException('Agency files cannot be moved here');
    }

    if (folderId !== null) {
      await this.assertFolderOwnedByUser(folderId, userId);
    }

    const updated = await this.prisma.mediaFile.update({
      where: { id: fileId },
      data: { folderId },
      include: mediaFileFolderInclude,
    });

    return this.serializeMediaFile(updated);
  }

  /**
   * Permanently deletes the cloud copy (S3 + DB). Does not affect the user's device camera roll.
   * UploadJob is removed via onDelete: Cascade when MediaFile is deleted.
   */
  async deleteFile(userId: string, fileId: string): Promise<DeleteFileResult> {
    const file = await this.prisma.mediaFile.findUnique({
      where: { id: fileId },
    });
    if (file === null) {
      throw new NotFoundException('Media file not found');
    }
    if (file.ownerId !== userId) {
      throw new ForbiddenException('Media file not accessible');
    }
    if (file.agencyId !== null) {
      throw new ForbiddenException('Agency files cannot be deleted here');
    }

    await this.deleteS3ObjectBestEffort(file.s3Key);
    if (file.thumbnailS3Key !== null) {
      await this.deleteS3ObjectBestEffort(file.thumbnailS3Key);
    }

    await this.prisma.mediaFile.delete({
      where: { id: fileId },
    });

    return { success: true, deletedFileId: fileId };
  }

  private async deleteS3ObjectBestEffort(s3Key: string): Promise<void> {
    try {
      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: s3Key,
        }),
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`S3 delete failed for key ${s3Key}: ${message}`);
    }
  }

  /** folderId omitted → all files; `'none'` → unfiled only; otherwise filter by folder UUID. */
  private buildFolderIdWhere(
    folderId: string | undefined,
  ): Pick<Prisma.MediaFileWhereInput, 'folderId'> | Record<string, never> {
    if (folderId === undefined) {
      return {};
    }
    if (folderId === UNFILED_FOLDER_QUERY) {
      return { folderId: null };
    }
    return { folderId };
  }

  private async presignGetUrl(s3Key: string): Promise<string> {
    const getCommand = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: s3Key,
    });
    return getSignedUrl(this.s3Client, getCommand, {
      expiresIn: VIEW_URL_TTL_SECONDS,
    });
  }

  private async assertFolderOwnedByUser(
    folderId: string,
    userId: string,
  ): Promise<void> {
    const folder = await this.prisma.folder.findUnique({
      where: { id: folderId },
    });
    if (folder === null) {
      throw new NotFoundException('Folder not found');
    }
    if (folder.ownerId !== userId) {
      throw new ForbiddenException('Folder not accessible');
    }
  }

  private async assertFolderInAgency(
    folderId: string,
    agencyId: string,
  ): Promise<void> {
    const folder = await this.prisma.folder.findUnique({
      where: { id: folderId },
    });
    if (folder === null) {
      throw new NotFoundException('Folder not found');
    }
    if (folder.agencyId !== agencyId) {
      throw new ForbiddenException('Folder not accessible');
    }
  }

  private fileTypeFromMimeType(mimeType: string): FileType {
    const lower = mimeType.trim().toLowerCase();
    if (lower.startsWith('image/')) {
      return FileType.PHOTO;
    }
    if (lower.startsWith('video/')) {
      return FileType.VIDEO;
    }
    if (lower.startsWith('audio/')) {
      return FileType.AUDIO;
    }
    return FileType.PHOTO;
  }

  private fileSourceFromDto(source: UploadSource): FileSource {
    if (source === UploadSource.CAMERA) {
      return FileSource.CAMERA;
    }
    return FileSource.GALLERY;
  }

  private serializeMediaFile(file: MediaFileWithFolder): SerializedMediaFile {
    const { sizeBytes, ...rest } = file;
    return {
      ...rest,
      sizeBytes: sizeBytes.toString(),
    };
  }

  private sanitizeFileName(fileName: string): string {
    const trimmedName: string = fileName.trim().toLowerCase();
    const safeName: string = trimmedName.replace(/[^a-z0-9._-]/g, '-');
    const dedupedDashes: string = safeName.replace(/-+/g, '-');
    return dedupedDashes || 'upload.bin';
  }
}
