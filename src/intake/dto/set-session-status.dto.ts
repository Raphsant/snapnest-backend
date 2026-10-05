import { IntakeSessionStatus } from '@prisma/client';
import { IsIn } from 'class-validator';

export type StaffSettableSessionStatus =
  | typeof IntakeSessionStatus.PROCESSING
  | typeof IntakeSessionStatus.COMPLETE;

export class SetSessionStatusDto {
  @IsIn([IntakeSessionStatus.PROCESSING, IntakeSessionStatus.COMPLETE])
  status!: StaffSettableSessionStatus;
}
