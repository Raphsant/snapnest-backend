import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../auth/current-user.decorator';
import {
  AgencyFolderWithFileCount,
  AgencyService,
  SerializedAgencyFolderWithFiles,
} from './agency.service';

@Controller('agency')
@UseGuards(AuthGuard)
export class AgencyController {
  constructor(private readonly agencyService: AgencyService) {}

  @Get('folders/:folderId')
  getAgencyFolder(
    @CurrentUserId() userId: string,
    @Param('folderId') folderId: string,
  ): Promise<SerializedAgencyFolderWithFiles> {
    return this.agencyService.getAgencyFolderById(userId, folderId);
  }

  @Get(':agencyId/folders')
  getAgencyFolders(
    @CurrentUserId() userId: string,
    @Param('agencyId') agencyId: string,
  ): Promise<AgencyFolderWithFileCount[]> {
    return this.agencyService.getAgencyFolders(userId, agencyId);
  }
}
