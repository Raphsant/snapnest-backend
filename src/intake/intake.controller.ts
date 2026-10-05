import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../auth/current-user.decorator';
import { AcceptNdaDto } from './dto/accept-nda.dto';
import { ListSessionsQueryDto } from './dto/list-sessions-query.dto';
import { SetAnswerDto } from './dto/set-answer.dto';
import { SetSessionStatusDto } from './dto/set-session-status.dto';
import { StepProgressDto } from './dto/step-progress.dto';
import { IntakeService } from './intake.service';
import {
  IntakeResponse,
  IntakeSessionSummary,
  IntakeSessionView,
  IntakeStaffSessionView,
  NdaStatusResponse,
} from './intake.types';

@Controller('agency/:agencyId')
@UseGuards(AuthGuard)
export class IntakeController {
  constructor(private readonly intakeService: IntakeService) {}

  // ---- NDA (client) ----

  @Get('nda')
  getNdaStatus(
    @CurrentUserId() userId: string,
    @Param('agencyId') agencyId: string,
  ): Promise<NdaStatusResponse> {
    return this.intakeService.getNdaStatus(userId, agencyId);
  }

  @Post('nda/accept')
  acceptNda(
    @CurrentUserId() userId: string,
    @Param('agencyId') agencyId: string,
    @Body() dto: AcceptNdaDto,
  ): Promise<NdaStatusResponse> {
    return this.intakeService.acceptNda(userId, agencyId, dto);
  }

  // ---- Intake (client) ----

  @Get('intake')
  getIntake(
    @CurrentUserId() userId: string,
    @Param('agencyId') agencyId: string,
  ): Promise<IntakeResponse> {
    return this.intakeService.getIntake(userId, agencyId);
  }

  // ---- Intake sessions (staff) ----
  // Declared before /steps and /answers so they are matched first.

  @Get('intake/sessions')
  listSessions(
    @CurrentUserId() userId: string,
    @Param('agencyId') agencyId: string,
    @Query() query: ListSessionsQueryDto,
  ): Promise<IntakeSessionSummary[]> {
    return this.intakeService.listSessions(userId, agencyId, query.status);
  }

  @Get('intake/sessions/:sessionId')
  getSession(
    @CurrentUserId() userId: string,
    @Param('agencyId') agencyId: string,
    @Param('sessionId') sessionId: string,
  ): Promise<IntakeStaffSessionView> {
    return this.intakeService.getSession(userId, agencyId, sessionId);
  }

  @Post('intake/sessions/:sessionId/status')
  setSessionStatus(
    @CurrentUserId() userId: string,
    @Param('agencyId') agencyId: string,
    @Param('sessionId') sessionId: string,
    @Body() dto: SetSessionStatusDto,
  ): Promise<IntakeSessionView> {
    return this.intakeService.setSessionStatus(
      userId,
      agencyId,
      sessionId,
      dto,
    );
  }

  // ---- Intake progress and answers (client) ----

  @Post('intake/steps/:stepId/progress')
  recordStepProgress(
    @CurrentUserId() userId: string,
    @Param('agencyId') agencyId: string,
    @Param('stepId') stepId: string,
    @Body() dto: StepProgressDto,
  ): Promise<IntakeSessionView> {
    return this.intakeService.recordStepProgress(userId, agencyId, stepId, dto);
  }

  @Put('intake/answers/:questionId')
  setAnswer(
    @CurrentUserId() userId: string,
    @Param('agencyId') agencyId: string,
    @Param('questionId') questionId: string,
    @Body() dto: SetAnswerDto,
  ): Promise<IntakeSessionView> {
    return this.intakeService.setAnswer(userId, agencyId, questionId, dto);
  }

  @Post('intake/submit')
  submit(
    @CurrentUserId() userId: string,
    @Param('agencyId') agencyId: string,
  ): Promise<IntakeSessionView> {
    return this.intakeService.submit(userId, agencyId);
  }
}
