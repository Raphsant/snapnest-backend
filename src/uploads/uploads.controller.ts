import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../auth/current-user.decorator';
import { BatchViewUrlsDto } from './dto/batch-view-urls.dto';
import { CreateUploadDto } from './dto/create-upload.dto';
import { ListFilesQueryDto } from './dto/list-files-query.dto';
import { MoveFileToFolderDto } from './dto/move-file-to-folder.dto';
import {
  BatchFileViewUrlItem,
  DeleteFileResult,
  FileViewUrlResponse,
  PresignedUploadResponse,
  SerializedMediaFile,
  UploadsService,
} from './uploads.service';

@Controller('uploads')
@UseGuards(AuthGuard)
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post()
  async createUpload(
    @Body() dto: CreateUploadDto,
    @CurrentUserId() userId: string,
  ): Promise<PresignedUploadResponse> {
    return this.uploadsService.createPresignedUploadUrl(userId, dto);
  }

  @Post(':uploadId/complete')
  async completeUpload(
    @Param('uploadId') uploadId: string,
    @CurrentUserId() userId: string,
  ): Promise<SerializedMediaFile> {
    return this.uploadsService.completeUpload(uploadId, userId);
  }
}

@Controller('files')
@UseGuards(AuthGuard)
export class FilesController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Get()
  async listFiles(
    @CurrentUserId() userId: string,
    @Query() query: ListFilesQueryDto,
  ): Promise<SerializedMediaFile[]> {
    return this.uploadsService.getUserFiles(userId, {
      folderId: query.folderId,
      limit: query.limit,
      before: query.before,
    });
  }

  @Patch(':fileId/folder')
  async moveFileToFolder(
    @CurrentUserId() userId: string,
    @Param('fileId') fileId: string,
    @Body() dto: MoveFileToFolderDto,
  ): Promise<SerializedMediaFile> {
    return this.uploadsService.moveFileToFolder(userId, fileId, dto.folderId);
  }

  @Delete(':fileId')
  async deleteFile(
    @CurrentUserId() userId: string,
    @Param('fileId') fileId: string,
  ): Promise<DeleteFileResult> {
    return this.uploadsService.deleteFile(userId, fileId);
  }

  @Get(':fileId/view-url')
  async getFileViewUrl(
    @CurrentUserId() userId: string,
    @Param('fileId') fileId: string,
  ): Promise<FileViewUrlResponse> {
    return this.uploadsService.getFileViewUrl(fileId, userId);
  }

  @Post('view-urls')
  async getBatchViewUrls(
    @CurrentUserId() userId: string,
    @Body() dto: BatchViewUrlsDto,
  ): Promise<BatchFileViewUrlItem[]> {
    return this.uploadsService.getBatchViewUrls(
      userId,
      dto.fileIds,
      dto.agencyId,
    );
  }
}
