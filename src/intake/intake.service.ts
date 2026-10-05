/* eslint-disable @typescript-eslint/no-unused-vars -- contract stubs; remove when the bodies are implemented */
import { Injectable, NotImplementedException } from '@nestjs/common';
import { IntakeSessionStatus } from '@prisma/client';
import { AgencyService } from '../agency/agency.service';
import { PrismaService } from '../prisma/prisma.service';
import { AcceptNdaDto } from './dto/accept-nda.dto';
import { SetAnswerDto } from './dto/set-answer.dto';
import { SetSessionStatusDto } from './dto/set-session-status.dto';
import { StepProgressDto } from './dto/step-progress.dto';
import {
  IntakeResponse,
  IntakeSessionSummary,
  IntakeSessionView,
  IntakeStaffSessionView,
  NdaStatusResponse,
} from './intake.types';

@Injectable()
export class IntakeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agencyService: AgencyService,
  ) {}

  // ---- Client ----

  getNdaStatus(userId: string, agencyId: string): Promise<NdaStatusResponse> {
    throw new NotImplementedException();
  }

  acceptNda(
    userId: string,
    agencyId: string,
    dto: AcceptNdaDto,
  ): Promise<NdaStatusResponse> {
    throw new NotImplementedException();
  }

  getIntake(userId: string, agencyId: string): Promise<IntakeResponse> {
    throw new NotImplementedException();
  }

  recordStepProgress(
    userId: string,
    agencyId: string,
    stepId: string,
    dto: StepProgressDto,
  ): Promise<IntakeSessionView> {
    throw new NotImplementedException();
  }

  setAnswer(
    userId: string,
    agencyId: string,
    questionId: string,
    dto: SetAnswerDto,
  ): Promise<IntakeSessionView> {
    throw new NotImplementedException();
  }

  submit(userId: string, agencyId: string): Promise<IntakeSessionView> {
    throw new NotImplementedException();
  }

  // ---- Staff (assertAgencyStaff) ----

  listSessions(
    userId: string,
    agencyId: string,
    status?: IntakeSessionStatus,
  ): Promise<IntakeSessionSummary[]> {
    throw new NotImplementedException();
  }

  getSession(
    userId: string,
    agencyId: string,
    sessionId: string,
  ): Promise<IntakeStaffSessionView> {
    throw new NotImplementedException();
  }

  setSessionStatus(
    userId: string,
    agencyId: string,
    sessionId: string,
    dto: SetSessionStatusDto,
  ): Promise<IntakeSessionView> {
    throw new NotImplementedException();
  }
}
