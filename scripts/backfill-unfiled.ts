import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { UploadsService } from '../src/uploads/uploads.service';
import { UploadsModule } from '../src/uploads/uploads.module';

/**
 * Sweeps orphaned personal files (folderId null AND agencyId null) into their
 * owner's system "Unfiled" folder, creating it on demand via the same
 * find-or-create path the upload flow uses. Idempotent: a second run finds no
 * remaining null-folder personal files and moves nothing.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const prisma = app.get(PrismaService);
    const uploadsService = app
      .select(UploadsModule)
      .get(UploadsService, { strict: true });

    const owners = await prisma.mediaFile.groupBy({
      by: ['ownerId'],
      where: { folderId: null, agencyId: null },
    });

    console.log(`Found ${owners.length} owner(s) with unfiled personal files`);

    let usersTouched = 0;
    let foldersCreated = 0;
    let filesMoved = 0;

    for (const { ownerId } of owners) {
      const preexisting = await prisma.folder.findFirst({
        where: { ownerId, isSystem: true },
      });
      const folderId = await uploadsService.findOrCreateUnfiledFolder(ownerId);
      if (preexisting === null) {
        foldersCreated += 1;
      }

      const { count } = await prisma.mediaFile.updateMany({
        where: { ownerId, folderId: null, agencyId: null },
        data: { folderId },
      });

      if (count > 0) {
        usersTouched += 1;
        filesMoved += count;
      }
      console.log(`Owner ${ownerId}: moved ${count} file(s) into ${folderId}`);
    }

    console.log(
      `Done: ${usersTouched} user(s) touched, ${foldersCreated} folder(s) created, ${filesMoved} file(s) moved`,
    );
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Backfill failed: ${message}`);
  process.exit(1);
});
