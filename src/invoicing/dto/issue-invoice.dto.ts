import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { InvoiceKind, InvoiceLanguage } from '@prisma/client';

export class IssueInvoiceItemDto {
  @IsString()
  @Length(1, 200)
  name!: string;

  @IsString()
  @Length(1, 400)
  description!: string;

  @IsInt()
  @Min(1)
  qty!: number;

  @IsInt()
  @Min(0)
  unitPriceCents!: number;
}

/**
 * Body for POST /admin/invoicing/invoices. Deliberately has no totals fields:
 * amounts are computed server-side, and the global ValidationPipe
 * (forbidNonWhitelisted) rejects any the client sends.
 */
export class IssueInvoiceDto {
  @IsEnum(InvoiceKind)
  kind!: InvoiceKind;

  @IsUUID()
  clientId!: string;

  /** YYYY-MM-DD; calendar validity is checked by the service. */
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  invoiceDate!: string;

  @IsString()
  @Length(1, 60)
  terms!: string;

  @IsInt()
  @Min(0)
  @Max(10000)
  taxRateBps!: number;

  @IsEnum(InvoiceLanguage)
  language!: InvoiceLanguage;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsUUID()
  replacesInvoiceId?: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => IssueInvoiceItemDto)
  items!: IssueInvoiceItemDto[];
}
