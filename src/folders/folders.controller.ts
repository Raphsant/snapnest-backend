import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Folder } from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../auth/current-user.decorator';
import { CreateFolderDto } from './dto/create-folder.dto';
import { UpdateFolderDto } from './dto/update-folder.dto';
import {
  FolderWithFileCount,
  FolderWithFiles,
  FoldersService,
} from './folders.service';

@Controller('folders')
@UseGuards(AuthGuard)
export class FoldersController {
  constructor(private readonly foldersService: FoldersService) {}

  @Get()
  getFolders(@CurrentUserId() userId: string): Promise<FolderWithFileCount[]> {
    return this.foldersService.getUserFolders(userId);
  }

  @Post()
  createFolder(
    @CurrentUserId() userId: string,
    @Body() dto: CreateFolderDto,
  ): Promise<Folder> {
    return this.foldersService.createFolder(userId, dto);
  }

  @Patch(':id')
  updateFolder(
    @CurrentUserId() userId: string,
    @Param('id') folderId: string,
    @Body() dto: UpdateFolderDto,
  ): Promise<Folder> {
    return this.foldersService.updateFolder(folderId, userId, dto);
  }

  @Get(':id')
  getFolder(
    @CurrentUserId() userId: string,
    @Param('id') folderId: string,
  ): Promise<FolderWithFiles> {
    return this.foldersService.getFolderById(folderId, userId);
  }

  @Delete(':id')
  async deleteFolder(
    @CurrentUserId() userId: string,
    @Param('id') folderId: string,
  ): Promise<{ success: true }> {
    await this.foldersService.deleteFolder(folderId, userId);
    return { success: true };
  }
}
