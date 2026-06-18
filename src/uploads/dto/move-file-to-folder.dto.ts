import { IsUUID, ValidateIf } from 'class-validator';

export class MoveFileToFolderDto {
  /** Target folder UUID, or `null` to remove the file from any folder. */
  @ValidateIf((_: MoveFileToFolderDto, value: unknown) => value !== null)
  @IsUUID('4')
  folderId!: string | null;
}
