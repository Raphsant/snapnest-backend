import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsString,
  ValidateNested,
} from 'class-validator';

export class ApprovalDecisionDto {
  @IsString()
  @IsNotEmpty()
  clipId!: string;

  @IsBoolean()
  approved!: boolean;
}

export class ApprovePipelineJobDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ApprovalDecisionDto)
  approvals!: ApprovalDecisionDto[];
}
