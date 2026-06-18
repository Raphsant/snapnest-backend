import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileType, UploadStatus } from '@prisma/client';
import sharp from 'sharp';
import { PrismaService } from '../prisma/prisma.service';

const THUMBNAIL_SIZE = 400;
const THUMBNAIL_JPEG_QUALITY = 80;

@Injectable()
export class ThumbnailService {
  private readonly logger = new Logger(ThumbnailService.name);
  private readonly s3Client: S3Client;
  private readonly bucketName: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
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

  /**
   * Generates a 400×400 cover-cropped JPEG thumbnail for an uploaded photo.
   * Returns the thumbnail S3 key, or null if skipped or on failure (never throws).
   */
  async generateThumbnailForFile(fileId: string): Promise<string | null> {
    try {
      const file = await this.prisma.mediaFile.findUnique({
        where: { id: fileId },
      });

      if (file === null) {
        this.logger.warn(`Thumbnail skipped: file ${fileId} not found`);
        return null;
      }
      if (file.fileType !== FileType.PHOTO) {
        return null;
      }
      if (file.uploadStatus !== UploadStatus.UPLOADED) {
        return null;
      }

      const originalBuffer = await this.downloadObjectAsBuffer(file.s3Key);
      const thumbnailBuffer = await sharp(originalBuffer)
        .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, {
          fit: 'cover',
          position: 'centre',
        })
        .jpeg({ quality: THUMBNAIL_JPEG_QUALITY })
        .toBuffer();

      const thumbnailS3Key = this.deriveThumbnailS3Key(file.s3Key);

      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: thumbnailS3Key,
          Body: thumbnailBuffer,
          ContentType: 'image/jpeg',
        }),
      );

      await this.prisma.mediaFile.update({
        where: { id: fileId },
        data: { thumbnailS3Key },
      });

      return thumbnailS3Key;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Thumbnail generation failed for file ${fileId}: ${message}`,
      );
      return null;
    }
  }

  /** users/{uid}/raw/{name} → users/{uid}/thumbnails/{name} */
  deriveThumbnailS3Key(originalS3Key: string): string {
    const marker = '/raw/';
    const idx = originalS3Key.indexOf(marker);
    if (idx === -1) {
      throw new Error(
        `Cannot derive thumbnail key from s3Key (missing "${marker}"): ${originalS3Key}`,
      );
    }
    return (
      originalS3Key.slice(0, idx) +
      '/thumbnails/' +
      originalS3Key.slice(idx + marker.length)
    );
  }

  private async downloadObjectAsBuffer(s3Key: string): Promise<Buffer> {
    const response = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
      }),
    );

    if (response.Body === undefined) {
      throw new Error(`Empty S3 object body for key ${s3Key}`);
    }

    const bytes = await response.Body.transformToByteArray();
    return Buffer.from(bytes);
  }
}
