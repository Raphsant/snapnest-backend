import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Backfills MediaFile.displayName for existing rows. For each folder, files with
 * a null displayName (ordered by createdAt ASC) are named `${folder.name} NN`,
 * continuing the folder's captureSeq, and the folder's captureSeq is advanced to
 * the last number used. One transaction per folder, so a mid-run failure never
 * leaves a folder partly named.
 *
 * Idempotent: once every file in a folder has a displayName, a re-run finds no
 * null-displayName rows and advances nothing. Unfiled files are named
 * "Unfiled NN" because the system folder's name is "Unfiled".
 *
 * Pass --dry-run to print the plan without writing.
 */
async function main(): Promise<void> {
  const dryRun: boolean = process.argv.includes('--dry-run');
  const prefix: string = dryRun ? '[dry-run] ' : '';

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const prisma = app.get(PrismaService);

    const folders = await prisma.folder.findMany({
      select: { id: true, name: true, captureSeq: true },
      orderBy: { createdAt: 'asc' },
    });

    console.log(`${prefix}Scanning ${folders.length} folder(s) for unnamed files`);

    let foldersTouched = 0;
    let filesNamed = 0;

    for (const folder of folders) {
      const files = await prisma.mediaFile.findMany({
        where: { folderId: folder.id, displayName: null },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });

      if (files.length === 0) {
        continue;
      }

      // Continue numbering from the folder's current counter; the last value
      // used becomes the folder's new captureSeq so future captures keep going.
      let seq: number = folder.captureSeq;
      const plan: { id: string; displayName: string }[] = files.map((file) => {
        seq += 1;
        return {
          id: file.id,
          displayName: `${folder.name} ${String(seq).padStart(2, '0')}`,
        };
      });

      foldersTouched += 1;
      filesNamed += plan.length;

      console.log(
        `Folder ${folder.id} (${folder.name}): naming ${plan.length} file(s) ` +
          `"${plan[0].displayName}" … "${plan[plan.length - 1].displayName}", ` +
          `captureSeq ${folder.captureSeq} -> ${seq}`,
      );

      if (dryRun) {
        continue;
      }

      // Single transaction per folder: every file name plus the counter advance
      // commit together.
      await prisma.$transaction([
        ...plan.map((entry) =>
          prisma.mediaFile.update({
            where: { id: entry.id },
            data: { displayName: entry.displayName },
          }),
        ),
        prisma.folder.update({
          where: { id: folder.id },
          data: { captureSeq: seq },
        }),
      ]);
    }

    console.log(
      `${prefix}Done: ${filesNamed} file(s) named across ${foldersTouched} folder(s)`,
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
