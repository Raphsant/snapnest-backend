import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  InvoiceKind,
  InvoiceLanguage,
  InvoiceStatus,
  PrismaClient,
} from '@prisma/client';

/**
 * Manual seed for the invoicing module. Not wired into `prisma db seed`.
 *
 * Creates issuer profile v1, client ALPHA, the 2026 INVOICE counter, and
 * invoice STC-2026-001 (issued before the dashboard existed, so no PDF is
 * stored) with its single line item. No CREDIT_NOTE counter is created; the
 * service creates counters on demand.
 *
 * Idempotent: each row is looked up by its natural unique key and only
 * written (via upsert) when absent. Re-running changes nothing, including
 * rows that already exist with different values — those are reported as
 * already present and left untouched.
 *
 * DATABASE_URL is the shared RDS used by the deployed backend.
 *
 * Run: npx ts-node --files -r dotenv/config prisma/seed-invoicing.ts
 */

const SEED_CREATED_BY = 'seed-invoicing';
const INVOICE_YEAR = 2026;
const INVOICE_TOTAL_CENTS = 1_200_000;

/** UTC midnight, so @db.Date stores exactly this calendar day. */
function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === '') {
    console.error(`Missing required env var: ${name}`);
    process.exit(2);
  }
  return value;
}

interface SeedLine {
  entity: string;
  id: string;
  created: boolean;
}

async function main(): Promise<void> {
  const connectionString = requireEnv('DATABASE_URL');

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
    log: ['error', 'warn'],
  });

  try {
    const lines = await prisma.$transaction(async (tx): Promise<SeedLine[]> => {
      const seeded: SeedLine[] = [];

      // 1. Issuer profile v1
      const profileWhere = { version: 1 };
      const existingProfile = await tx.issuerProfile.findUnique({
        where: profileWhere,
      });
      const profile =
        existingProfile ??
        (await tx.issuerProfile.upsert({
          where: profileWhere,
          update: {},
          create: {
            version: 1,
            legalName: 'Samywamy LLC',
            dba: 'DBA Stocks Trading Club',
            addressLine1: '7302 Augusta Pines Dr',
            addressLine2: 'Spring, TX 77389',
            phone: '+1 (346) 382-2024',
            ein: '84-2376591',
            paymentLines: [],
            isCurrent: true,
            createdById: null,
          },
        }));
      seeded.push({
        entity: 'IssuerProfile v1',
        id: profile.id,
        created: existingProfile === null,
      });

      // 2. Client ALPHA
      const clientWhere = { code: 'ALPHA' };
      const existingClient = await tx.invoiceClient.findUnique({
        where: clientWhere,
      });
      const client =
        existingClient ??
        (await tx.invoiceClient.upsert({
          where: clientWhere,
          update: {},
          create: {
            code: 'ALPHA',
            name: 'Alpha Alliance',
            contactName: null,
            email: null,
            phone: null,
            addressLine1: null,
            addressLine2: null,
            notes: 'Event services client',
          },
        }));
      seeded.push({
        entity: 'InvoiceClient ALPHA',
        id: client.id,
        created: existingClient === null,
      });

      // 3. INVOICE counter for 2026
      const counterWhere = {
        kind_year: { kind: InvoiceKind.INVOICE, year: INVOICE_YEAR },
      };
      const existingCounter = await tx.invoiceCounter.findUnique({
        where: counterWhere,
      });
      const counter =
        existingCounter ??
        (await tx.invoiceCounter.upsert({
          where: counterWhere,
          update: {},
          create: { kind: InvoiceKind.INVOICE, year: INVOICE_YEAR, lastSeq: 1 },
        }));
      seeded.push({
        entity: `InvoiceCounter INVOICE/${INVOICE_YEAR}`,
        id: `${counter.kind}/${counter.year} lastSeq=${counter.lastSeq}`,
        created: existingCounter === null,
      });

      // 4. Invoice STC-2026-001
      const invoiceWhere = { invoiceNo: 'STC-2026-001' };
      const existingInvoice = await tx.invoice.findUnique({
        where: invoiceWhere,
      });
      const invoice =
        existingInvoice ??
        (await tx.invoice.upsert({
          where: invoiceWhere,
          update: {},
          create: {
            invoiceNo: 'STC-2026-001',
            kind: InvoiceKind.INVOICE,
            year: INVOICE_YEAR,
            seq: 1,
            issuerProfileId: profile.id,
            clientId: client.id,
            billToName: 'Alpha Alliance',
            billToLines: [],
            invoiceDate: utcDate(2026, 10, 13),
            terms: 'Due upon receipt',
            dueDate: utcDate(2026, 10, 13),
            taxRateBps: 0,
            subtotalCents: INVOICE_TOTAL_CENTS,
            taxCents: 0,
            totalCents: INVOICE_TOTAL_CENTS,
            status: InvoiceStatus.ISSUED,
            language: InvoiceLanguage.EN,
            servicesSummary:
              'Turnkey Event Production: Evento Houston / Evento Reus / Evento Madrid',
            notes:
              'First invoice in the series. Issued before the dashboard existed; PDF not stored.',
            pdfS3Key: null,
            pdfFilename: 'Invoice_STC-2026-001_Alpha_Alliance.pdf',
            pdfError: null,
            createdById: SEED_CREATED_BY,
          },
        }));
      seeded.push({
        entity: 'Invoice STC-2026-001',
        id: invoice.id,
        created: existingInvoice === null,
      });

      // 5. Line item 1 of STC-2026-001
      const itemWhere = {
        invoiceId_position: { invoiceId: invoice.id, position: 1 },
      };
      const existingItem = await tx.invoiceItem.findUnique({
        where: itemWhere,
      });
      const item =
        existingItem ??
        (await tx.invoiceItem.upsert({
          where: itemWhere,
          update: {},
          create: {
            invoiceId: invoice.id,
            position: 1,
            name: 'Evento Houston / Evento Reus / Evento Madrid',
            description:
              'Turnkey Event Production — end-to-end planning, venue sourcing, catering and on-site coordination',
            qty: 1,
            unitPriceCents: INVOICE_TOTAL_CENTS,
            amountCents: INVOICE_TOTAL_CENTS,
          },
        }));
      seeded.push({
        entity: 'InvoiceItem STC-2026-001 #1',
        id: item.id,
        created: existingItem === null,
      });

      return seeded;
    });

    // Logged after commit so "created" never describes a rolled-back write.
    for (const line of lines) {
      console.log(
        `${line.entity}: ${line.id} (${line.created ? 'created' : 'already present'})`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
