import { Module } from '@nestjs/common';
import { AgencyModule } from '../agency/agency.module';
import { AuthModule } from '../auth/auth.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { UploadsModule } from '../uploads/uploads.module';
import { IntakeController } from './intake.controller';
import { IntakeService } from './intake.service';

@Module({
  imports: [AuthModule, AgencyModule, UploadsModule, PipelineModule],
  controllers: [IntakeController],
  providers: [IntakeService],
})
export class IntakeModule {}
