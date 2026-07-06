import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsUUID,
} from 'class-validator';

const MAX_BATCH_FILE_IDS = 100;

/**
 * Admin variant of the batch view-urls request. No agencyId scope — the
 * service serves agency files only (agencyId IS NOT NULL) and silently
 * omits personal files.
 */
export class AdminBatchViewUrlsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_BATCH_FILE_IDS)
  @IsUUID('4', { each: true })
  fileIds!: string[];
}
