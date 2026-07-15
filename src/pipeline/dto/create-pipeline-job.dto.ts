import { IsUUID } from 'class-validator';

export class CreatePipelineJobDto {
  @IsUUID()
  fileId!: string;
}
