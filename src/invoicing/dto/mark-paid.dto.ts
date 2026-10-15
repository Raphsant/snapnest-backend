import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/** Body for POST /admin/invoicing/invoices/:id/pay. */
export class MarkPaidDto {
  /** YYYY-MM-DD; calendar validity is checked by the service. */
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  paidDate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  paymentRef?: string;
}
