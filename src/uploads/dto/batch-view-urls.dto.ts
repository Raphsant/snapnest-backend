import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsUUID,
} from 'class-validator';

const MAX_BATCH_FILE_IDS = 100;

export class BatchViewUrlsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_BATCH_FILE_IDS)
  @IsUUID('4', { each: true })
  fileIds!: string[];

  /** When set, files are authorized by agency membership instead of personal ownership. */
  @IsOptional()
  @IsUUID()
  agencyId?: string;
}
