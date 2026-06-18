import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { CognitoIdTokenPayload } from 'aws-jwt-verify/jwt-model';
import { JwtExpiredError } from 'aws-jwt-verify/error';
import type { Request } from 'express';
import type { User } from '@prisma/client';
import type { AuthenticatedUser } from './authenticated-user';
import { verifyToken } from './cognito-verifier';
import { PrismaService } from '../prisma/prisma.service';

const logger = new Logger('AuthGuard');

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();

    const authorizationHeader = request.headers.authorization;
    if (authorizationHeader === undefined || authorizationHeader === '') {
      throw new UnauthorizedException('Missing Authorization header');
    }

    const bearerMatch = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
    if (bearerMatch === null || bearerMatch[1] === undefined) {
      this.logVerificationFailure('Invalid Authorization header format');
      throw new UnauthorizedException('Invalid token format');
    }

    const rawToken = bearerMatch[1].trim();
    if (rawToken === '') {
      this.logVerificationFailure('Empty token after Bearer prefix');
      throw new UnauthorizedException('Invalid token format');
    }

    try {
      const payload: CognitoIdTokenPayload = await verifyToken(rawToken);
      const dbUser = await this.syncUserFromToken(payload);
      request.user = this.toAuthenticatedUser(dbUser);
      logger.log(
        `[AUTH] Verified internalUserId=${dbUser.id} cognitoSub=${dbUser.cognitoSub} email=${dbUser.email}`,
      );
      return true;
    } catch (err: unknown) {
      if (err instanceof JwtExpiredError) {
        this.logVerificationFailure(`JWT expired: ${err.message}`);
        throw new UnauthorizedException('Token expired');
      }
      const message =
        err instanceof Error ? err.message : 'Unknown verification error';
      this.logVerificationFailure(message);
      throw new UnauthorizedException('Invalid token');
    }
  }

  private logVerificationFailure(reason: string): void {
    logger.warn(`Token verification failed: ${reason}`);
  }

  /**
   * Ensures a User row exists for the Cognito subject and keeps email / firstName in sync.
   */
  private async syncUserFromToken(
    payload: CognitoIdTokenPayload,
  ): Promise<User> {
    const ext = payload as CognitoIdTokenPayload & {
      email?: unknown;
      given_name?: unknown;
    };

    const cognitoSub = payload.sub;
    const emailFromToken = this.parseEmailFromToken(ext);
    const firstNameFromToken = this.parseFirstNameFromToken(ext);

    const existing = await this.prisma.user.findUnique({
      where: { cognitoSub },
    });

    if (existing === null) {
      const emailForCreate =
        emailFromToken ?? `${cognitoSub}@cognito-placeholder.invalid`;
      return this.prisma.user.create({
        data: {
          cognitoSub,
          email: emailForCreate,
          firstName: firstNameFromToken ?? null,
        },
      });
    }

    // Only update fields when the token carries a value (avoid wiping email on tokens without `email`).
    const emailChanged =
      emailFromToken !== undefined && existing.email !== emailFromToken;
    const firstNameChanged =
      firstNameFromToken !== undefined &&
      (existing.firstName ?? null) !== firstNameFromToken;

    if (!emailChanged && !firstNameChanged) {
      return existing;
    }

    return this.prisma.user.update({
      where: { id: existing.id },
      data: {
        ...(emailChanged ? { email: emailFromToken } : {}),
        ...(firstNameChanged ? { firstName: firstNameFromToken } : {}),
      },
    });
  }

  /** Non-empty email from token, or undefined if absent (caller decides placeholder vs skip update). */
  private parseEmailFromToken(
    ext: CognitoIdTokenPayload & { email?: unknown },
  ): string | undefined {
    if (typeof ext.email === 'string' && ext.email.trim() !== '') {
      return ext.email.trim();
    }
    return undefined;
  }

  /** `undefined` = claim not present or not a string — do not overwrite stored firstName. */
  private parseFirstNameFromToken(
    ext: CognitoIdTokenPayload & { given_name?: unknown },
  ): string | null | undefined {
    if (typeof ext.given_name !== 'string') {
      return undefined;
    }
    const trimmed = ext.given_name.trim();
    return trimmed === '' ? null : trimmed;
  }

  private toAuthenticatedUser(user: User): AuthenticatedUser {
    return {
      userId: user.id,
      id: user.id,
      cognitoSub: user.cognitoSub,
      email: user.email,
      firstName: user.firstName,
      accountType: user.accountType,
    };
  }
}
