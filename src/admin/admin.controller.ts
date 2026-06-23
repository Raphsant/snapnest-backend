import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { Agency, AgencyMembership, Folder } from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../auth/current-user.decorator';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
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
}
