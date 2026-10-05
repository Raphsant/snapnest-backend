import { IsString, Length } from 'class-validator';

export class AcceptNdaDto {
  @IsString()
  @Length(1, 200)
  fullName!: string;

  @IsString()
  version!: string;
}
