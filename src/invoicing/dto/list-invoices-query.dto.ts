import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID } from 'class-validator';
import { InvoiceStatus } from '@prisma/client';

/** Query for GET /admin/invoicing/invoices. Omitted filters match all. */
export class ListInvoicesQueryDto {
  @IsOptional()
  @IsEnum(InvoiceStatus)
  status?: InvoiceStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  year?: number;

  @IsOptional()
  @IsUUID()
  clientId?: string;
}
