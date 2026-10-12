import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * One block's replacement text, addressed by its generated index. Timings are
 * never accepted from the client; they always come from the generated slice.
 * An empty string is allowed and blanks the block.
 */
export class CaptionEditDto {
  @IsInt()
  @Min(1)
  @Max(100000)
  index!: number;

  @IsString()
  @MaxLength(500)
  text!: string;
}

/**
 * Body for PUT /admin/pipeline/jobs/:id/clips/:clipId/captions. Text-only:
 * timings are never accepted from the client; they come from the generated
 * slice. Count and per-position index are checked against that slice by
 * mergeEditedText, not here.
 */
export class SaveClipCaptionsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => CaptionEditDto)
  blocks!: CaptionEditDto[];
}
