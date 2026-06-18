import { FolderType } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, Length } from 'class-validator';

export class CreateFolderDto {
  @IsString()
  @Length(1, 100)
  name!: string;

  @IsOptional()
  @IsUUID()
  parentFolderId?: string;

  @IsOptional()
  @IsEnum(FolderType)
  type?: FolderType;
}
