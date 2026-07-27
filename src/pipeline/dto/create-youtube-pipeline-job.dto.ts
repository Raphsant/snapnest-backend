import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Body for POST /admin/pipeline/jobs/youtube. Only shape is validated here;
 * PipelineService.normalizeYoutubeUrl enforces https + the youtube host
 * allowlist + an extractable video id (400 otherwise) and derives the
 * canonical https://www.youtube.com/watch?v=<id> that gets stored.
 */
export class CreateYoutubePipelineJobDto {
  @IsString()
  @IsNotEmpty()
  sourceUrl!: string;
}
