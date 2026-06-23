import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Agency,
  AgencyMembership,
  AgencyRole,
  Folder,
  FolderType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAgencyDto } from './dto/create-agency.dto';
import { CreateAgencyFolderDto } from './dto/create-agency-folder.dto';
import { CreateMembershipDto } from './dto/create-membership.dto';

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

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
}
