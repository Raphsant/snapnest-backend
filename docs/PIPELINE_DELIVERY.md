# Pipeline outputs listing + delivery of final clips into agency folders

Implementation log and reference for the admin/pipeline feature that lists a
job's assembled clips and delivers a chosen clip into an agency client's folder
as a normal-shaped `MediaFile`.

- **Scope guard:** admin/pipeline module + one new Prisma model (`PipelineDelivery`)
  plus an additive `FileSource` enum value. No changes to worker message
  contracts, pipeline stages, or upload endpoints.
- **Status:** code complete and statically verified; **not committed**. Awaiting
  live curl verification (Step 5) before commit.

---

## 1. Ground truth established during discovery

- **Final outputs live in S3, not on the `PipelineJob` row.** There is no
  `checkpoints` column; the only mutable JSON is `manifest`
  (`{ clips: [{ id, approved, hook_prompt?, close_prompt?, post_copy? }], status? }`).
  The assemble stage (external Python worker) writes final clips to:

  ```
  pipeline/<jobId>/final/final_<clipId>_9x16.mp4
  ```

  Confirmed on completed job `2d875543-871d-4f4d-bc14-181aea950492`
  (e.g. `pipeline/.../final/final_clip_04_9x16.mp4`, 13,589,634 bytes).

- **Agency scoping.** There is no `clientId` field anywhere — the "agency
  client" is the `User` referenced by `ownerId`.
  - `Folder`: `ownerId` (client), `agencyId` (`null` ⇒ personal), `type`
    (`FolderType`), `isSystem`, `parentFolderId`. *Agency folder* = `agencyId != null`;
    *system folder* = `isSystem`.
  - `MediaFile`: `ownerId`, `agencyId` (`null` ⇒ personal), `folderId`,
    `fileName`, `mimeType`, `sizeBytes` (BigInt), `s3Key` (unique), `fileType`,
    `source`, `uploadStatus`, `reviewStatus`, `durationSeconds`, `thumbnailS3Key`.
    (No `isSystem`, no `clientId`, no `type` — the discriminator is `fileType`.)

- **Normal agency-upload key layout is owner-scoped, not folder-scoped:**
  `users/<ownerId>/raw/<ts>-<uuid>-<sanitizedFileName>`. The folder is only a DB
  association (`folderId`), never part of the key.

- **Existing endpoint reused for the client-folder dropdown:**
  `GET /admin/agencies/:agencyId/members/:userId/folders`
  (`AdminService.getMemberFolders`).

- **Job list/detail already serialized `sourceFileId`** (scalar). The list also
  included `sourceFile { id, fileName }`; the detail (`getJob`) returned raw
  scalars only. Step 1 adds the source file name + agency client to **both**.

---

## 2. Database changes

### Schema (`prisma/schema.prisma`)

```prisma
enum FileSource {
  CAMERA
  GALLERY
  PIPELINE            // added — origin marker for pipeline-delivered clips
}

model PipelineDelivery {
  id        String   @id @default(uuid())
  jobId     String
  clipId    String
  fileId    String   // delivered MediaFile
  folderId  String
  createdAt DateTime @default(now())

  @@unique([jobId, clipId, folderId])
}
```

Bare scalar FKs (no `@relation`), so `PipelineJob`/`MediaFile`/`Folder` are
unchanged. The composite unique index also serves the `where { jobId }` and
`where { jobId, clipId }` lookups (left-prefix), so no extra index is needed.

### Migration (`prisma/migrations/20260720181814_add_pipeline_delivery/migration.sql`)

```sql
-- AlterEnum
ALTER TYPE "FileSource" ADD VALUE 'PIPELINE';

-- CreateTable
CREATE TABLE "PipelineDelivery" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "clipId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PipelineDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PipelineDelivery_jobId_clipId_folderId_key" ON "PipelineDelivery"("jobId", "clipId", "folderId");
```

- Purely **additive** (new enum value + new table); safe against the shared RDS.
- The new enum value is **added but never used in the same file** (the
  `CREATE TABLE` has no `FileSource` column), honoring the Postgres constraint.
- Hand-authored to match Prisma 7's exact output (no shadow DB is configured, so
  `migrate dev` is unsafe here). Applied with `prisma migrate deploy`
  (applies pending migrations only; no reset).

---

## 3. Files touched

| File | Change |
|------|--------|
| `prisma/schema.prisma` | `FileSource.PIPELINE` + `PipelineDelivery` model |
| `prisma/migrations/20260720181814_add_pipeline_delivery/migration.sql` | new migration |
| `src/pipeline/dto/deliver-clip.dto.ts` | **new** — `DeliverClipDto` |
| `src/pipeline/pipeline.service.ts` | Step 1 include + `getJobDetail`, `getJobOutputs`, `deliverClip`, S3 helpers |
| `src/pipeline/pipeline.controller.ts` | detail route → `getJobDetail`; `+ GET …/outputs`, `+ POST …/deliver` |
| `src/pipeline/pipeline.module.ts` | provide `ThumbnailService` |

