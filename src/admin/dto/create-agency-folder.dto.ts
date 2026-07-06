import { FolderType } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, Length } from 'class-validator';

export class CreateAgencyFolderDto {
  @IsUUID()
  userId!: string;

  @IsString()
  @Length(1, 100)
  name!: string;

  @IsOptional()
  @IsEnum(FolderType)
  type?: FolderType;
}
