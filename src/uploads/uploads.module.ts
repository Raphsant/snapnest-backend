import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FilesController, UploadsController } from './uploads.controller';
import { ThumbnailService } from './thumbnail.service';
import { UploadsService } from './uploads.service';

@Module({
  imports: [AuthModule],
  controllers: [UploadsController, FilesController],
  providers: [UploadsService, ThumbnailService],
})
export class UploadsModule {}
