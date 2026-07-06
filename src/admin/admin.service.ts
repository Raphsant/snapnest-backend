import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Agency,
  AgencyMembership,
  AgencyRole,
  Folder,
  FolderType,
  Prisma,
  UploadStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAgencyDto } from './dto/create-agency.dto';
import { CreateAgencyFolderDto } from './dto/create-agency-folder.dto';
import { CreateMembershipDto } from './dto/create-membership.dto';

/** Same TTL as the owner-scoped view-urls endpoint (uploads.service). */
const VIEW_URL_TTL_SECONDS = 60 * 60;

/** Public user fields safe for the admin panel — never cognitoSub. */
const adminUserSelect = {
  id: true,
  email: true,
  firstName: true,
} satisfies Prisma.UserSelect;

const uploadedFilesCount = {
  _count: {
    select: {
      files: { where: { uploadStatus: UploadStatus.UPLOADED } },
    },
  },
} satisfies Prisma.FolderInclude;

const adminFileOwnerInclude = {
  owner: { select: adminUserSelect },
} satisfies Prisma.MediaFileInclude;

export type AdminAgencyListItem = Prisma.AgencyGetPayload<{
  include: { _count: { select: { memberships: true; folders: true } } };
}>;

export type AdminAgencyMember = Prisma.AgencyMembershipGetPayload<{
  include: { user: { select: typeof adminUserSelect } };
}>;

export type AdminAgencyFolder = Prisma.FolderGetPayload<{
  include: typeof uploadedFilesCount;
}>;

type AdminFolderWithFiles = Prisma.FolderGetPayload<{
  include: { files: { include: typeof adminFileOwnerInclude } };
}>;

type AdminMediaFile = Prisma.MediaFileGetPayload<{
  include: typeof adminFileOwnerInclude;
}>;

/** API shape: BigInt sizeBytes as string for JSON clients. */
type SerializedAdminMediaFile = Omit<AdminMediaFile, 'sizeBytes'> & {
  sizeBytes: string;
};

export type SerializedAdminFolderWithFiles = Omit<
  AdminFolderWithFiles,
  'files'
> & {
  files: SerializedAdminMediaFile[];
};

export interface AdminBatchFileViewUrlItem {
  fileId: string;
  fullUrl: string;
  thumbnailUrl: string | null;
}

@Injectable()
export class AdminService {
  private readonly s3Client: S3Client;
  private readonly bucketName: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    // Own S3 presigner (same env config as UploadsService) — reusing
    // UploadsService would mean exporting it and adding admin-scoped methods
    // to the files module, which this module must not touch.
    this.s3Client = new S3Client({
      region: this.configService.get<string>('AWS_REGION', ''),
      credentials: {
        accessKeyId: this.configService.get<string>('AWS_ACCESS_KEY_ID', ''),
        secretAccessKey: this.configService.get<string>(
          'AWS_SECRET_ACCESS_KEY',
          '',
        ),
      },
    });
    this.bucketName = this.configService.get<string>('S3_BUCKET', '');
  }

  async createAgency(dto: CreateAgencyDto): Promise<Agency> {
    return this.prisma.agency.create({
      data: { name: dto.name.trim() },
    });
  }

  async createMembership(dto: CreateMembershipDto): Promise<AgencyMembership> {
    const agency = await this.prisma.agency.findUnique({
      where: { id: dto.agencyId },
    });
    if (agency === null) {
      throw new NotFoundException('Agency not found');
    }

    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.trim().toLowerCase() },
    });
    if (user === null) {
      throw new NotFoundException('User not found for the provided email');
    }

    try {
      return await this.prisma.agencyMembership.create({
        data: {
          agencyId: dto.agencyId,
          userId: user.id,
          role: dto.role ?? AgencyRole.CLIENT,
        },
      });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('User is already a member of this agency');
      }
      throw error;
    }
  }

  async createAgencyFolder(
    agencyId: string,
    creatorUserId: string,
    dto: CreateAgencyFolderDto,
  ): Promise<Folder> {
    const agency = await this.prisma.agency.findUnique({
      where: { id: agencyId },
    });
    if (agency === null) {
      throw new NotFoundException('Agency not found');
    }

    return this.prisma.folder.create({
      data: {
        ownerId: creatorUserId,
        agencyId,
        name: dto.name.trim(),
        type: dto.type ?? FolderType.AGENCY_INTAKE,
      },
    });
  }

  // ── Read-only admin panel queries ──────────────────────────────────────

  async listAgencies(): Promise<AdminAgencyListItem[]> {
    return this.prisma.agency.findMany({
      include: {
        _count: { select: { memberships: true, folders: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getAgencyMembers(agencyId: string): Promise<AdminAgencyMember[]> {
    await this.assertAgencyExists(agencyId);

    return this.prisma.agencyMembership.findMany({
      where: { agencyId },
      include: { user: { select: adminUserSelect } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getAgencyFolders(agencyId: string): Promise<AdminAgencyFolder[]> {
    await this.assertAgencyExists(agencyId);

    return this.prisma.folder.findMany({
      where: { agencyId },
      include: uploadedFilesCount,
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Agency folder contents with submitter identity per file.
   * 404s for personal folders (agencyId IS NULL) — invisible to this module.
   */
  async getAgencyFolderContents(
    folderId: string,
  ): Promise<SerializedAdminFolderWithFiles> {
    const folder = await this.prisma.folder.findUnique({
      where: { id: folderId },
      include: {
        files: {
          where: { uploadStatus: UploadStatus.UPLOADED },
          orderBy: { createdAt: 'desc' },
          include: adminFileOwnerInclude,
        },
      },
    });
    if (folder === null || folder.agencyId === null) {
      throw new NotFoundException('Folder not found');
    }

    return {
      ...folder,
      files: folder.files.map((file) => this.serializeMediaFile(file)),
    };
  }

  /**
   * Batched presigned GET URLs, admin scope: agency files only. Personal
   * files (agencyId IS NULL) are silently omitted from the results, matching
   * the omission behavior of the owner-scoped batch endpoint.
   */
  async getAdminBatchViewUrls(
    fileIds: string[],
  ): Promise<AdminBatchFileViewUrlItem[]> {
    const files = await this.prisma.mediaFile.findMany({
      where: {
        id: { in: fileIds },
        agencyId: { not: null },
        uploadStatus: UploadStatus.UPLOADED,
      },
    });

    const results: AdminBatchFileViewUrlItem[] = [];
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

  private async assertAgencyExists(agencyId: string): Promise<void> {
    const agency = await this.prisma.agency.findUnique({
      where: { id: agencyId },
      select: { id: true },
    });
    if (agency === null) {
      throw new NotFoundException('Agency not found');
    }
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

  private serializeMediaFile(file: AdminMediaFile): SerializedAdminMediaFile {
    const { sizeBytes, ...rest } = file;
    return {
      ...rest,
      sizeBytes: sizeBytes.toString(),
    };
  }
}
