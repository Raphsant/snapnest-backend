import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Expo } from 'expo-server-sdk';
import type { ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly expo: Expo;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    // Expo allows unauthenticated sends; an access token is recommended for
    // production and picked up transparently when EXPO_ACCESS_TOKEN is set.
    const accessToken = configService.get<string>('EXPO_ACCESS_TOKEN');
    this.expo = new Expo(accessToken ? { accessToken } : {});
  }

  /**
   * Registers (or refreshes) a device's Expo push token for a user.
   *
   * `token` carries a full unique index, so a plain upsert is race-safe here
   * (this is NOT the partial-index case). If the token already exists under a
   * different user — the device switched accounts — the update reassigns it to
   * the caller and refreshes lastSeenAt.
   */
  async registerToken(
    userId: string,
    token: string,
    platform: string,
  ): Promise<void> {
    await this.prisma.pushToken.upsert({
      where: { token },
      create: { userId, token, platform },
      update: { userId, platform, lastSeenAt: new Date() },
    });
  }

  /**
   * Removes a token if it belongs to the caller. Idempotent: a missing or
   * unowned token is a no-op (deleteMany returns count 0 and never throws), so
   * logout always succeeds.
   */
  async deleteToken(userId: string, token: string): Promise<void> {
    await this.prisma.pushToken.deleteMany({ where: { token, userId } });
  }

  /**
   * Fire-and-forget push to every device registered for a user.
   *
   * This method NEVER throws — callers void it (or .catch(log)). Every failure
   * is swallowed and logged under the [push] prefix so a notification problem
   * can never delay or break the request that triggered it.
   */
  async sendToUser(
    userId: string,
    title: string,
    body: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const rows = await this.prisma.pushToken.findMany({
        where: { userId },
        select: { token: true },
      });
      if (rows.length === 0) {
        return;
      }

      const validTokens = rows
        .map((row) => row.token)
        .filter((token) => {
          const valid = Expo.isExpoPushToken(token);
          if (!valid) {
            this.logger.warn(
              `[push] skipping invalid Expo token for user ${userId}`,
            );
          }
          return valid;
        });
      if (validTokens.length === 0) {
        return;
      }

      const messages: ExpoPushMessage[] = validTokens.map((token) => ({
        to: token,
        title,
        body,
        sound: 'default',
        ...(data !== undefined ? { data } : {}),
      }));

      this.logger.log(
        `[push] sending "${title}" to ${messages.length} device(s) for user ${userId}`,
      );

      const tokensToPrune: string[] = [];
      const chunks = this.expo.chunkPushNotifications(messages);
      for (const chunk of chunks) {
        let tickets: ExpoPushTicket[];
        try {
          tickets = await this.expo.sendPushNotificationsAsync(chunk);
        } catch (error: unknown) {
          this.logger.error(
            `[push] chunk send failed for user ${userId}: ${this.describe(error)}`,
          );
          continue;
        }

        tickets.forEach((ticket, index) => {
          if (ticket.status !== 'error') {
            return;
          }
          const recipient = chunk[index].to;
          const token = Array.isArray(recipient) ? recipient[0] : recipient;
          this.logger.warn(
            `[push] ticket error for user ${userId} (${ticket.details?.error ?? 'unknown'}): ${ticket.message}`,
          );
          if (ticket.details?.error === 'DeviceNotRegistered') {
            tokensToPrune.push(token);
          }
        });
      }

      if (tokensToPrune.length > 0) {
        const pruned = await this.prisma.pushToken.deleteMany({
          where: { token: { in: tokensToPrune } },
        });
        this.logger.log(
          `[push] pruned ${pruned.count} unregistered token(s) for user ${userId}`,
        );
      }
    } catch (error: unknown) {
      // Absolute guarantee: sendToUser never throws.
      this.logger.error(
        `[push] sendToUser failed for user ${userId}: ${this.describe(error)}`,
      );
    }
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
