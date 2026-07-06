import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Agency, AgencyMembership, Folder } from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../auth/current-user.decorator';
import { AdminGuard } from './admin.guard';
import {
  AdminAgencyFolder,
  AdminAgencyListItem,
  AdminAgencyMember,
  AdminBatchFileViewUrlItem,
  AdminService,
  SerializedAdminFolderWithFiles,
} from './admin.service';
import { AdminBatchViewUrlsDto } from './dto/admin-batch-view-urls.dto';
import { CreateAgencyDto } from './dto/create-agency.dto';
import { CreateAgencyFolderDto } from './dto/create-agency-folder.dto';
import { CreateMembershipDto } from './dto/create-membership.dto';

@Controller('admin')
@UseGuards(AuthGuard, AdminGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Post('agencies')
  createAgency(@Body() dto: CreateAgencyDto): Promise<Agency> {
    return this.adminService.createAgency(dto);
  }

  @Post('agency-memberships')
  createMembership(
    @Body() dto: CreateMembershipDto,
  ): Promise<AgencyMembership> {
    return this.adminService.createMembership(dto);
  }

  @Post('agencies/:agencyId/folders')
  createAgencyFolder(
    @CurrentUserId() userId: string,
    @Param('agencyId') agencyId: string,
    @Body() dto: CreateAgencyFolderDto,
  ): Promise<Folder> {
    return this.adminService.createAgencyFolder(agencyId, userId, dto);
  }

  // ── Read-only admin panel endpoints ────────────────────────────────────

  @Get('agencies')
  listAgencies(): Promise<AdminAgencyListItem[]> {
    return this.adminService.listAgencies();
  }

  @Get('agencies/:agencyId/members')
  getAgencyMembers(
    @Param('agencyId') agencyId: string,
  ): Promise<AdminAgencyMember[]> {
    return this.adminService.getAgencyMembers(agencyId);
  }

  @Get('agencies/:agencyId/folders')
  getAgencyFolders(
    @Param('agencyId') agencyId: string,
  ): Promise<AdminAgencyFolder[]> {
    return this.adminService.getAgencyFolders(agencyId);
  }

  @Get('folders/:folderId')
  getAgencyFolderContents(
    @Param('folderId') folderId: string,
  ): Promise<SerializedAdminFolderWithFiles> {
    return this.adminService.getAgencyFolderContents(folderId);
  }

  /** Read-only semantics — POST only for the request body. */
  @Post('files/view-urls')
  getAdminBatchViewUrls(
    @Body() dto: AdminBatchViewUrlsDto,
  ): Promise<AdminBatchFileViewUrlItem[]> {
    return this.adminService.getAdminBatchViewUrls(dto.fileIds);
  }
}
