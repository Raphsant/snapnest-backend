import {
  ArrayMaxSize,
  IsArray,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';

/**
 * Body for POST /admin/invoicing/issuer. Creates a new version and makes it
 * current; earlier versions stay attached to the invoices that used them.
 * An empty paymentLines prints generic payment lines on the PDF.
 */
export class CreateIssuerProfileDto {
  @IsString()
  @Length(1, 200)
  legalName!: string;

  @IsString()
  @Length(1, 200)
  dba!: string;

  @IsString()
  @Length(1, 200)
  addressLine1!: string;

  @IsString()
  @Length(1, 200)
  addressLine2!: string;

  @IsString()
  @Length(1, 200)
  phone!: string;

  @IsString()
  @Length(1, 200)
  ein!: string;

  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  paymentLines!: string[];
}
