import type { InvoiceKind } from '@prisma/client';

/**
 * Pure invoice arithmetic and formatting. No Prisma client, no I/O: the
 * InvoiceKind import is type-only ('INVOICE' | 'CREDIT_NOTE').
 *
 * Money is integer cents and tax is integer basis points throughout.
 */

/** Thrown for any input these functions reject; callers map it to a 400. */
export class InvoiceMathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvoiceMathError';
  }
}

export type ParsedInvoiceNo = {
  kind: InvoiceKind;
  year: number;
  seq: number;
};

export type TotalsInputItem = { qty: number; unitPriceCents: number };

export type InvoiceTotals = {
  items: { amountCents: number }[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
};

const INVOICE_NO_RE = /^STC-(CN-)?(\d{4})-(\d{3})$/;
const NET_TERMS_RE = /^net\s*(\d+)$/i;
const SUMMARY_PREFIX_SEPARATOR = ' — ';
const SUMMARY_NAME_SEPARATOR = ' / ';
const SUMMARY_MAX_LENGTH = 200;
const MAX_SEQ = 999;
const MAX_TAX_RATE_BPS = 10_000;

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

export function formatInvoiceNo(
  kind: InvoiceKind,
  year: number,
  seq: number,
): string {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) {
    throw new InvoiceMathError(`Invalid invoice year: ${year}`);
  }
  if (!Number.isInteger(seq) || seq < 1 || seq > MAX_SEQ) {
    throw new InvoiceMathError(`Invoice sequence out of range: ${seq}`);
  }
  const prefix = kind === 'CREDIT_NOTE' ? 'STC-CN' : 'STC';
  return `${prefix}-${year}-${pad(seq, 3)}`;
}

export function parseInvoiceNo(s: string): ParsedInvoiceNo | null {
  const match = INVOICE_NO_RE.exec(s);
  if (match === null) {
    return null;
  }
  const seq = Number(match[3]);
  if (seq < 1) {
    return null;
  }
  return {
    kind: match[1] === undefined ? 'INVOICE' : 'CREDIT_NOTE',
    year: Number(match[2]),
    seq,
  };
}

/** Same day for "Due upon receipt" and unrecognised terms; +N UTC days for "Net N". */
export function computeDueDate(invoiceDate: Date, terms: string): Date {
  const due = new Date(invoiceDate.getTime());
  const match = NET_TERMS_RE.exec(terms.trim());
  if (match !== null) {
    const days = Number(match[1]);
    if (days > 0) {
      due.setUTCDate(due.getUTCDate() + days);
    }
  }
  return due;
}

export function computeTotals(
  items: TotalsInputItem[],
  taxRateBps: number,
): InvoiceTotals {
  if (items.length === 0) {
    throw new InvoiceMathError('Invoice must have at least one item');
  }
  if (
    !Number.isInteger(taxRateBps) ||
    taxRateBps < 0 ||
    taxRateBps > MAX_TAX_RATE_BPS
  ) {
    throw new InvoiceMathError(`Invalid tax rate (bps): ${taxRateBps}`);
  }

  const computed = items.map((item, index) => {
    if (!Number.isInteger(item.qty) || item.qty < 1) {
      throw new InvoiceMathError(`Item ${index + 1}: invalid qty ${item.qty}`);
    }
    if (!Number.isInteger(item.unitPriceCents) || item.unitPriceCents < 0) {
      throw new InvoiceMathError(
        `Item ${index + 1}: invalid unitPriceCents ${item.unitPriceCents}`,
      );
    }
    return { amountCents: item.qty * item.unitPriceCents };
  });

  const subtotalCents = computed.reduce((sum, i) => sum + i.amountCents, 0);
  const taxCents = Math.round((subtotalCents * taxRateBps) / MAX_TAX_RATE_BPS);
  return {
    items: computed,
    subtotalCents,
    taxCents,
    totalCents: subtotalCents + taxCents,
  };
}

/** "$12,000.00"; negatives as "-$12,000.00". Integer arithmetic, no Intl. */
export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) {
    throw new InvoiceMathError(`Invalid cents value: ${cents}`);
  }
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = String(Math.floor(abs / 100)).replace(
    /\B(?=(\d{3})+(?!\d))/g,
    ',',
  );
  return `${sign}$${dollars}.${pad(abs % 100, 2)}`;
}

export function pdfFilename(
  invoiceNo: string,
  clientCode: string,
  invoiceDate: Date,
): string {
  return `${invoiceNo}_${clientCode}_${invoiceDate.toISOString().slice(0, 10)}.pdf`;
}

export function servicesSummary(
  items: { name: string; description: string }[],
): string {
  const names = items.map((item) => item.name).join(SUMMARY_NAME_SEPARATOR);

  const prefixes = items.map((item) => {
    const at = item.description.indexOf(SUMMARY_PREFIX_SEPARATOR);
    return at > 0 ? item.description.slice(0, at) : null;
  });
  const first = prefixes[0];
  const sharedPrefix =
    first !== undefined &&
    first !== null &&
    prefixes.every((prefix) => prefix === first)
      ? first
      : null;

  const summary = sharedPrefix === null ? names : `${sharedPrefix}: ${names}`;
  return summary.length > SUMMARY_MAX_LENGTH
    ? `${summary.slice(0, SUMMARY_MAX_LENGTH - 1)}…`
    : summary;
}
