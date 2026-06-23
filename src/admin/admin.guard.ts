import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AccountType } from '@prisma/client';
import type { Request } from 'express';

/**
 * Runs after AuthGuard (which attaches request.user). Restricts a route to ADMIN accounts.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user;
    if (user === undefined) {
      throw new UnauthorizedException('Authenticated user not available');
    }
    if (user.accountType !== AccountType.ADMIN) {
      throw new ForbiddenException('Admin privileges required');
    }
    return true;
  }
}
