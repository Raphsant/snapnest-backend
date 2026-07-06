# Read-Only Admin Module — Investigation Report & Proposal

Date: 2026-07-06
Scope: `snapnest-backend` (NestJS + Prisma). Pre-implementation findings for the
web admin panel's read-only module, plus the proposed build plan.

Task as specified: add `ADMIN` to the `AccountType` enum (migration), add an
`AdminGuard` that checks the database row, and add read-only admin endpoints
(agencies, members, folders, folder contents, batched view URLs).

---

## Finding 1 — Step 1 is a no-op: `ADMIN` already exists

The enum already contains `ADMIN`, both in `prisma/schema.prisma` and in the
original init migration:

```prisma
enum AccountType {
  PERSONAL
  AGENCY_CLIENT
  AGENCY_STAFF
  ADMIN
}
```

The init migration (`prisma/migrations/20260508183346_init/migration.sql`)
created the Postgres type with `'ADMIN'` included:

```sql
CREATE TYPE "AccountType" AS ENUM ('PERSONAL', 'AGENCY_CLIENT', 'AGENCY_STAFF', 'ADMIN');
```

**There is no schema diff to show and no migration to run.** Seeding an account
as admin is a plain data update when ready — no schema change involved:

```sql
UPDATE "User" SET "accountType" = 'ADMIN' WHERE email = '<your email>';
```

## Finding 2 — an admin module already exists, and it has write endpoints

`src/admin/` already contains `admin.module.ts`, `admin.guard.ts`,
`admin.controller.ts`, and `admin.service.ts` (from the earlier agency work —
the "curl test passed" commit). The controller currently exposes three **POST**
endpoints:

- `POST /admin/agencies` — create an agency
- `POST /admin/agency-memberships` — create a membership (by user email)
- `POST /admin/agencies/:agencyId/folders` — create an agency folder

This conflicts with "new read-only module / no create-update-delete anywhere in
it."

**Recommendation:** keep the existing POSTs and add the new GET endpoints
alongside them. Removing them would break the only seeding mechanism for
agencies/memberships that exists today. If strict read-only is required, the
reads can be split into a separate controller, or the writes deleted — owner's
call.

## Finding 3 — the AdminGuard also already exists and meets the DB-row rule

`src/admin/admin.guard.ts` checks `request.user.accountType === AccountType.ADMIN`
and throws `ForbiddenException` (403) otherwise.

That satisfies "database row, never token payload" *transitively*: `AuthGuard`
runs first and builds `request.user` from a fresh `prisma.user` row on **every
request** (`syncUserFromToken` → `toAuthenticatedUser(dbUser)`). `accountType`
never comes from token claims — Cognito tokens don't carry it at all.

**Recommendation:** keep the guard as-is, since it is already backed by a
per-request DB read. A belt-and-braces variant (the guard doing its own
`findUnique`) is possible but redundant.

---

## Proposed Step 3 implementation (the new work)

All additions inside `src/admin/`, following the agency service's existing
conventions: `UploadStatus.UPLOADED` filter for file counts and contents,
`sizeBytes` BigInt→string serialization, `NotFoundException` for folders that
are not agency folders.

### Files to change

1. **`src/admin/admin.service.ts`** — add read methods:
   - `listAgencies()` — all agencies with `_count` of memberships and folders.
   - `getAgencyMembers(agencyId)` — memberships joined with
     `user: { select: { id, email, firstName } }` — no `cognitoSub`, no
     Cognito-internal fields.
   - `getAgencyFolders(agencyId)` — the agency's folders with UPLOADED-only
     `_count.files`.
   - `getAgencyFolderContents(folderId)` — folder contents (UPLOADED only),
     each file including `ownerId` + owner's `firstName`/`email`. **404 when
     the folder's `agencyId IS NULL`** — personal folders are invisible to this
     module by design.
   - `getAdminBatchViewUrls(fileIds)` — batched presigned GET URLs, scope
     `agencyId: { not: null }` + `uploadStatus: UPLOADED`. Personal files are
     silently omitted from results (same omission behavior as the existing
     owner-scoped batch endpoint).
   - Presigning: the admin service gets its own small S3 presign helper (same
     `ConfigService` pattern as `UploadsService`). Reusing `UploadsService`
     would require exporting it from `UploadsModule` and adding an
     admin-scoped method to the files module, which the constraints rule out
     ("don't touch files module internals").

2. **`src/admin/dto/admin-batch-view-urls.dto.ts`** (new) — `fileIds`
   validation cloned from the existing `BatchViewUrlsDto`, minus `agencyId`.

3. **`src/admin/admin.controller.ts`** — add the new routes, all under the
   existing controller-level `@UseGuards(AuthGuard, AdminGuard)`:
   - `GET /admin/agencies`
   - `GET /admin/agencies/:agencyId/members`
   - `GET /admin/agencies/:agencyId/folders`
   - `GET /admin/folders/:folderId`
   - `POST /admin/files/view-urls` (read-only semantics; POST for the body)

Nothing outside `src/admin/` gets touched. The existing owner-scoped
`POST /files/view-urls` stays untouched.

### Open decisions (blocking)

- (a) Confirm no migration is needed (Finding 1).
- (b) Keep or remove the existing admin POST endpoints (Finding 2).
- (c) AdminGuard as-is vs. adding its own DB query (Finding 3).

---

## Test plan (curl)

- Non-admin token on every `/admin` route → 403.
- After seeding the account as ADMIN: agencies list, members, folders, folder
  contents all return correct data.
- `GET /admin/folders/:id` with a PERSONAL folder id → 404.
- `POST /admin/files/view-urls` with a personal fileId → that file refused
  (omitted from results).
- Existing app endpoints unaffected (spot-check `GET /me`, `GET /folders`).
