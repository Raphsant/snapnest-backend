# SnapNest Backend — project context

This is the SnapNest backend API. SnapNest is an iOS media capture app
(React Native/Expo, separate repo — never modify or assume mobile code from
here; if a mobile-side change seems needed, stop and say so) where users
record photos/videos that auto-upload to S3. It has a multi-tenant agency
layer: agencies have client users, folder templates, and a produced-content
review workflow.

## Stack
- NestJS + TypeScript, strict typing (no `any`; code must pass strict checks)
- Prisma ORM with the pg adapter → RDS PostgreSQL
- **The database is shared by local dev and the Railway deployment.**
  Migrations applied locally hit the same RDS the deployed backend uses —
  additive migrations only unless explicitly discussed.
- Deployed on Railway (Nixpacks)
- Auth: AWS Cognito (JWT bearer tokens on all endpoints)
- Storage: S3 bucket `snapnest-uploads-dev-rs` (private; access only via
  presigned URLs). Connection-string dialects differ by client: Prisma uses
  `sslmode=no-verify`; psql/psycopg need `sslmode=require`; neither accepts
  `schema=public`.
- Jobs: SQS queue `snapnest-pipeline-jobs` (us-east-2, 3600s visibility
  timeout), consumed by a separate Python worker (not in this repo)

## Upload flow
1. App calls `POST /uploads` with file metadata → API creates the file
   record and returns a presigned PUT URL (15-min expiry).
   - With `hasThumbnail: true`, it also derives a thumbnail key via
     `deriveThumbnailS3Key`, persists `thumbnailS3Key` immediately, and
     returns `thumbnailUploadUrl` (presigned PUT bound to
     `Content-Type: image/jpeg`).
2. App uploads directly to S3, then calls `POST /uploads/{id}/complete`.
   - Optional `thumbnailUploaded: boolean`: false nulls `thumbnailS3Key` in
     the same transaction that marks the file UPLOADED.
   - Server-side thumbnail fallback runs ONLY when `thumbnailS3Key` is null
     at that moment — it must never overwrite a client-uploaded thumbnail.
     (Its EXIF handling is known-flawed; do not "fix" it as a drive-by.)
   - Completion is idempotent: already-completed jobs short-circuit early.
3. File listings return `thumbnailUrl` (presigned GET via the existing
   `getBatchViewUrls` / `getAdminBatchViewUrls` paths) or null.

## Invariants
- Multi-tenant isolation is absolute: agency/client scoping enforced at the
  query level; never trust IDs from the client without permission checks.
- Everything is private by default; no public S3 access, ever.
- Presigned GET expiry stays short (~1h); URL generation follows the
  existing batch pattern — don't invent new per-row presigning paths.

## House rules — non-negotiable
1. Before writing any code, list the files you plan to touch and wait for
   approval.
2. Then one file at a time: show the full diff, stop, wait for confirmation
   before the next file.
3. No new dependencies without asking first.
4. No refactors, renames, or cleanups outside the stated task scope.
5. Prisma schema changes come with a proper migration (see shared-RDS note
   above).
6. Unit tests or type-checks passing is not proof a feature works — the
   user verifies with live curl against the running server before anything
   is committed. Never commit or push unless explicitly told to.
