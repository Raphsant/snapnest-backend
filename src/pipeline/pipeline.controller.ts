import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { PipelineJob } from '@prisma/client';
import { AdminGuard } from '../admin/admin.guard';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../auth/current-user.decorator';
import { ApprovePipelineJobDto } from './dto/approve-pipeline-job.dto';
import { CreatePipelineJobDto } from './dto/create-pipeline-job.dto';
import { DeliverClipDto } from './dto/deliver-clip.dto';
import {
  DeliverClipResult,
  PipelineJobDetail,
  PipelineJobListItem,
  PipelineJobOutput,
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

  @Post('jobs/:id/deliver')
  @HttpCode(HttpStatus.OK)
  deliverClip(
    @Param('id') id: string,
    @Body() dto: DeliverClipDto,
  ): Promise<DeliverClipResult> {
    return this.pipelineService.deliverClip(id, dto);
  }
}
