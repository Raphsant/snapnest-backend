import { Injectable } from '@nestjs/common';
import { AgencyRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AgencyMembershipSummary {
  agencyId: string;
  agencyName: string;
  role: AgencyRole;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async getMembershipsForUser(
    userId: string,
  ): Promise<AgencyMembershipSummary[]> {
    const memberships = await this.prisma.agencyMembership.findMany({
      where: { userId },
      include: { agency: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return memberships.map((membership) => ({
      agencyId: membership.agencyId,
      agencyName: membership.agency.name,
      role: membership.role,
    }));
  }
}
