import { IsUUID } from 'class-validator';

export class SetAnswerDto {
  @IsUUID()
  fileId!: string;
}
