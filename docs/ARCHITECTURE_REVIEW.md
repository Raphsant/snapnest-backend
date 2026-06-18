# SnapNest Backend — Architecture & Fragility Review

**Stack:** NestJS + TypeScript + Prisma 7 + Postgres, AWS Cognito (JWT), S3 (presigned URLs + sharp thumbnails), RDS Postgres.

**Context:** Solo founder, pre-production, local testing. Review based on `src/`, `prisma/schema.prisma`, and config. No code changes — diagnosis only.

---

## The five things that will actually hurt you

1. **`completeUpload` marks media ready without checking S3** — trust-based; broken views, fake “uploaded” state, easy abuse.
2. **`UploadJob.expiresAt` is stored but never enforced** — stale completes and abandoned `PENDING` rows/S3 objects with no cleanup.
3. **Thumbnail runs inline on `completeUpload` with full-object download into memory** — latency spikes and OOM risk under large photos or concurrency.
4. **`sslmode=no-verify` on RDS** (in `DATABASE_URL`) — encrypted but not authenticated; MITM-viable on hostile networks.
5. **S3 ↔ Postgres are not one atomic unit** — delete order and abandoned uploads leave orphans (cost, privacy, confusing library state).

---

## Critical (fix before real users)

### 1. Upload completion does not verify S3

**What:** `completeUpload` flips `UploadJob` → `COMPLETED` and `MediaFile` → `UPLOADED` with no `HeadObject`, size check, or ETag match. It never checks that the client actually PUT the object.

**Where:** `src/uploads/uploads.service.ts` (~203–214), then thumbnail at ~214.

**Why it matters:** Any authenticated user who got an `uploadId` can call complete without uploading. View URLs 404 or return empty objects; your DB lies about library state; support/debugging becomes “ghost files.” This is the biggest integrity hole in a presigned-upload flow.

**Fix effort:** ~half day — `HeadObject` (existence + optional `ContentLength` vs `sizeBytes`), reject if missing; optionally compare MIME/extension. Return 409/422, not 200.

---

### 2. Presign/job expiry is write-only

**What:** `expiresAt` is set at create (15 min presign TTL) but **`completeUpload` never reads `job.expiresAt`**. `JobStatus.FAILED` / `UploadStatus.FAILED` / `UPLOADING` exist in the schema but are **never set in `src/`**.

**Where:** Job creation `src/uploads/uploads.service.ts` (~158–165); complete (~179–214).

**Why it matters:** Old jobs can be completed arbitrarily late; abandoned `PENDING` rows + S3 objects accumulate forever (no cron, no lifecycle hook in code). You will pay storage and confuse the app.

**Fix effort:** ~1 day — enforce expiry on complete; background job or S3 lifecycle for orphans; mark failed states explicitly.

---

### 3. Thumbnail on the hot path — memory and latency

**What:** After DB commit, `completeUpload` **awaits** `generateThumbnailForFile`, which downloads the **entire** object into a `Buffer` (`src/uploads/thumbnail.service.ts` ~117–130), then runs `sharp` (~67–73). Failures are swallowed (~92–98) — upload still succeeds (good), but the request still paid the cost until failure.

**Why it matters:** A 24–48 MP phone photo can be tens of MB in RAM per request; 3–5 concurrent completes on a small Node instance → OOM or multi-second p99. Thumbnail failure does **not** break upload (by design); **slowness and memory do**.

**When it bites:** ~dozens of concurrent photo completes, or one user batch-uploading hundreds of images.

**Fix effort:** ~1–2 days to move to async (queue/SQS/Lambda); hours for a quick guard (`limitInputPixels`, max dimension reject, stream pipeline).

---

### 4. `sslmode=no-verify` on RDS

**What:** Connection string uses `sslmode=no-verify` (`.env` `DATABASE_URL`). `PrismaPg` passes it straight through (`src/prisma/prisma.service.ts` ~13–15). No custom `ssl: { ca, rejectUnauthorized: true }`.

**Real risk:** Traffic is encrypted but the client **does not verify** the server certificate. On a compromised network (coffee-shop Wi‑Fi, malicious resolver), an attacker could MITM the DB stream and read/write SQL (including media metadata, keys in queries, user rows). Risk is **low on AWS-only private networking**, **non-trivial** if the API ever connects to RDS over the public internet or from a laptop with that URL.

**Proper fix:** Download [AWS RDS combined CA bundle](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html), configure `pg` with `ssl: { ca: bundle, rejectUnauthorized: true }` on the adapter (often `sslmode=verify-full` or no sslmode in URL + explicit options). Use a **separate** URL for Prisma CLI/Studio (`sslmode=require`) if the adapter still fights URL params.

**Effort:** ~1–3 hours if you already know the adapter’s SSL shape; half day if you fight Prisma 7 + `PrismaPg` docs.

---

### 5. Split-brain S3 and Postgres (not transactional)

| Flow | Behavior | Orphan |
|------|----------|--------|
| Create presign | DB row `PENDING` before client PUT | S3 object, no complete → S3 + DB junk |
| Complete (no S3 check) | DB `UPLOADED` | DB row, no/minimal S3 |
| Delete | S3 delete best-effort, then DB delete | DB delete fails → row points at deleted/missing S3; S3 delete fails → row deleted but object remains |

**Where:** Delete flow `src/uploads/uploads.service.ts` (~355–362, ~367–378).

