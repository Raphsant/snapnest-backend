import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  InvoiceClient,
  InvoiceKind,
  InvoiceLanguage,
  InvoiceStatus,
  IssuerProfile,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  computeDueDate,
  computeTotals,
  formatInvoiceNo,
  InvoiceMathError,
  InvoiceTotals,
  pdfFilename,
  servicesSummary,
} from './invoice-math';
import { RenderInvoiceInput, renderInvoicePdf } from './pdf/render-invoice';

// ---------------------------------------------------------------------------
// Input/output types (mirrored by DTOs later)
// ---------------------------------------------------------------------------

export type InvoiceClientInput = {
  code: string;
  name: string;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  notes?: string | null;
};

export type UpdateInvoiceClientInput = Partial<InvoiceClientInput>;

export type IssuerProfileInput = {
  legalName: string;
  dba: string;
  addressLine1: string;
  addressLine2: string;
  phone: string;
  ein: string;
  paymentLines: string[];
};

export type IssueInvoiceItemInput = {
  name: string;
  description: string;
  qty: number;
  unitPriceCents: number;
};

/** No totals fields: amounts are always computed server-side. */
export type IssueInvoiceInput = {
  kind: InvoiceKind;
  clientId: string;
  /** YYYY-MM-DD */
  invoiceDate: string;
  terms: string;
  taxRateBps: number;
  language: InvoiceLanguage;
  notes?: string | null;
  replacesInvoiceId?: string | null;
  items: IssueInvoiceItemInput[];
};

export type ListInvoicesFilter = {
  status?: InvoiceStatus;
  year?: number;
  clientId?: string;
};

export type MarkPaidInput = {
  /** YYYY-MM-DD */
  paidDate: string;
  paymentRef?: string | null;
};

export type VoidInvoiceInput = { reason: string };

const invoiceDetailInclude = {
  items: { orderBy: { position: 'asc' } },
  client: true,
  issuerProfile: true,
  replaces: { select: { id: true, invoiceNo: true } },
} satisfies Prisma.InvoiceInclude;

export type InvoiceDetail = Prisma.InvoiceGetPayload<{
  include: typeof invoiceDetailInclude;
}>;

const invoiceListInclude = {
  client: { select: { id: true, code: true, name: true } },
} satisfies Prisma.InvoiceInclude;

export type InvoiceListItem = Prisma.InvoiceGetPayload<{
  include: typeof invoiceListInclude;
}> & {
  /**
   * Today minus dueDate in whole UTC days (negative = not yet due). Open
   * invoices only (kind INVOICE, status ISSUED), else null.
   */
  daysOutstanding: number | null;
};

export type InvoiceListResult = {
  invoices: InvoiceListItem[];
  /** Sum of totalCents over open invoices (kind INVOICE, status ISSUED). */
  openTotalCents: number;
};

export type InvoiceDownloadUrl = { url: string; fileName: string };

type BillToSource = Pick<
  InvoiceClient,
  'contactName' | 'addressLine1' | 'addressLine2' | 'email' | 'phone'
>;

