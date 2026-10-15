import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional } from 'class-validator';
import { InvoiceKind } from '@prisma/client';

/**
 * Query for GET /admin/invoicing/next-number. year defaults to the current
 * UTC year; pass the invoiceDate's year to preview a backdated invoice.
 */
export class PeekNumberQueryDto {
  @IsEnum(InvoiceKind)
  kind!: InvoiceKind;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  year?: number;
}
