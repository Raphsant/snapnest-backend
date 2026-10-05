import { IsInt, Min } from 'class-validator';

export class StepProgressDto {
  @IsInt()
  @Min(0)
  watchedSeconds!: number;
}