const CLIENT_CODE_PATTERN = /^[A-Z]{3,8}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SEQ = 999;
const PDF_URL_TTL_SECONDS = 15 * 60;
const MS_PER_DAY = 86_400_000;

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/** Strict YYYY-MM-DD -> UTC midnight, so @db.Date stores that calendar day. */
function parseIsoDate(value: string, field: string): Date {
  if (ISO_DATE_PATTERN.test(value)) {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (
      !Number.isNaN(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    ) {
      return date;
    }
  }
  throw new BadRequestException(`${field} must be a valid YYYY-MM-DD date`);
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcToday(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

function assertClientCode(code: string): void {
  if (!CLIENT_CODE_PATTERN.test(code)) {
    throw new BadRequestException('code must be 3-8 uppercase letters');
  }
}

/** Runs an invoice-math helper, mapping its validation errors to 400. */
function withMathValidation<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error: unknown) {
    if (error instanceof InvoiceMathError) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }
}

/**
 * Bill To lines snapshotted onto the invoice at issue time: non-empty
 * contactName, addressLine1, addressLine2, email, phone, in that order. The
 * bill_to_snapshot migration backfills older rows with the same rule.
 */
function billToLinesFor(client: BillToSource): string[] {
  return [
    client.contactName,
    client.addressLine1,
    client.addressLine2,
    client.email,
    client.phone,
  ].filter((line): line is string => line !== null && line.trim() !== '');
}

@Injectable()
export class InvoicingService {
  private readonly logger = new Logger(InvoicingService.name);
  private readonly s3Client: S3Client;
  private readonly bucketName: string;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    const region = configService.getOrThrow<string>('AWS_REGION');
    const credentials = {
      accessKeyId: configService.getOrThrow<string>('AWS_ACCESS_KEY_ID'),
      secretAccessKey: configService.getOrThrow<string>(
        'AWS_SECRET_ACCESS_KEY',
      ),
    };
    this.s3Client = new S3Client({ region, credentials });
    this.bucketName = configService.getOrThrow<string>('S3_BUCKET');
  }

  // -------------------------------------------------------------------------
  // Clients
  // -------------------------------------------------------------------------

  listClients(): Promise<InvoiceClient[]> {
    return this.prisma.invoiceClient.findMany({ orderBy: { code: 'asc' } });
  }

  async createClient(input: InvoiceClientInput): Promise<InvoiceClient> {
    assertClientCode(input.code);
    try {
      return await this.prisma.invoiceClient.create({ data: input });
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          `Client code ${input.code} is already in use`,
        );
      }
      throw error;
    }
  }

  async updateClient(
    id: string,
    input: UpdateInvoiceClientInput,
  ): Promise<InvoiceClient> {
    if (input.code !== undefined) {
      assertClientCode(input.code);
    }
    const existing = await this.prisma.invoiceClient.findUnique({
      where: { id },
      select: { id: true },
    });
    if (existing === null) {
      throw new NotFoundException(`Client ${id} not found`);
    }
    try {
      return await this.prisma.invoiceClient.update({
        where: { id },
        data: input,
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          `Client code ${input.code ?? ''} is already in use`,
        );
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Issuer profile
  // -------------------------------------------------------------------------

  async getCurrentIssuer(): Promise<IssuerProfile> {
    const issuer = await this.prisma.issuerProfile.findFirst({
      where: { isCurrent: true },
    });
    if (issuer === null) {
      throw new NotFoundException('No current issuer profile');
    }
    return issuer;
  }

  /**
   * Appends version max+1 and makes it the only current profile. Earlier
   * versions stay as-is: issued invoices reference them by id.
   */
  async createIssuerVersion(
    input: IssuerProfileInput,
    createdById: string,
  ): Promise<IssuerProfile> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const { _max } = await tx.issuerProfile.aggregate({
          _max: { version: true },
        });
        await tx.issuerProfile.updateMany({
          where: { isCurrent: true },
          data: { isCurrent: false },
        });
        return tx.issuerProfile.create({
          data: {
            ...input,
            version: (_max.version ?? 0) + 1,
            isCurrent: true,
            createdById,
          },
        });
      });
    } catch (error: unknown) {
      // Two concurrent creates race on version (or the isCurrent partial index).
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'Issuer profile was changed concurrently; retry',
        );
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Numbering
  // -------------------------------------------------------------------------

  /**
   * Informational preview for `year` (default: current UTC year), so the
   * dashboard can preview a backdated invoiceDate. Reads the counter WITHOUT
   * locking — the deliberate exception to the InvoiceCounter rule — so the
   * number can be taken by a concurrent issue. issue() never uses it.
   */
  async peekNextNumber(
    kind: InvoiceKind,
    year: number = new Date().getUTCFullYear(),
  ): Promise<{ invoiceNo: string }> {
    const counter = await this.prisma.invoiceCounter.findUnique({
      where: { kind_year: { kind, year } },
      select: { lastSeq: true },
    });
    const seq = (counter?.lastSeq ?? 0) + 1;
    if (seq > MAX_SEQ) {
      throw new ConflictException(
        `Invoice numbers for ${kind} ${year} are exhausted`,
      );
    }
    // A malformed year is a 400 from formatInvoiceNo's validation.
    return {
      invoiceNo: withMathValidation(() => formatInvoiceNo(kind, year, seq)),
    };
  }

  /**
   * Allocates the next seq for (kind, year). Must run inside the transaction
   * that inserts the Invoice: the FOR UPDATE row lock serialises concurrent
   * issues until that transaction commits or rolls back.
   */
  private async allocateSeq(
    tx: Prisma.TransactionClient,
    kind: InvoiceKind,
    year: number,
  ): Promise<number> {
    let rows = await this.lockCounter(tx, kind, year);
    if (rows.length === 0) {
      await tx.$executeRaw`
        INSERT INTO "InvoiceCounter" ("kind", "year", "lastSeq")
        VALUES (${kind}::"InvoiceKind", ${year}::int, 0)
        ON CONFLICT DO NOTHING`;
      rows = await this.lockCounter(tx, kind, year);
    }
    const row = rows[0];
    if (row === undefined) {
      throw new InternalServerErrorException(
        `Invoice counter ${kind}/${year} could not be locked`,
      );
    }

    const seq = row.lastSeq + 1;
    if (seq > MAX_SEQ) {
      throw new ConflictException(
        `Invoice numbers for ${kind} ${year} are exhausted`,
      );
    }
    await tx.invoiceCounter.update({
      where: { kind_year: { kind, year } },
      data: { lastSeq: seq },
    });
    return seq;
  }

  private lockCounter(
    tx: Prisma.TransactionClient,
    kind: InvoiceKind,
    year: number,
  ): Promise<{ lastSeq: number }[]> {
    return tx.$queryRaw<{ lastSeq: number }[]>`
      SELECT "lastSeq" FROM "InvoiceCounter"
      WHERE "kind" = ${kind}::"InvoiceKind" AND "year" = ${year}::int
      FOR UPDATE`;
  }

  // -------------------------------------------------------------------------
  // Issue
  // -------------------------------------------------------------------------

  async issue(
    input: IssueInvoiceInput,
    createdById: string,
  ): Promise<InvoiceDetail> {
    const invoiceDate = parseIsoDate(input.invoiceDate, 'invoiceDate');
    const totals: InvoiceTotals = withMathValidation(() =>
      computeTotals(input.items, input.taxRateBps),
    );
    const year = invoiceDate.getUTCFullYear();
    const dueDate = computeDueDate(invoiceDate, input.terms);
    const summary = servicesSummary(input.items);

    let invoiceId: string;
    try {
      invoiceId = await this.prisma.$transaction(async (tx) => {
        const client = await tx.invoiceClient.findUnique({
          where: { id: input.clientId },
        });
        if (client === null) {
          throw new NotFoundException(`Client ${input.clientId} not found`);
        }

        const replacesInvoiceId = input.replacesInvoiceId ?? null;
        if (replacesInvoiceId !== null) {
          await this.assertReplaceable(
            tx,
            input.kind,
            replacesInvoiceId,
            client.id,
          );
        }

        const issuer = await tx.issuerProfile.findFirst({
          where: { isCurrent: true },
          select: { id: true },
        });
        if (issuer === null) {
          throw new ConflictException('No current issuer profile');
        }

        // Last step before the insert, so the counter lock is held briefly.
        const seq = await this.allocateSeq(tx, input.kind, year);
        const invoiceNo = formatInvoiceNo(input.kind, year, seq);

        const invoice = await tx.invoice.create({
          data: {
            invoiceNo,
            kind: input.kind,
            year,
            seq,
            issuerProfileId: issuer.id,
            clientId: client.id,
            billToName: client.name,
            billToLines: billToLinesFor(client),
            invoiceDate,
            terms: input.terms,
            dueDate,
            taxRateBps: input.taxRateBps,
            subtotalCents: totals.subtotalCents,
            taxCents: totals.taxCents,
            totalCents: totals.totalCents,
            status: InvoiceStatus.ISSUED,
            language: input.language,
            notes: input.notes ?? null,
            servicesSummary: summary,
            replacesInvoiceId,
            pdfFilename: pdfFilename(invoiceNo, client.code, invoiceDate),
            createdById,
            items: {
              create: input.items.map((item, index) => ({
                position: index + 1,
                name: item.name,
                description: item.description,
                qty: item.qty,
                unitPriceCents: item.unitPriceCents,
                amountCents: totals.items[index].amountCents,
              })),
            },
          },
          select: { id: true },
        });
        return invoice.id;
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'Invoice number collision; retry the request',
        );
      }
      throw error;
    }

    // After commit: a render/upload failure never un-issues the invoice.
    await this.renderAndStore(invoiceId);
    return this.getInvoice(invoiceId);
  }

  /**
   * The referenced invoice must belong to the same client. An INVOICE may
   * only replace a VOID invoice (correction flow); a CREDIT_NOTE may only
   * reference an ISSUED or PAID one. FOR SHARE blocks a concurrent
   * void/markPaid of the referenced row until this transaction ends.
   */
  private async assertReplaceable(
    tx: Prisma.TransactionClient,
    kind: InvoiceKind,
    replacesInvoiceId: string,
    clientId: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<
      { status: InvoiceStatus; clientId: string }[]
    >`
      SELECT "status", "clientId" FROM "Invoice" WHERE "id" = ${replacesInvoiceId}
      FOR SHARE`;
    const replaced = rows[0];
    if (replaced === undefined) {
      throw new NotFoundException(`Invoice ${replacesInvoiceId} not found`);
    }
    if (replaced.clientId !== clientId) {
      throw new ConflictException(
        `Invoice ${replacesInvoiceId} belongs to a different client`,
      );
    }
    const allowed: InvoiceStatus[] =
      kind === InvoiceKind.INVOICE
        ? [InvoiceStatus.VOID]
        : [InvoiceStatus.ISSUED, InvoiceStatus.PAID];
    if (!allowed.includes(replaced.status)) {
      throw new ConflictException(
        `A ${kind} cannot reference invoice ${replacesInvoiceId} while its status is ${replaced.status}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  async getInvoice(id: string): Promise<InvoiceDetail> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: invoiceDetailInclude,
    });
    if (invoice === null) {
      throw new NotFoundException(`Invoice ${id} not found`);
    }
    return invoice;
  }

  async listInvoices(filter: ListInvoicesFilter): Promise<InvoiceListResult> {
    const rows = await this.prisma.invoice.findMany({
      where: {
        status: filter.status,
        year: filter.year,
        clientId: filter.clientId,
      },
      include: invoiceListInclude,
      orderBy: [{ invoiceDate: 'desc' }, { seq: 'desc' }],
    });

    const today = utcToday().getTime();
    let openTotalCents = 0;
    const invoices = rows.map((row): InvoiceListItem => {
      // Credit notes never become PAID, so they are never "open".
      const isOpen =
        row.kind === InvoiceKind.INVOICE && row.status === InvoiceStatus.ISSUED;
      if (isOpen) {
        openTotalCents += row.totalCents;
      }
      return {
        ...row,
        daysOutstanding: isOpen
          ? Math.round((today - row.dueDate.getTime()) / MS_PER_DAY)
          : null,
      };
    });
    return { invoices, openTotalCents };
  }

  async getDownloadUrl(id: string): Promise<InvoiceDownloadUrl> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      select: { pdfS3Key: true, pdfFilename: true },
    });
    if (invoice === null) {
      throw new NotFoundException(`Invoice ${id} not found`);
    }
    if (invoice.pdfS3Key === null) {
      throw new NotFoundException('PDF not available for this invoice');
    }
    const url = await getSignedUrl(
      this.s3Client,
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: invoice.pdfS3Key,
        ResponseContentDisposition: `attachment; filename="${invoice.pdfFilename}"`,
        ResponseContentType: 'application/pdf',
      }),
      { expiresIn: PDF_URL_TTL_SECONDS },
    );
    return { url, fileName: invoice.pdfFilename };
  }

  // -------------------------------------------------------------------------
  // Status transitions (the only mutations an issued invoice accepts)
  // -------------------------------------------------------------------------

  /** Invoices only: a credit note's terminal state is ISSUED or VOID. */
  async markPaid(id: string, input: MarkPaidInput): Promise<InvoiceDetail> {
    const paidDate = parseIsoDate(input.paidDate, 'paidDate');
    await this.transitionFromIssued(
      id,
      'marked paid',
      {
        status: InvoiceStatus.PAID,
        paidDate,
        paymentRef: input.paymentRef ?? null,
      },
      { invoicesOnly: true },
    );
    return this.getInvoice(id);
  }

  /** PAID invoices are corrected via credit note, not voided. */
  async void(id: string, input: VoidInvoiceInput): Promise<InvoiceDetail> {
    const reason = input.reason.trim();
    if (reason === '') {
      throw new BadRequestException('reason is required');
    }
    await this.transitionFromIssued(id, 'voided', {
      status: InvoiceStatus.VOID,
      voidReason: reason,
    });
    return this.getInvoice(id);
  }

  /** Conditional update on status = ISSUED; 404/409 when it matches nothing. */
  private async transitionFromIssued(
    id: string,
    action: string,
    data: Prisma.InvoiceUpdateManyMutationInput,
    { invoicesOnly = false }: { invoicesOnly?: boolean } = {},
  ): Promise<void> {
    const result = await this.prisma.invoice.updateMany({
      where: {
        id,
        status: InvoiceStatus.ISSUED,
        ...(invoicesOnly ? { kind: InvoiceKind.INVOICE } : {}),
      },
      data,
    });
    if (result.count === 1) {
      return;
    }
    const current = await this.prisma.invoice.findUnique({
      where: { id },
      select: { status: true, kind: true },
    });
    if (current === null) {
      throw new NotFoundException(`Invoice ${id} not found`);
    }
    if (invoicesOnly && current.kind === InvoiceKind.CREDIT_NOTE) {
      throw new ConflictException('Credit notes are not paid');
    }
    throw new ConflictException(
      `Invoice ${id} cannot be ${action} while its status is ${current.status}`,
    );
  }

  /**
   * Draft input for a replacement INVOICE, prefilled from the original. Writes
   * nothing and does not void: the caller voids explicitly, then issues the
   * draft (issue() requires the replaced invoice to be VOID by then).
   */
  async prepareCorrection(
    id: string,
  ): Promise<IssueInvoiceInput & { replacesInvoiceId: string }> {
    const invoice = await this.getInvoice(id);
    if (
      invoice.status !== InvoiceStatus.ISSUED &&
      invoice.status !== InvoiceStatus.VOID
    ) {
      throw new ConflictException(
        `Invoice ${id} cannot be corrected while its status is ${invoice.status}`,
      );
    }
    return {
      kind: InvoiceKind.INVOICE,
      clientId: invoice.clientId,
      invoiceDate: toIsoDate(utcToday()),
      terms: invoice.terms,
      taxRateBps: invoice.taxRateBps,
      language: invoice.language,
      replacesInvoiceId: invoice.id,
      items: invoice.items.map((item) => ({
        name: item.name,
        description: item.description,
        qty: item.qty,
        unitPriceCents: item.unitPriceCents,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // PDF
  // -------------------------------------------------------------------------

  /** Re-renders from stored rows and uploads; clears pdfError on success. */
  async renderPdf(id: string): Promise<InvoiceDetail> {
    await this.getInvoice(id);
    await this.renderAndStore(id);
    return this.getInvoice(id);
  }

  /**
   * Never throws for render/upload failures: records them in pdfError so the
   * invoice stays ISSUED and renderPdf can retry. An earlier successful
   * pdfS3Key is kept on failure (the object at that key is untouched).
   */
  private async renderAndStore(id: string): Promise<void> {
    const invoice = await this.getInvoice(id);
    const key = `invoices/${invoice.invoiceNo}/${invoice.pdfFilename}`;
    try {
      const pdf = await renderInvoicePdf(this.toRenderInput(invoice));
      // Server-side upload, like ThumbnailService: the PDF is generated here,
      // so there is no client to hand a presigned PUT to.
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: key,
          Body: pdf,
          ContentType: 'application/pdf',
        }),
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `PDF render/upload failed for ${invoice.invoiceNo}: ${message}`,
      );
      await this.prisma.invoice.update({
        where: { id },
        data: { pdfError: message },
      });
      return;
    }
    await this.prisma.invoice.update({
      where: { id },
      data: { pdfS3Key: key, pdfError: null },
    });
  }

  /**
   * Everything comes from the invoice's own snapshot: issuer via
   * issuerProfileId, Bill To via billToName/billToLines — never the live
   * client row, so a re-render cannot alter an issued document.
   */
  private toRenderInput(invoice: InvoiceDetail): RenderInvoiceInput {
    const { issuerProfile } = invoice;
    return {
      invoiceNo: invoice.invoiceNo,
      kind: invoice.kind,
      invoiceDate: invoice.invoiceDate,
      dueDate: invoice.dueDate,
      terms: invoice.terms,
      language: invoice.language,
      issuer: {
        legalName: issuerProfile.legalName,
        dba: issuerProfile.dba,
        addressLine1: issuerProfile.addressLine1,
        addressLine2: issuerProfile.addressLine2,
        phone: issuerProfile.phone,
        ein: issuerProfile.ein,
        paymentLines: issuerProfile.paymentLines,
      },
      billTo: { name: invoice.billToName, lines: invoice.billToLines },
      items: invoice.items.map((item) => ({
        name: item.name,
        description: item.description,
        qty: item.qty,
        unitPriceCents: item.unitPriceCents,
        amountCents: item.amountCents,
      })),
      subtotalCents: invoice.subtotalCents,
      taxCents: invoice.taxCents,
      totalCents: invoice.totalCents,
      taxRateBps: invoice.taxRateBps,
      notes: invoice.notes,
      replacesInvoiceNo: invoice.replaces?.invoiceNo ?? null,
    };
  }
}
