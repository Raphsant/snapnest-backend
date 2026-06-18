import { Type } from 'class-transformer';
import {
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

  @IsEnum(UploadSource)
  source!: UploadSource;
}
