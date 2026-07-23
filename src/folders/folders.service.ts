import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Folder, FolderType, Prisma, UploadStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';
import { CreateFolderDto } from './dto/create-folder.dto';
import { UpdateFolderDto } from './dto/update-folder.dto';

export type FolderWithFileCount = Prisma.FolderGetPayload<{
  include: { _count: { select: { files: true } } };
}>;

export type FolderWithFiles = Prisma.FolderGetPayload<{
  include: { files: true };
}>;

@Injectable()
export class FoldersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uploadsService: UploadsService,
  ) {}

  async createFolder(userId: string, dto: CreateFolderDto): Promise<Folder> {
    if (dto.parentFolderId !== undefined) {
      const parent = await this.prisma.folder.findUnique({
        where: { id: dto.parentFolderId },
      });
      if (parent === null) {
        throw new NotFoundException('Parent folder not found');
      }
      if (parent.ownerId !== userId) {
        throw new ForbiddenException('Parent folder not accessible');
      }
    }

    return this.prisma.folder.create({
      data: {
        ownerId: userId,
        name: dto.name.trim(),
        type: dto.type ?? FolderType.PERSONAL,
        parentFolderId: dto.parentFolderId ?? null,
      },
    });
  }

  async getUserFolders(userId: string): Promise<FolderWithFileCount[]> {
    return this.prisma.folder.findMany({
      where: { ownerId: userId, agencyId: null },
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

  async getFolderById(
    folderId: string,
    userId: string,
  ): Promise<FolderWithFiles> {
    const folder = await this.prisma.folder.findUnique({
      where: { id: folderId },
      include: {
        files: {
          where: { uploadStatus: UploadStatus.UPLOADED },
          orderBy: { createdAt: 'desc' },
          include: { folder: { select: { id: true, name: true } } },
        },
      },
    });
    if (folder === null || folder.agencyId !== null) {
      throw new NotFoundException('Folder not found');
    }
    if (folder.ownerId !== userId) {
      throw new ForbiddenException('Folder not accessible');
    }
    return folder;
  }

  async updateFolder(
    folderId: string,
    userId: string,
    dto: UpdateFolderDto,
  ): Promise<Folder> {
    const folder = await this.prisma.folder.findUnique({
      where: { id: folderId },
    });
    if (folder === null) {
      throw new NotFoundException('Folder not found');
    }
    if (folder.ownerId !== userId) {
      throw new ForbiddenException('Folder not accessible');
    }
    if (folder.isSystem) {
      throw new BadRequestException('System folders cannot be renamed');
    }

    return this.prisma.folder.update({
      where: { id: folderId },
      data: { name: dto.name.trim() },
    });
  }

  async deleteFolder(folderId: string, userId: string): Promise<void> {
    const folder = await this.prisma.folder.findUnique({
      where: { id: folderId },
    });
    if (folder === null) {
      throw new NotFoundException('Folder not found');
    }
    if (folder.ownerId !== userId) {
      throw new ForbiddenException('Folder not accessible');
    }
    if (folder.isSystem) {
      throw new BadRequestException('System folders cannot be deleted');
    }

    // Agency folders are tenant-scoped: their files must never be swept into
    // the owner's personal Unfiled folder. Block deletion while non-empty
    // (counting ALL files, ghosts included) so the DB-level ON DELETE SET NULL
    // can't silently orphan agency files.
    if (folder.agencyId !== null) {
      const fileCount = await this.prisma.mediaFile.count({
        where: { folderId },
      });
      if (fileCount > 0) {
        throw new ConflictException(
          'Folder contains files. Move or delete them before deleting the folder.',
        );
      }
      await this.prisma.folder.delete({ where: { id: folderId } });
      return;
    }

    // Personal folder: sweep every contained file (UPLOADED and non-UPLOADED
    // ghosts alike) into the owner's system Unfiled folder so nothing is
    // orphaned to folderId = null. Resolve the Unfiled id BEFORE opening the
    // transaction — the helper's create/catch-P2002/refetch pattern can't run
    // inside a Postgres transaction, where a failed insert aborts the whole tx.
    const unfiledFolderId =
      await this.uploadsService.findOrCreateUnfiledFolder(userId);
    if (unfiledFolderId === folderId) {
      // Unreachable given the isSystem guard above (Unfiled is isSystem=true),
      // but assert rather than sweep a folder into itself.
      throw new BadRequestException('Cannot delete the Unfiled folder');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.mediaFile.updateMany({
        where: { folderId },
        data: { folderId: unfiledFolderId },
      });
      await tx.folder.delete({
        where: { id: folderId },
      });
    });
  }
}