---

## 4. API

All routes are under `@Controller('admin/pipeline')`, guarded by
`AuthGuard + AdminGuard` (admin Cognito JWT required).

### `GET /admin/pipeline/jobs` and `GET /admin/pipeline/jobs/:id` (Step 1)

Both now serialize the source file and its agency client. The `sourceFile`
include was extended to:

```ts
sourceFile: {
  select: {
    id: true,
    fileName: true,
    owner: { select: { id: true, firstName: true, email: true } },
  },
}
```

- `sourceFileId` was already present (scalar).
- The detail route now calls `getJobDetail` (enriched). The internal `getJob`
  stays raw so the `approve`/`approve-creative` flows keep their response shape.
- Client "display name" is `firstName ?? email` (no dedicated field on `User`).

### `GET /admin/pipeline/jobs/:id/outputs` (Step 3)

Lists assembled clips, resolved from S3 (not the manifest).

- `404` if the job doesn't exist.
- `ListObjectsV2` on `pipeline/<jobId>/final/` (paginated).
- Each key's **basename** is parsed with `/^final_(.+)_9x16\.mp4$/`; non-matching
  keys are skipped.
- Response: array of

  ```jsonc
  {
    "clipId": "clip_04",
    "s3Key": "pipeline/<jobId>/final/final_clip_04_9x16.mp4",
    "sizeBytes": 13589634,              // from the S3 listing
    "presignedUrl": "https://…",        // presigned GET, 15 min
    "deliveries": [ /* PipelineDelivery rows for this jobId+clipId */ ]
  }
  ```

- Empty array (`[]`) when the prefix has no objects (job not assembled yet).

### `POST /admin/pipeline/jobs/:id/deliver` (Step 4)

Body: `{ "clipId": string, "folderId": string }` (returns **200** on success via
`@HttpCode(HttpStatus.OK)`).

Flow, in order:

1. **`clipId` charset** — `DeliverClipDto` `@Matches(/^[A-Za-z0-9_-]+$/)` rejects
   `/`, `..`, etc. with **400** before the handler runs; the service re-checks
   defensively.
2. **Job** lookup (+ `sourceFile.ownerId`) → **404** unknown job.
3. **Assembled output** — deterministic `sourceKey =
   pipeline/<jobId>/final/final_<clipId>_9x16.mp4`, then `HeadObject`; miss →
   **404** `"no assembled output for that clipId"`. Size taken from
   `ContentLength`.
4. **Folder invariants** — each its own **422** message, in this order:
   1. folder exists → `"destination folder does not exist"`
   2. `agencyId != null` → `"destination folder is not agency-scoped"`
   3. `!isSystem` → `"destination folder is a system folder"`
   4. `folder.agencyId === job.agencyId` → `"…different agency than the job's source file"`
   5. `folder.ownerId === job.sourceFile.ownerId` → `"…different agency client than the job's source file"`
5. **CopyObject** → `users/<folder.ownerId>/raw/<ts>-<uuid>-final_<clipId>_9x16.mp4`.
6. **Transaction** (one): create the `MediaFile`
   (`ownerId = folder.ownerId`, `agencyId = job.agencyId`, `folderId`,
   `fileName = final_<clipId>_9x16.mp4`, `mimeType = video/mp4`,
   `sizeBytes = BigInt(headSize)`, `fileType = VIDEO`, `source = PIPELINE`,
   `uploadStatus = UPLOADED`, `thumbnailS3Key = null`) + create the
   `PipelineDelivery` row.
7. **Failure handling** — the object is copied *before* the transaction, so on
   any transaction failure the copied object is deleted (best-effort) before
   rethrowing. A unique violation (`P2002`) → **409**
   `{ message, fileId: <existing delivery's fileId>, folderId }`.
8. **Post-commit** — `thumbnailService.generateThumbnailForFile(fileId)` (see
   note below).
9. Returns `{ fileId, folderId }`.

---

## 5. Design notes / decisions

- **`source = PIPELINE`.** New `FileSource` value rather than reusing
  `CAMERA`/`GALLERY`, so pipeline-delivered clips are distinguishable.
- **Thumbnail fallback is a no-op for video.** `ThumbnailService`
  generates for `PHOTO` only, so a delivered `VIDEO` keeps `thumbnailS3Key = null`.
  The call is wired for parity with upload-complete and future support; it is
  **not** extended to video in this task. (Accepted: in the folder-contents
  check, `thumbnailS3Key: null` is a PASS.)
- **Deterministic source key.** The clip's S3 key is derived from
  `(jobId, clipId)`, not read from the manifest.
- **`clipId` safety.** Restricted to `[A-Za-z0-9_-]+` at the DTO layer (400) and
  re-checked in the service, so no path separator/traversal can reach an S3 key.
- **`CopySource`** is `` `${bucket}/${sourceKey}` `` un-encoded — safe because
  both keys are pure `[A-Za-z0-9/_.-]`.
