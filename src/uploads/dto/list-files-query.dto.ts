import { Type } from 'class-transformer';
import {
  IsDate,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

/** Matches uploads.service UNFILED_FOLDER_QUERY — unfiled files only. */
const FOLDER_ID_PATTERN =
  /^(none|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export class ListFilesQueryDto {
  @IsOptional()
  @IsString()
  @Matches(FOLDER_ID_PATTERN, {
    message: 'folderId must be a UUID or "none" for unfiled files',
  })
  folderId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  /** Cursor: return files with createdAt strictly before this instant (ISO 8601). */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  before?: Date;
}