**Why it matters:** User media + billing + GDPR-style delete expectations need “delete means gone everywhere.” Today delete is **best-effort S3, mandatory DB** — privacy-friendly for DB, leaky for S3 on failure.

**Fix effort:** ~1 day — outbox/retry queue for S3 deletes; complete only after S3 proof; periodic reconciler (list prefix vs DB).

---

### Also critical-adjacent (still before scale)

- **`GET /files` returns `PENDING` uploads** — `getUserFiles` (~295–306) has no `uploadStatus: UPLOADED` filter (unlike batch view URLs ~236–241). Activity feed can show files that were never completed or failed mid-flight.
- **CORS blocks PATCH/DELETE from browsers** — `src/main.ts` (~58–62) only allows `GET`, `POST`. Native app is fine; any web client calling move/delete will fail preflight.
- **PII in logs** — `src/auth/auth.guard.ts` (~47–49) logs `email` on **every** authenticated request. CloudWatch cost + compliance noise; not a bypass, but a leak surface.
- **`.env` holds live RDS credentials** — gitignored (good), but tools/agents can expose them; rotate if this file was ever shared or committed.

---

## Worth fixing soon

**Ownership checks are consistent** — Every data path scopes by `userId` / `ownerId`: uploads, batch view URLs, move, delete, folders. No IDOR on file/folder mutation if JWT is valid. Batch omits unknown IDs silently (no URL leak) — acceptable.

**JWT verification is solid for a Cognito ID-token API** — `aws-jwt-verify` with `tokenUse: 'id'` and `clientId` (`src/auth/cognito-verifier.ts`). Access tokens won’t pass. Guard on all sensitive controllers; only `/` and `/health` are open. Startup fails without Cognito env. No global bypass.

**Gaps worth tightening:**

- Path params (`uploadId`, `fileId`, folder `id`) have **no `ParseUUIDPipe`** — invalid UUIDs may surface as Prisma/500 instead of 404.
- DTOs: `CreateUploadDto` has no `@MaxLength` on `fileName`/`mimeType`, no `@Max` on `sizeBytes`; `mimeType` is unconstrained (non-media types default to `PHOTO` in `fileTypeFromMimeType`).
- Presigned PUT has no `Content-Length` / size condition — client can upload a different size than declared.
- **Duplicate `S3Client` construction** in `UploadsService` and `ThumbnailService` — drift risk when you add IAM role / endpoint config.
- **Long-lived `AWS_ACCESS_KEY_ID` in env** — move to instance/task role before prod.
- **`getFolderById` includes all files** without `uploadStatus` filter.
- **Folder delete** only blocks non-empty **files**, not child folders — hierarchy edge case.
- **Health** doesn’t check DB/S3 (`src/app.controller.ts`).
- **Prisma dev logging** logs all queries in non-production — ensure `NODE_ENV=production` in deploy.
- **No tests** for auth, uploads, or ownership — only default e2e hello.

---

## Minor / ignore for now

- Redundant `@@index([cognitoSub])` when `@unique` already exists (`prisma/schema.prisma`).
- Unused enum states (`UPLOADING`, `IN_PROGRESS`, `FAILED`) — schema ahead of app.
- `getBatchViewUrls` sequential presign loop — fine until batch size × latency hurts.
- Agency/review enums in schema with no API yet — not a bug.
- Default Nest README — no ops runbook.
- No `any` in `src/` — typings are clean.

---

## Scale (flag, not urgent)

| Concern | When it hurts |
|--------|----------------|
| Sync thumbnail on complete | ~10+ concurrent photo completes on one Node task |
| Auth DB round-trip per request (`syncUserFromToken`) | High QPS; cache user by `cognitoSub` after first hit |
| Batch view URLs: 2× presigns × N sequential | 100 IDs → 200 serial AWS calls |
| No connection-pool tuning on `PrismaPg` | Many Lambdas/instances hitting RDS |
| `getUserFiles` cursor on `(ownerId, createdAt)` | Index exists in schema — good for now |

---

## What's actually good

- **Clear module split** — `auth`, `folders`, `uploads`, `prisma`; controllers thin, services hold logic.
- **Ownership pattern is boring and correct** — check `ownerId`/`userId` before mutate; batch queries filter `ownerId`.
- **Global `ValidationPipe`** with whitelist + forbidNonWhitelisted (`main.ts`).
- **Presign + DB create in a transaction** — no half-created job without `MediaFile`.
- **Idempotent complete** when already uploaded.
- **S3 key layout** `users/{userId}/raw/...` + sanitized filenames.
- **Cascade deletes** on user/folder/file relations in schema — DB cleanup model is sane.
- **Thumbnail failures don’t fail upload** — right product tradeoff; wrong place (sync on complete).
- **BigInt JSON** handled globally plus explicit serialize in service.
- **Cognito verifier** is the right library and configuration for ID tokens.

---

## Bottom line

Security against cross-user access is in good shape for the endpoints that exist. The real pre-launch risk is **upload integrity** (complete without S3 proof, no expiry, `PENDING` in listings) and **operational fragility** (inline sharp, split S3/DB, `no-verify` SSL).

**Priority:** Fix #1 and #2 before real users; #3 before you stress-test uploads; #4 before production RDS from anything other than a locked-down VPC; #5 as you care about storage cost and true deletion.

---

*Generated from code review of `snapnest-backend` — June 2026.*
