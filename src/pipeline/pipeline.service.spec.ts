import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PipelineJob, PipelineJobStatus, Prisma } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { ThumbnailService } from '../uploads/thumbnail.service';
import { PipelineService } from './pipeline.service';

jest.mock('../notifications/notifications.service', () => ({
  NotificationsService: jest.fn(),
}));

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'test-uuid'),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: jest.fn() })),
  CopyObjectCommand: jest.fn(),
  DeleteObjectCommand: jest.fn(),
  GetObjectCommand: jest.fn(),
  HeadObjectCommand: jest.fn(),
  ListObjectsV2Command: jest.fn(),
}));

const mockSqsSend = jest.fn().mockResolvedValue({});

jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: jest.fn(() => ({ send: mockSqsSend })),
  SendMessageCommand: jest.fn(),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

describe('PipelineService', () => {
  let service: PipelineService;
  let findUnique: jest.Mock;
  let updateMany: jest.Mock;

  const completeClip = {
    id: 'clip-1',
    approved: true,
    hook_asset_id: 'asset-hook-1',
    outro_asset_id: 'asset-outro-1',
    hook_text: 'Hook line',
    close_text: 'Close line',
    post_copy: 'Post copy',
  };

  const buildJob = (
    manifest: Prisma.JsonObject | null,
    status: PipelineJobStatus = PipelineJobStatus.AWAITING_CREATIVE_APPROVAL,
  ): PipelineJob =>
    ({
      id: 'job-1',
      status,
      manifest,
    }) as unknown as PipelineJob;

  beforeEach(() => {
    mockSqsSend.mockClear();
    findUnique = jest.fn();
    updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      pipelineJob: { findUnique, updateMany, update: jest.fn() },
    } as unknown as PrismaService;
    const configService = {
      getOrThrow: jest.fn().mockReturnValue('test-value'),
    } as unknown as ConfigService;
    service = new PipelineService(
      prisma,
      {} as unknown as ThumbnailService,
      {} as unknown as NotificationsService,
      configService,
    );
  });

  describe('approveCreative', () => {
    it('approves when every approved clip has the v2 creative fields', async () => {
      const job = buildJob({ clips: [completeClip] });
      findUnique.mockResolvedValue(job);

      await expect(service.approveCreative('job-1')).resolves.toBe(job);

      expect(updateMany).toHaveBeenCalledWith({
        where: {
          id: 'job-1',
          status: PipelineJobStatus.AWAITING_CREATIVE_APPROVAL,
        },
        data: { status: PipelineJobStatus.CREATIVE_APPROVED },
      });
    });

    it('409s listing clip id and missing field when hook_asset_id is absent', async () => {
      const clipWithoutHookAsset = { ...completeClip, hook_asset_id: null };
      findUnique.mockResolvedValue(buildJob({ clips: [clipWithoutHookAsset] }));

      await expect(service.approveCreative('job-1')).rejects.toThrow(
        new ConflictException(
          'creative fields incomplete for clip ids: clip-1 (missing hook_asset_id)',
        ),
      );
      expect(updateMany).not.toHaveBeenCalled();
    });
  });

  describe('reopenJob', () => {
    it('flips a COMPLETED job back to AWAITING_MANIFEST_APPROVAL and clears error', async () => {
      const job = buildJob(
        { clips: [completeClip] },
        PipelineJobStatus.COMPLETED,
      );
      findUnique.mockResolvedValue(job);

      await expect(service.reopenJob('job-1')).resolves.toBe(job);

      expect(updateMany).toHaveBeenCalledWith({
        where: { id: 'job-1', status: PipelineJobStatus.COMPLETED },
        data: {
          status: PipelineJobStatus.AWAITING_MANIFEST_APPROVAL,
          error: null,
        },
      });
      expect(mockSqsSend).not.toHaveBeenCalled();
    });

    it('409s when the job is not COMPLETED', async () => {
      findUnique
        .mockResolvedValueOnce(
          buildJob({ clips: [completeClip] }, PipelineJobStatus.RUNNING),
        )
        .mockResolvedValueOnce({ status: PipelineJobStatus.RUNNING });
      updateMany.mockResolvedValue({ count: 0 });

      await expect(service.reopenJob('job-1')).rejects.toThrow(
        new ConflictException(
          'Pipeline job job-1 cannot be reopened while its status is RUNNING',
        ),
      );
      expect(mockSqsSend).not.toHaveBeenCalled();
    });

    it('409s when the manifest is null', async () => {
      findUnique.mockResolvedValue(buildJob(null, PipelineJobStatus.COMPLETED));

      await expect(service.reopenJob('job-1')).rejects.toThrow(
        new ConflictException(
          'Pipeline job job-1 cannot be reopened without a valid manifest',
        ),
      );
      expect(updateMany).not.toHaveBeenCalled();
      expect(mockSqsSend).not.toHaveBeenCalled();
    });
  });
});
