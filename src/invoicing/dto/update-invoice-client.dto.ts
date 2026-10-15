import {
  IsEmail,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/**
 * Body for PATCH /admin/invoicing/clients/:id. Every field is optional.
 * code and name may be omitted but not nulled (ValidateIf, not IsOptional,
 * which would let null through); the optional fields accept null to clear.
 */
export class UpdateInvoiceClientDto {
  @ValidateIf((_, value) => value !== undefined)
  @Matches(/^[A-Z]{3,8}$/, { message: 'code must be 3-8 uppercase letters' })
  code?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @Length(1, 200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  contactName?: string | null;

  @IsOptional()
  @IsEmail()
  @MaxLength(200)
  email?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  phone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  addressLine1?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  addressLine2?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  notes?: string | null;
}
