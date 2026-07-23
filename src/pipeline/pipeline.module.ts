import { Module } from '@nestjs/common';
import { AdminGuard } from '../admin/admin.guard';
import { AuthModule } from '../auth/auth.module';
import { ThumbnailService } from '../uploads/thumbnail.service';
import { PipelineController } from './pipeline.controller';
import { PipelineService } from './pipeline.service';

@Module({
  imports: [AuthModule],
  controllers: [PipelineController],
  providers: [PipelineService, ThumbnailService, AdminGuard],
})
export class PipelineModule {}
