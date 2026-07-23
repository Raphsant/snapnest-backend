import { IsString, IsUUID, Matches } from 'class-validator';

/**
 * clipId is interpolated into S3 keys
 * (pipeline/<jobId>/final/final_<clipId>_9x16.mp4 and the delivered users/... key),
 * so it is restricted to a safe charset that cannot express a path separator or
 * traversal ("/", ".."). A non-matching value is rejected with 400 by the global
 * ValidationPipe before the handler builds any key.
 */
const CLIP_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export class DeliverClipDto {
  @IsString()
  @Matches(CLIP_ID_PATTERN, {
    message:
      'clipId must contain only letters, numbers, hyphens, and underscores',
  })
  clipId!: string;

  @IsUUID()
  folderId!: string;
}
