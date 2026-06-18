import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { FileType, UploadStatus } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { ThumbnailService } from '../src/uploads/thumbnail.service';
import { UploadsModule } from '../src/uploads/uploads.module';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const prisma = app.get(PrismaService);
    const thumbnailService = app
      .select(UploadsModule)
      .get(ThumbnailService, { strict: true });

    const files = await prisma.mediaFile.findMany({
      where: {
        fileType: FileType.PHOTO,
        uploadStatus: UploadStatus.UPLOADED,
        thumbnailS3Key: null,
      },
      orderBy: { createdAt: 'asc' },
    });

    const total = files.length;
    let successes = 0;
    let failures = 0;

    console.log(`Found ${total} photos without thumbnails`);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      console.log(`Processing ${i + 1} of ${total}: ${file.fileName}`);
      const key = await thumbnailService.generateThumbnailForFile(file.id);
      if (key !== null) {
        successes += 1;
      } else {
        failures += 1;
      }
    }

    console.log(
      `Done: ${successes} thumbnails generated, ${failures} failed`,
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
