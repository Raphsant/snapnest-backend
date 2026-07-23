import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UploadsModule } from '../uploads/uploads.module';
import { FoldersController } from './folders.controller';
import { FoldersService } from './folders.service';

@Module({
  imports: [AuthModule, UploadsModule],
  controllers: [FoldersController],
  providers: [FoldersService],
})
export class FoldersModule {}
