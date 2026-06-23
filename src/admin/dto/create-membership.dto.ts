import { AgencyRole } from '@prisma/client';
import { IsEmail, IsEnum, IsOptional, IsUUID } from 'class-validator';

export class CreateMembershipDto {
  @IsUUID()
  agencyId!: string;

  @IsEmail()
  email!: string;

  @IsOptional()
  @IsEnum(AgencyRole)
  role?: AgencyRole;
}
