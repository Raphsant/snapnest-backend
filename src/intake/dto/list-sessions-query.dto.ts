import { IntakeSessionStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

export class ListSessionsQueryDto {
  @IsOptional()
  @IsEnum(IntakeSessionStatus)
  status?: IntakeSessionStatus;
}
