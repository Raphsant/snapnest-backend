import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

export enum UploadSource {
  CAMERA = 'camera',
  GALLERY = 'gallery',
}

export class CreateUploadDto {
  @IsString()
  fileName!: string;

  @IsString()
  mimeType!: string;

  @Type(() => Number)
  @IsNumber()
  @Min(1)
  sizeBytes!: number;

  @IsOptional()
  @IsUUID()
  folderId?: string;

  @IsOptional()
  @IsUUID()
  agencyId?: string;

  @IsEnum(UploadSource)
  source!: UploadSource;

  @IsOptional()
  @IsBoolean()
  hasThumbnail?: boolean;
}
