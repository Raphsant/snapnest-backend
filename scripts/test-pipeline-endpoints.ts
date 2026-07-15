/**
 * Pipeline endpoint integration tests (curl-equivalent via supertest).
 * Auth is stubbed via X-Test-Account header — not for production use.
 *
 * Usage: npx ts-node -r dotenv/config scripts/test-pipeline-endpoints.ts
 */
import 'dotenv/config';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AccountType } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AdminGuard } from '../src/admin/admin.guard';
import { AppModule } from '../src/app.module';
import { AuthGuard } from '../src/auth/auth.guard';
import type { AuthenticatedUser } from '../src/auth/authenticated-user';
import { PrismaService } from '../src/prisma/prisma.service';

const AGENCY_VIDEO_ID = '1f33bcaa-943c-4d8c-bfd0-c5ecf74e0b67';
const PERSONAL_VIDEO_ID = 'f0086368-af91-42f0-8941-0dafb47950d5';
const PERSONAL_PHOTO_ID = 'd0ff5b85-67a0-4965-9353-8f4544c232ed';

class TestAuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      user?: AuthenticatedUser;
    }>();
    const rawRole = req.headers['x-test-account'];
    const role = Array.isArray(rawRole) ? rawRole[0] : rawRole;
    if (role === undefined || role === '') {
      throw new UnauthorizedException('Missing X-Test-Account header');
    }

    const accountType =
      role === 'admin' ? AccountType.ADMIN : AccountType.PERSONAL;
    const user = await this.prisma.user.findFirst({
      where: { accountType },
      orderBy: { createdAt: 'asc' },
    });
    if (user === null) {
      throw new UnauthorizedException(`No ${role} user in database`);
    }

    req.user = {
      userId: user.id,
      id: user.id,
      cognitoSub: user.cognitoSub,
      email: user.email,
      firstName: user.firstName,
      accountType: user.accountType,
    };
    return true;
  }
}

async function bootstrap(): Promise<INestApplication<App>> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideGuard(AuthGuard)
    .useFactory({
      factory: (prisma: PrismaService) => new TestAuthGuard(prisma),
      inject: [PrismaService],
    })
    .compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.init();
  return app;
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const app = await bootstrap();
  const server = app.getHttpServer();

  console.log('--- POST personal video → 400 ---');
  {
    const res = await request(server)
      .post('/admin/pipeline/jobs')
      .set('X-Test-Account', 'admin')
      .send({ fileId: PERSONAL_VIDEO_ID });
    assert(res.status === 400, `expected 400, got ${res.status}`);
    console.log('OK', res.body.message);
  }

  console.log('--- POST personal photo (non-video) → 400 ---');
  {
    const res = await request(server)
      .post('/admin/pipeline/jobs')
      .set('X-Test-Account', 'admin')
      .send({ fileId: PERSONAL_PHOTO_ID });
    assert(res.status === 400, `expected 400, got ${res.status}`);
    console.log('OK', res.body.message);
  }

  console.log('--- POST agency video → 201 (FAILED if queue missing) ---');
  let jobId: string;
  {
    const res = await request(server)
      .post('/admin/pipeline/jobs')
      .set('X-Test-Account', 'admin')
      .send({ fileId: AGENCY_VIDEO_ID });
    assert(res.status === 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    jobId = res.body.id as string;
    assert(
      res.body.status === 'FAILED' || res.body.status === 'QUEUED',
      `unexpected status ${res.body.status}`,
    );
    if (res.body.status === 'FAILED') {
      assert(
        typeof res.body.error === 'string' && res.body.error.includes('SQS'),
        'FAILED job should include SQS error',
      );
      console.log('OK status=FAILED (SQS enqueue failed as expected)', res.body.error);
    } else {
      console.log('OK status=QUEUED');
    }
  }

  console.log('--- POST same file again → 409 ---');
  {
    const prisma = app.get(PrismaService);
    const active = await prisma.pipelineJob.findUnique({ where: { id: jobId } });
    if (active?.status === 'FAILED') {
      await prisma.pipelineJob.update({
        where: { id: jobId },
        data: { status: 'RUNNING', error: null },
      });
    }
    const res = await request(server)
      .post('/admin/pipeline/jobs')
      .set('X-Test-Account', 'admin')
      .send({ fileId: AGENCY_VIDEO_ID });
    assert(res.status === 409, `expected 409, got ${res.status}`);
    console.log('OK', res.body.message);
  }

  console.log('--- GET list (admin) ---');
  {
    const res = await request(server)
      .get('/admin/pipeline/jobs')
      .set('X-Test-Account', 'admin');
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(Array.isArray(res.body), 'expected array');
    assert(
      res.body.some((j: { id: string }) => j.id === jobId),
      'list should include created job',
    );
    assert(
      res.body[0].sourceFile?.fileName !== undefined,
      'list items should include sourceFile.fileName',
    );
    console.log('OK', res.body.length, 'jobs');
  }

  console.log('--- GET detail (admin) ---');
  {
    const res = await request(server)
      .get(`/admin/pipeline/jobs/${jobId}`)
      .set('X-Test-Account', 'admin');
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.id === jobId, 'wrong job id');
    console.log('OK', res.body.status);
  }

  console.log('--- non-admin → 403 on all routes ---');
  for (const [method, path, body] of [
    ['post', '/admin/pipeline/jobs', { fileId: AGENCY_VIDEO_ID }],
    ['get', '/admin/pipeline/jobs', undefined],
    ['get', `/admin/pipeline/jobs/${jobId}`, undefined],
  ] as const) {
    const req = request(server)[method](path).set('X-Test-Account', 'personal');
    const res =
      body === undefined ? await req : await req.send(body as object);
    assert(res.status === 403, `${method.toUpperCase()} ${path} expected 403, got ${res.status}`);
  }
  console.log('OK all 403');

  await app.close();
  console.log('\nAll pipeline endpoint tests passed.');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
