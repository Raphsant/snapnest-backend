import { Module } from '@nestjs/common';
import { AdminGuard } from '../admin/admin.guard';
import { AuthModule } from '../auth/auth.module';
import { PipelineController } from './pipeline.controller';
import { PipelineService } from './pipeline.service';

@Module({
  imports: [AuthModule],
  controllers: [PipelineController],
  providers: [PipelineService, AdminGuard],
})
export class PipelineModule {}
