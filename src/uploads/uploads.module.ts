import { Module } from '@nestjs/common';
import { AgencyModule } from '../agency/agency.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { FilesController, UploadsController } from './uploads.controller';
import { ThumbnailService } from './thumbnail.service';
import { UploadsService } from './uploads.service';

@Module({
  imports: [AuthModule, AgencyModule, NotificationsModule],
  controllers: [UploadsController, FilesController],
  providers: [UploadsService, ThumbnailService],
  exports: [UploadsService],
})
export class UploadsModule {}
