import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  IsUUID,
  ValidateIf,
} from 'class-validator';

const MAX_BATCH_FILE_IDS = 200;

/**
 * Sentinel meaning "the caller's Unfiled folder", resolved server-side via
 * findOrCreateUnfiledFolder. Must stay in sync with UNFILED_FOLDER_QUERY in
 * uploads.service.ts; inlined here (not imported) to avoid a dto <-> service
 * circular value-import.
 */
const UNFILED_TARGET = 'none';

const TARGET_FOLDER_MESSAGE = `targetFolderId must be a folder UUID or the literal '${UNFILED_TARGET}'`;

export class BatchMoveFilesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_BATCH_FILE_IDS)
  @IsUUID('4', { each: true })
  fileIds!: string[];

  /**
   * Target folder UUID, or the literal 'none' to move into Unfiled. `null` is
   * intentionally rejected: batch moves must name an explicit destination.
   */
  @IsString({ message: TARGET_FOLDER_MESSAGE })
  @ValidateIf((_: BatchMoveFilesDto, value: unknown) => value !== UNFILED_TARGET)
  @IsUUID('4', { message: TARGET_FOLDER_MESSAGE })
  targetFolderId!: string;
}
