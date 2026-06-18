import 'dotenv/config';

// Prisma maps BIGINT to JS bigint; JSON.stringify throws on bigint by default.
// This makes serialized API responses safe without per-field mapping.
declare global {
  interface BigInt {
    toJSON(): string;
  }
}

BigInt.prototype.toJSON = function (this: bigint): string {
  return this.toString();
};

import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

function validateRequiredCognitoEnv(configService: ConfigService): boolean {
  const userPoolId = configService.get<string>('COGNITO_USER_POOL_ID')?.trim();
  const clientId = configService.get<string>('COGNITO_CLIENT_ID')?.trim();

  if (!userPoolId) {
    Logger.error(
      'Startup failed: COGNITO_USER_POOL_ID is missing or empty. Set it in your environment before starting the server.',
    );
    return false;
  }

  if (!clientId) {
    Logger.error(
      'Startup failed: COGNITO_CLIENT_ID is missing or empty. Set it in your environment before starting the server.',
    );
    return false;
  }

  return true;
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const configService: ConfigService = app.get(ConfigService);
  if (!validateRequiredCognitoEnv(configService)) {
    await app.close();
    process.exit(1);
  }

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableCors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: '*',
  });

  const port: number = Number(configService.get<string>('PORT') ?? 3000);

  await app.listen(port);
  Logger.log(`SnapNest backend listening on http://localhost:${port}`);
}
bootstrap();
