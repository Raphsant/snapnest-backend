import { Module } from '@nestjs/common';
import { AdminGuard } from '../admin/admin.guard';
import { AuthModule } from '../auth/auth.module';
import { InvoicingController } from './invoicing.controller';
import { InvoicingService } from './invoicing.service';

// PrismaService comes from the global PrismaModule registered in AppModule,
// the same way PipelineModule gets it.
@Module({
  imports: [AuthModule],
  controllers: [InvoicingController],
  providers: [InvoicingService, AdminGuard],
})
export class InvoicingModule {}
