import { IsString, Length } from 'class-validator';

/** Body for POST /admin/invoicing/invoices/:id/void. */
export class VoidInvoiceDto {
  @IsString()
  @Length(1, 500)
  reason!: string;
}
