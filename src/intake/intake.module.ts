import { Module } from '@nestjs/common';
import { AgencyModule } from '../agency/agency.module';
import { AuthModule } from '../auth/auth.module';
import { UploadsModule } from '../uploads/uploads.module';
import { IntakeController } from './intake.controller';
import { IntakeService } from './intake.service';

@Module({
  imports: [AuthModule, AgencyModule, UploadsModule],
  controllers: [IntakeController],
  providers: [IntakeService],
})
export class IntakeModule {}
