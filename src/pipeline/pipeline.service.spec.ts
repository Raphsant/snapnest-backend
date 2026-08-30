import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
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

const mockS3Send = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
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
  let jobFindMany: jest.Mock;
  let deliveryFindMany: jest.Mock;
  let postFindMany: jest.Mock;
  let postUpsert: jest.Mock;
  let postDeleteMany: jest.Mock;

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
    mockS3Send.mockReset();
    (getSignedUrl as jest.Mock).mockResolvedValue('https://signed.example/clip');
    findUnique = jest.fn();
    updateMany = jest.fn().mockResolvedValue({ count: 1 });
    jobFindMany = jest.fn().mockResolvedValue([]);
    deliveryFindMany = jest.fn().mockResolvedValue([]);
    postFindMany = jest.fn().mockResolvedValue([]);
    postUpsert = jest.fn();
    postDeleteMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      pipelineJob: {
        findUnique,
        findMany: jobFindMany,
        updateMany,
        update: jest.fn(),
      },
      pipelineDelivery: { findMany: deliveryFindMany },
      pipelineOutputPost: {
        findMany: postFindMany,
        upsert: postUpsert,
        deleteMany: postDeleteMany,
      },
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

  describe('output posted flag', () => {
    const outputKey = 'pipeline/job-1/final/final_clip-1_9x16.mp4';
    const postedAt = new Date('2026-08-29T12:00:00.000Z');

    // assertOutputExists issues a HeadObject; getJobOutputs then issues a
    // ListObjectsV2. Each test drives them in call order.
    const headThenList = () =>
      mockS3Send
        .mockResolvedValueOnce({ ContentLength: 1024 })
        .mockResolvedValueOnce({
          Contents: [{ Key: outputKey, Size: 1024 }],
        });

    it('surfaces postedAt on getJobOutputs after setOutputPosted', async () => {
      findUnique.mockResolvedValue({ id: 'job-1' });
      headThenList();
      postUpsert.mockResolvedValue({ clipId: 'clip-1', postedAt });
      postFindMany.mockResolvedValue([{ clipId: 'clip-1', postedAt }]);

      await expect(
        service.setOutputPosted('job-1', 'clip-1', {}),
      ).resolves.toEqual({
        clipId: 'clip-1',
        postedAt: postedAt.toISOString(),
      });

      const outputs = await service.getJobOutputs('job-1');
      expect(outputs).toHaveLength(1);
      expect(outputs[0].clipId).toBe('clip-1');
      expect(outputs[0].postedAt).toBe(postedAt.toISOString());
    });

    it('reports null on getJobOutputs after clearOutputPosted', async () => {
      findUnique.mockResolvedValue({ id: 'job-1' });
      headThenList();
      postFindMany.mockResolvedValue([]);

      await expect(
        service.clearOutputPosted('job-1', 'clip-1'),
      ).resolves.toBeUndefined();
      expect(postDeleteMany).toHaveBeenCalledWith({
        where: { jobId: 'job-1', clipId: 'clip-1' },
      });

      const outputs = await service.getJobOutputs('job-1');
      expect(outputs).toHaveLength(1);
      expect(outputs[0].postedAt).toBeNull();
    });

    it('404s when the assembled output is not in S3', async () => {
      findUnique.mockResolvedValue({ id: 'job-1' });
      mockS3Send.mockRejectedValue({ name: 'NotFound' });

      await expect(
        service.setOutputPosted('job-1', 'clip-1', {}),
      ).rejects.toThrow(new NotFoundException('Output not found'));
      expect(postUpsert).not.toHaveBeenCalled();
    });

    it('upserts on a repeat set instead of creating a second row', async () => {
      findUnique.mockResolvedValue({ id: 'job-1' });
      mockS3Send.mockResolvedValue({ ContentLength: 1024 });
      postUpsert.mockResolvedValue({ clipId: 'clip-1', postedAt });

      await service.setOutputPosted('job-1', 'clip-1', {});
      await service.setOutputPosted('job-1', 'clip-1', {
        postedAt: '2026-08-30T09:00:00.000Z',
      });

      expect(postUpsert).toHaveBeenCalledTimes(2);
      // The second call targets the same unique key and carries the explicit
      // timestamp — an update of one row, never an insert of a second.
      expect(postUpsert).toHaveBeenNthCalledWith(2, {
        where: { jobId_clipId: { jobId: 'job-1', clipId: 'clip-1' } },
        create: {
          jobId: 'job-1',
          clipId: 'clip-1',
          postedAt: new Date('2026-08-30T09:00:00.000Z'),
        },
        update: { postedAt: new Date('2026-08-30T09:00:00.000Z') },
      });
    });
  });

  describe('approveJob clip cap', () => {
    const buildManifestClips = (count: number): Prisma.JsonObject[] =>
      Array.from({ length: count }, (_, index) => ({
        id: `clip-${index + 1}`,
        approved: null,
      }));

    const buildApprovals = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        clipId: `clip-${index + 1}`,
        approved: true,
      }));

    it('409s naming the count when more than 10 clips are approved', async () => {
      findUnique.mockResolvedValue(
        buildJob(
          { clips: buildManifestClips(11) },
          PipelineJobStatus.AWAITING_MANIFEST_APPROVAL,
        ),
      );

      await expect(
        service.approveJob('job-1', { approvals: buildApprovals(11) }),
      ).rejects.toThrow(
        new ConflictException(
          'at most 10 clips can be approved per job; got 11',
        ),
      );
      expect(updateMany).not.toHaveBeenCalled();
      expect(mockSqsSend).not.toHaveBeenCalled();
    });

    it('accepts exactly 10 approved clips', async () => {
      const job = buildJob(
        { clips: buildManifestClips(10) },
        PipelineJobStatus.AWAITING_MANIFEST_APPROVAL,
      );
      findUnique.mockResolvedValue(job);

      await expect(
        service.approveJob('job-1', { approvals: buildApprovals(10) }),
      ).resolves.toBe(job);
      expect(updateMany).toHaveBeenCalled();
      expect(mockSqsSend).toHaveBeenCalled();
    });
  });

  describe('listOutputs', () => {
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    const assembled = (completedAt: string) => ({
      s3Key: 'pipeline/job-1/final/final_clip_9x16.mp4',
      completedAt,
    });

    const jobRow = (
      id: string,
      manifest: Prisma.JsonValue,
      createdAt = '2026-08-01T00:00:00.000Z',
    ) => ({ id, manifest, createdAt: new Date(createdAt) });

    const twoClipJob = () =>
      jobRow('job-1', {
        clips: [
          {
            id: 'clip-1',
            approved: true,
            assembled: assembled('2026-08-02T00:00:00.000Z'),
          },
          {
            id: 'clip-2',
            approved: true,
            assembled: assembled('2026-08-03T00:00:00.000Z'),
          },
        ],
      });

    const clip2Posted = [
      {
        jobId: 'job-1',
        clipId: 'clip-2',
        postedAt: new Date('2026-08-04T00:00:00.000Z'),
      },
    ];

    it('returns only outputs with no posted row when posted=false', async () => {
      jobFindMany.mockResolvedValue([twoClipJob()]);
      postFindMany.mockResolvedValue(clip2Posted);

      const result = await service.listOutputs({ posted: false });

      expect(result.total).toBe(1);
      expect(result.items).toEqual([
        {
          jobId: 'job-1',
          clipId: 'clip-1',
          postedAt: null,
          completedAt: '2026-08-02T00:00:00.000Z',
          jobCreatedAt: '2026-08-01T00:00:00.000Z',
        },
      ]);
    });

    it('returns posted and unposted together when posted is absent', async () => {
      jobFindMany.mockResolvedValue([twoClipJob()]);
      postFindMany.mockResolvedValue(clip2Posted);

      const result = await service.listOutputs({});

      expect(result.total).toBe(2);
      // Newest completedAt first.
      expect(result.items.map((item) => item.clipId)).toEqual([
        'clip-2',
        'clip-1',
      ]);
      expect(result.items[0].postedAt).toBe('2026-08-04T00:00:00.000Z');
      expect(result.items[1].postedAt).toBeNull();
      expect(result.limit).toBe(50);
      expect(result.offset).toBe(0);
    });

    it('skips unreadable manifests and checkpoints without throwing', async () => {
      jobFindMany.mockResolvedValue([
        // Manifest this API cannot parse — warned about, never thrown on.
        jobRow('job-bad', { clips: 'not-an-array' }),
        // Queued job, no manifest at all.
        jobRow('job-null', null),
        jobRow('job-2', {
          clips: [
            // No checkpoint: not assembled yet.
            { id: 'clip-a', approved: true },
            // Checkpoint is not an object.
            { id: 'clip-b', approved: true, assembled: 'nope' },
            // Checkpoint object missing the s3Key validity gate.
            {
              id: 'clip-c',
              approved: true,
              assembled: { completedAt: '2026-08-05T00:00:00.000Z' },
            },
            // The only real output in the set.
            {
              id: 'clip-d',
              approved: true,
              assembled: assembled('2026-08-06T00:00:00.000Z'),
            },
          ],
        }),
      ]);
      postFindMany.mockResolvedValue([]);

      const result = await service.listOutputs({});

      expect(result.total).toBe(1);
      expect(result.items[0].clipId).toBe('clip-d');
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });
});
