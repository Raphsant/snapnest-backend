import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InvoiceClient, IssuerProfile } from '@prisma/client';
import { AdminGuard } from '../admin/admin.guard';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../auth/current-user.decorator';
import { CreateInvoiceClientDto } from './dto/create-invoice-client.dto';
import { CreateIssuerProfileDto } from './dto/create-issuer-profile.dto';
import { IssueInvoiceDto } from './dto/issue-invoice.dto';
import { ListInvoicesQueryDto } from './dto/list-invoices-query.dto';
import { MarkPaidDto } from './dto/mark-paid.dto';
import { PeekNumberQueryDto } from './dto/peek-number-query.dto';
import { UpdateInvoiceClientDto } from './dto/update-invoice-client.dto';
import { VoidInvoiceDto } from './dto/void-invoice.dto';
import {
  InvoiceDetail,
  InvoiceDownloadUrl,
  InvoiceListResult,
  InvoicingService,
  IssueInvoiceInput,
} from './invoicing.service';

@Controller('admin/invoicing')
@UseGuards(AuthGuard, AdminGuard)
export class InvoicingController {
  constructor(private readonly invoicingService: InvoicingService) {}

  @Get('clients')
  listClients(): Promise<InvoiceClient[]> {
    return this.invoicingService.listClients();
  }

  @Post('clients')
  createClient(@Body() dto: CreateInvoiceClientDto): Promise<InvoiceClient> {
    return this.invoicingService.createClient(dto);
  }

  @Patch('clients/:id')
  updateClient(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateInvoiceClientDto,
  ): Promise<InvoiceClient> {
    return this.invoicingService.updateClient(id, dto);
  }

  @Get('issuer')
  getCurrentIssuer(): Promise<IssuerProfile> {
    return this.invoicingService.getCurrentIssuer();
  }

  @Post('issuer')
  createIssuerVersion(
    @Body() dto: CreateIssuerProfileDto,
    @CurrentUserId() createdById: string,
  ): Promise<IssuerProfile> {
    return this.invoicingService.createIssuerVersion(dto, createdById);
  }

  /** Informational only; issuing allocates its own number under lock. */
  @Get('next-number')
  peekNextNumber(
    @Query() query: PeekNumberQueryDto,
  ): Promise<{ invoiceNo: string }> {
    return this.invoicingService.peekNextNumber(query.kind, query.year);
  }

  @Get('invoices')
  listInvoices(
    @Query() query: ListInvoicesQueryDto,
  ): Promise<InvoiceListResult> {
    return this.invoicingService.listInvoices(query);
  }

  @Post('invoices')
  issue(
    @Body() dto: IssueInvoiceDto,
    @CurrentUserId() createdById: string,
  ): Promise<InvoiceDetail> {
    return this.invoicingService.issue(dto, createdById);
  }

  @Get('invoices/:id')
  getInvoice(@Param('id', ParseUUIDPipe) id: string): Promise<InvoiceDetail> {
    return this.invoicingService.getInvoice(id);
  }

  @Get('invoices/:id/download-url')
  getDownloadUrl(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InvoiceDownloadUrl> {
    return this.invoicingService.getDownloadUrl(id);
  }

  @Post('invoices/:id/pay')
  @HttpCode(HttpStatus.OK)
  markPaid(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkPaidDto,
  ): Promise<InvoiceDetail> {
    return this.invoicingService.markPaid(id, dto);
  }

  @Post('invoices/:id/void')
  @HttpCode(HttpStatus.OK)
  voidInvoice(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidInvoiceDto,
  ): Promise<InvoiceDetail> {
    return this.invoicingService.void(id, dto);
  }

  /** Draft only: writes nothing and does not void. */
  @Get('invoices/:id/correction')
  prepareCorrection(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<IssueInvoiceInput & { replacesInvoiceId: string }> {
    return this.invoicingService.prepareCorrection(id);
  }

  @Post('invoices/:id/render-pdf')
  @HttpCode(HttpStatus.OK)
  renderPdf(@Param('id', ParseUUIDPipe) id: string): Promise<InvoiceDetail> {
    return this.invoicingService.renderPdf(id);
  }
}
