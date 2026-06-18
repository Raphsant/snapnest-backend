import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const connectionString: string | undefined = process.env.DATABASE_URL;
    if (connectionString === undefined || connectionString.trim() === '') {
      throw new Error('DATABASE_URL must be set for PrismaPg adapter');
    }

    const adapter = new PrismaPg({
      connectionString,
    });

    super({
      adapter,
      log: process.env.NODE_ENV === 'production' ? ['error'] : ['query', 'error', 'warn'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}