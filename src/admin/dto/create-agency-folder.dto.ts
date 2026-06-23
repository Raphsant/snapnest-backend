import { FolderType } from '@prisma/client';
import { IsEnum, IsOptional, IsString, Length } from 'class-validator';

export class CreateAgencyFolderDto {
  @IsString()
  @Length(1, 100)
  name!: string;

  @IsOptional()
  @IsEnum(FolderType)
  type?: FolderType;
}
