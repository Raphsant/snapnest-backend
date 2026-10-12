import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PipelineJob } from '@prisma/client';
import { AdminGuard } from '../admin/admin.guard';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../auth/current-user.decorator';
import { CaptionBlock } from './clip-captions';
import { ApprovePipelineJobDto } from './dto/approve-pipeline-job.dto';
import { CreatePipelineJobDto } from './dto/create-pipeline-job.dto';
import { CreateYoutubePipelineJobDto } from './dto/create-youtube-pipeline-job.dto';
import { DeliverClipDto } from './dto/deliver-clip.dto';
import { ListOutputsQueryDto } from './dto/list-outputs-query.dto';
import { SaveClipCaptionsDto } from './dto/save-clip-captions.dto';
import { SetOutputPostedDto } from './dto/set-output-posted.dto';
import {
  DeliverClipResult,
  PipelineJobDetail,
  PipelineJobListItem,
  PipelineJobOutput,
  PipelineOutputListResult,
  PipelineService,
} from './pipeline.service';

@Controller('admin/pipeline')
@UseGuards(AuthGuard, AdminGuard)
export class PipelineController {
  constructor(private readonly pipelineService: PipelineService) {}

  @Post('jobs')
  createJob(
    @Body() dto: CreatePipelineJobDto,
    @CurrentUserId() requestedById: string,
  ): Promise<PipelineJob> {
    return this.pipelineService.createJob(dto, requestedById);
  }

  @Post('jobs/youtube')
  createYoutubeJob(
    @Body() dto: CreateYoutubePipelineJobDto,
    @CurrentUserId() requestedById: string,
  ): Promise<PipelineJob> {
    return this.pipelineService.createYoutubeJob(dto, requestedById);
  }

  @Post('jobs/:id/approve')
  approveJob(
    @Param('id') id: string,
    @Body() dto: ApprovePipelineJobDto,
  ): Promise<PipelineJob> {
    return this.pipelineService.approveJob(id, dto);
  }

  @Post('jobs/:id/approve-creative')
  approveCreative(@Param('id') id: string): Promise<PipelineJob> {
    return this.pipelineService.approveCreative(id);
  }

  @Post('jobs/:id/reopen')
  reopenJob(@Param('id') id: string): Promise<PipelineJob> {
    return this.pipelineService.reopenJob(id);
  }

  @Get('jobs')
  listJobs(): Promise<PipelineJobListItem[]> {
    return this.pipelineService.listJobs();
  }

  @Get('jobs/:id')
  getJob(@Param('id') id: string): Promise<PipelineJobDetail> {
    return this.pipelineService.getJobDetail(id);
  }

  @Get('jobs/:id/outputs')
  getJobOutputs(@Param('id') id: string): Promise<PipelineJobOutput[]> {
    return this.pipelineService.getJobOutputs(id);
  }

  @Get('jobs/:id/outputs/:clipId/download-url')
  getOutputDownloadUrl(
    @Param('id') id: string,
    @Param('clipId') clipId: string,
  ): Promise<{ url: string; fileName: string }> {
    return this.pipelineService.getOutputDownloadUrl(id, clipId);
  }

  @Put('jobs/:id/outputs/:clipId/posted')
  setOutputPosted(
    @Param('id') id: string,
    @Param('clipId') clipId: string,
    @Body() dto: SetOutputPostedDto,
  ): Promise<{ clipId: string; postedAt: string }> {
    return this.pipelineService.setOutputPosted(id, clipId, dto);
  }

  @Delete('jobs/:id/outputs/:clipId/posted')
  @HttpCode(HttpStatus.NO_CONTENT)
  clearOutputPosted(
    @Param('id') id: string,
    @Param('clipId') clipId: string,
  ): Promise<void> {
    return this.pipelineService.clearOutputPosted(id, clipId);
  }

  @Get('jobs/:id/clips/:clipId/captions')
  getClipCaptions(
    @Param('id') id: string,
    @Param('clipId') clipId: string,
  ): Promise<{ generated: CaptionBlock[]; edited: CaptionBlock[] | null }> {
    return this.pipelineService.getClipCaptions(id, clipId);
  }

  @Put('jobs/:id/clips/:clipId/captions')
  saveClipCaptions(
    @Param('id') id: string,
    @Param('clipId') clipId: string,
    @Body() dto: SaveClipCaptionsDto,
  ): Promise<{ blocks: CaptionBlock[] }> {
    return this.pipelineService.saveClipCaptions(id, clipId, dto);
  }

  @Delete('jobs/:id/clips/:clipId/captions')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteClipCaptions(
    @Param('id') id: string,
    @Param('clipId') clipId: string,
  ): Promise<void> {
    return this.pipelineService.deleteClipCaptions(id, clipId);
  }

  /**
   * Cross-job outputs listing. Metadata only — no presigned URLs — so a wide
   * listing stays one pair of queries. `posted` omitted means both.
   */
  @Get('outputs')
  listOutputs(
    @Query() query: ListOutputsQueryDto,
  ): Promise<PipelineOutputListResult> {
    return this.pipelineService.listOutputs(query);
  }

  @Post('jobs/:id/deliver')
  @HttpCode(HttpStatus.OK)
  deliverClip(
    @Param('id') id: string,
    @Body() dto: DeliverClipDto,
  ): Promise<DeliverClipResult> {
    return this.pipelineService.deliverClip(id, dto);
  }
}
