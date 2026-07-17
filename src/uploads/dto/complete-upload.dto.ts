import { IsBoolean, IsOptional } from 'class-validator';

export class CompleteUploadDto {
  /**
   * Whether the client-side thumbnail PUT succeeded. Omitted by older clients.
   * `false` clears any pre-set thumbnailS3Key so the server-side fallback runs.
   */
  @IsOptional()
  @IsBoolean()
  thumbnailUploaded?: boolean;
}