- **Module wiring.** `ThumbnailService` is provided directly in `PipelineModule`
  (its deps — `ConfigService`, `PrismaService` — are global), so `UploadsModule`
  is left untouched.
- **System-folder check is defense-in-depth.** Personal and the system
  "Unfiled" folder both have `agencyId = null`, so they trip the *agency-scoped*
  422 first; an agency-scoped `isSystem` folder isn't produced by normal data.

---

## 6. Verification performed (static)

- `npx tsc --noEmit` → 0
- `npx nest build` → 0
- DI smoke test: `NestFactory.createApplicationContext(AppModule)` resolved
  `PipelineService` (and its S3 client + `ThumbnailService`) without error.
- `prisma migrate deploy` applied `20260720181814_add_pipeline_delivery` to the
  shared RDS; `prisma migrate status` → "Database schema is up to date."

> Per project house rules, static checks are **not** proof the feature works —
> the live curl plan below is the acceptance gate, run before any commit.

---

## 7. Live test plan (Step 5)

```bash
BASE=http://localhost:3000            # PORT ?? 3000
ADMIN="Authorization: Bearer <ADMIN_COGNITO_JWT>"
JOB=2d875543-871d-4f4d-bc14-181aea950492

VALID_FOLDER=<agency folder owned by JOB's source-file client, non-system>
OTHER_FOLDER=<agency folder owned by the OTHER test client>
PERSONAL_FOLDER=<a personal folder (agencyId NULL) or the system "Unfiled" folder>
```

**(a) outputs → presigned URL that plays**
```bash
curl -s -H "$ADMIN" "$BASE/admin/pipeline/jobs/$JOB/outputs" | jq
URL=$(curl -s -H "$ADMIN" "$BASE/admin/pipeline/jobs/$JOB/outputs" \
  | jq -r '.[] | select(.clipId=="clip_04") | .presignedUrl')
curl -sI "$URL" | head -5      # expect HTTP 200 + Content-Type: video/mp4
```

**(b) deliver clip_04 to a valid folder → 200; then it appears in folder contents (thumbnail null = PASS)**
```bash
curl -s -X POST -H "$ADMIN" -H "Content-Type: application/json" \
  -d '{"clipId":"clip_04","folderId":"'"$VALID_FOLDER"'"}' \
  "$BASE/admin/pipeline/jobs/$JOB/deliver" | jq        # → { fileId, folderId }, HTTP 200

curl -s -H "$ADMIN" "$BASE/admin/folders/$VALID_FOLDER" \
  | jq '.files[] | select(.fileName=="final_clip_04_9x16.mp4") | {id,fileName,uploadStatus,source,thumbnailS3Key}'
# expect: uploadStatus "UPLOADED", source "PIPELINE", thumbnailS3Key null
```

**(c) repeat the same deliver → 409 with the prior fileId**
```bash
curl -s -w "\n%{http_code}\n" -X POST -H "$ADMIN" -H "Content-Type: application/json" \
  -d '{"clipId":"clip_04","folderId":"'"$VALID_FOLDER"'"}' \
  "$BASE/admin/pipeline/jobs/$JOB/deliver"
# → 409 { "message":"clip already delivered to this folder", "fileId":"<same as (b)>", "folderId":"…" }
```

**(d) deliver to the OTHER client's folder → 422 (client/agency mismatch)**
```bash
curl -s -w "\n%{http_code}\n" -X POST -H "$ADMIN" -H "Content-Type: application/json" \
  -d '{"clipId":"clip_04","folderId":"'"$OTHER_FOLDER"'"}' \
  "$BASE/admin/pipeline/jobs/$JOB/deliver"
```

**(e) deliver to a personal or system folder → 422 ("not agency-scoped")**
```bash
curl -s -w "\n%{http_code}\n" -X POST -H "$ADMIN" -H "Content-Type: application/json" \
  -d '{"clipId":"clip_04","folderId":"'"$PERSONAL_FOLDER"'"}' \
  "$BASE/admin/pipeline/jobs/$JOB/deliver"
```

**(f) unknown clipId → 404**
```bash
curl -s -w "\n%{http_code}\n" -X POST -H "$ADMIN" -H "Content-Type: application/json" \
  -d '{"clipId":"clip_99","folderId":"'"$VALID_FOLDER"'"}' \
  "$BASE/admin/pipeline/jobs/$JOB/deliver"
# → 404 "no assembled output for that clipId"
```

**Bonus — 400 charset gate**
```bash
curl -s -w "\n%{http_code}\n" -X POST -H "$ADMIN" -H "Content-Type: application/json" \
  -d '{"clipId":"../../etc","folderId":"'"$VALID_FOLDER"'"}' \
  "$BASE/admin/pipeline/jobs/$JOB/deliver"      # → 400 (rejected before any S3 key is built)
```

---

## 8. Not done / follow-ups

- **No commit** until the live plan above passes.
- Delivered videos have no thumbnail (fallback is photo-only). If video
  thumbnails are wanted later, that's a separate task (client- or worker-supplied
  thumbnail, or extending `ThumbnailService` to video).
