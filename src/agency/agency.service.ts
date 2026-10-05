import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AgencyMembership,
  AgencyRole,
  MembershipStatus,
  Prisma,
  UploadStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const agencyFileFolderInclude = {
  folder: { select: { id: true, name: true } },
} satisfies Prisma.MediaFileInclude;

export type AgencyFolderWithFileCount = Prisma.FolderGetPayload<{
  include: { _count: { select: { files: true } } };
}>;

type AgencyFolderWithFiles = Prisma.FolderGetPayload<{
  include: { files: { include: typeof agencyFileFolderInclude } };
}>;

type AgencyMediaFile = Prisma.MediaFileGetPayload<{
  include: typeof agencyFileFolderInclude;
}>;

/** API shape: BigInt sizeBytes as string for JSON clients. */
type SerializedAgencyMediaFile = Omit<AgencyMediaFile, 'sizeBytes'> & {
  sizeBytes: string;
};

export type SerializedAgencyFolderWithFiles = Omit<
  AgencyFolderWithFiles,
  'files'
> & {
  files: SerializedAgencyMediaFile[];
};

@Injectable()
export class AgencyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Authorizes the user against an agency. Throws unless an ACTIVE membership
   * exists. This is the single gate every agency-scoped read/write must pass
   * through.
   */
  async assertAgencyMembership(
    userId: string,
    agencyId: string,
  ): Promise<AgencyMembership> {
    const membership = await this.prisma.agencyMembership.findUnique({
      where: { agencyId_userId: { agencyId, userId } },
    });
    if (membership === null) {
      throw new ForbiddenException('Agency not accessible');
    }
    if (membership.status !== MembershipStatus.ACTIVE) {
      throw new ForbiddenException('Agency not accessible');
    }
    return membership;
  }

  /**
   * Authorizes the user as STAFF of an agency. Passes the active-membership
   * gate first, then requires the STAFF role.
   */
  async assertAgencyStaff(
    userId: string,
    agencyId: string,
  ): Promise<AgencyMembership> {
    const membership = await this.assertAgencyMembership(userId, agencyId);
    if (membership.role !== AgencyRole.STAFF) {
      throw new ForbiddenException('Agency staff access required');
    }
    return membership;
  }

  async getAgencyFolders(
    userId: string,
    agencyId: string,
  ): Promise<AgencyFolderWithFileCount[]> {
    await this.assertAgencyMembership(userId, agencyId);

    return this.prisma.folder.findMany({
      where: { agencyId, ownerId: userId },
      include: {
        _count: {
          select: {
            files: { where: { uploadStatus: UploadStatus.UPLOADED } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getAgencyFolderById(
    userId: string,
    folderId: string,
  ): Promise<SerializedAgencyFolderWithFiles> {
    const folder = await this.prisma.folder.findUnique({
      where: { id: folderId },
      include: {
        files: {
          where: { uploadStatus: UploadStatus.UPLOADED },
          orderBy: { createdAt: 'desc' },
          include: agencyFileFolderInclude,
        },
      },
    });
    if (folder === null || folder.agencyId === null) {
      throw new NotFoundException('Folder not found');
    }

    await this.assertAgencyMembership(userId, folder.agencyId);

    if (folder.ownerId !== userId) {
      throw new NotFoundException('Folder not found');
    }

    return {
      ...folder,
      files: folder.files.map((file) => this.serializeMediaFile(file)),
    };
  }

  private serializeMediaFile(file: AgencyMediaFile): SerializedAgencyMediaFile {
    const { sizeBytes, ...rest } = file;
    return {
      ...rest,
      sizeBytes: sizeBytes.toString(),
    };
  }
}
