import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';
import { InvoiceLanguage } from '@prisma/client';

/**
 * Body for POST /admin/invoicing/suggest-descriptions. items are the
 * operator's line names (e.g. "Evento Houston"); context is optional free
 * text about the work. language defaults to EN.
 */
export class SuggestDescriptionsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @Length(1, 200, { each: true })
  items!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  context?: string;

  @IsOptional()
  @IsEnum(InvoiceLanguage)
  language: InvoiceLanguage = InvoiceLanguage.EN;
}
