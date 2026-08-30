import { Transform, TransformFnParams, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Query for GET /admin/pipeline/outputs.
 *
 * `posted` arrives as the string "true" or "false" on the query string.
 * Anything else passes through the transform unchanged so @IsBoolean rejects
 * it with a 400 — a bare `value === 'true'` would silently read every typo
 * ("yes", "1", "flase") as false and quietly return the wrong half of the list.
 * Omitting the param entirely means "both".
 */
export class ListOutputsQueryDto {
  @IsOptional()
  @Transform(({ value }: TransformFnParams): unknown => {
    if (value === 'true') {
      return true;
    }
    if (value === 'false') {
      return false;
    }
    return value;
  })
  @IsBoolean()
  posted?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
