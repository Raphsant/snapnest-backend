import { IsString, Length } from 'class-validator';

export class CreateAgencyDto {
  @IsString()
  @Length(1, 100)
  name!: string;
}
