import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';

const MAX_BATCH_FILE_IDS = 200;

export class BatchDeleteFilesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_BATCH_FILE_IDS)
  @IsUUID('4', { each: true })
  fileIds!: string[];
}
