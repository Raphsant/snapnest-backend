import { Controller, Get, UseGuards } from '@nestjs/common';
import { AccountType } from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { AgencyMembershipSummary, UsersService } from './users.service';

export interface MeResponse {
  id: string;
  email: string;
  firstName: string | null;
  accountType: AccountType;
  memberships: AgencyMembershipSummary[];
}

@Controller()
@UseGuards(AuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  async getMe(@CurrentUser() user: AuthenticatedUser): Promise<MeResponse> {
    const memberships = await this.usersService.getMembershipsForUser(user.id);
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      accountType: user.accountType,
      memberships,
    };
  }
}
