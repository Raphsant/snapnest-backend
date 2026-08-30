import { IsISO8601, IsOptional } from 'class-validator';

/**
 * Body for PUT /admin/pipeline/jobs/:id/outputs/:clipId/posted.
 *
 * Every field is optional: an empty body means "posted now", which is the
 * normal dashboard case. An explicit postedAt exists for backfilling a clip
 * that went out before it was marked here. The value stays a string at this
 * layer — the service converts it once, so an unparseable date is rejected
 * by validation rather than reaching Prisma as an Invalid Date.
 */
export class SetOutputPostedDto {
  @IsOptional()
  @IsISO8601()
  postedAt?: string;
}
