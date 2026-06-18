import type { AccountType } from '@prisma/client';

/**
 * Set on the request after AuthGuard verifies the JWT and syncs the User row.
 * `userId` and `id` are both the internal Postgres primary key (for FKs and legacy `user.userId` usage).
 */
export interface AuthenticatedUser {
  userId: string;
  id: string;
  cognitoSub: string;
  email: string;
  firstName: string | null;
  accountType: AccountType;
}
