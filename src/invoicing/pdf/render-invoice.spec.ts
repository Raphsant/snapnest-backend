import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeDueDate, computeTotals } from '../invoice-math';
import { RenderInvoiceInput, renderInvoicePdf } from './render-invoice';

const utc = (y: number, m: number, d: number): Date =>
  new Date(Date.UTC(y, m - 1, d));

const ISSUER: RenderInvoiceInput['issuer'] = {
  legalName: 'Samywamy LLC',
  dba: 'DBA Stocks Trading Club',
  addressLine1: '7302 Augusta Pines Dr',
  addressLine2: 'Spring, TX 77389',
  phone: '+1 (346) 382-2024',
  ein: '84-2376591',
  paymentLines: [],
};

/** Page objects only: "/Type /Page" not followed by "s" (the Pages tree). */
function pageCount(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type \/Page(?![a-zA-Z])/g) ?? [])
    .length;
}

function expectPdf(pdf: Buffer): void {
  expect(Buffer.isBuffer(pdf)).toBe(true);
  expect(pdf.subarray(0, 4).toString('latin1')).toBe('%PDF');
}

/** Renders, writes to os.tmpdir() for manual inspection, logs the path. */
async function renderAndSave(
  name: string,
  input: RenderInvoiceInput,
): Promise<Buffer> {
  const pdf = await renderInvoicePdf(input);
  const file = path.join(os.tmpdir(), `snapnest-${name}.pdf`);
  await fs.writeFile(file, pdf);
  console.log(`${name}: ${file} (${pageCount(pdf)} page(s))`);
  return pdf;
}

// (a) The seeded STC-2026-001 row.
const SEEDED: RenderInvoiceInput = {
  invoiceNo: 'STC-2026-001',
  kind: 'INVOICE',
  invoiceDate: utc(2026, 10, 13),
  dueDate: utc(2026, 10, 13),
  terms: 'Due upon receipt',
  language: 'EN',
  issuer: ISSUER,
  billTo: { name: 'Alpha Alliance', lines: [] },
  items: [
    {
      name: 'Evento Houston / Evento Reus / Evento Madrid',
      description:
        'Turnkey Event Production — end-to-end planning, venue sourcing, catering and on-site coordination',
      qty: 1,
      unitPriceCents: 1_200_000,
      amountCents: 1_200_000,
    },
  ],
  subtotalCents: 1_200_000,
  taxCents: 0,
  totalCents: 1_200_000,
  taxRateBps: 0,
  notes:
    'First invoice in the series. Issued before the dashboard existed; PDF not stored.',
  replacesInvoiceNo: null,
};

// (b) 40 items, Net 30, 8.25% tax, Spanish.
function longSpanishInvoice(): RenderInvoiceInput {
  const cities = ['Houston', 'Reus', 'Madrid'];
  const lineItems = Array.from({ length: 40 }, (_, i) => ({
    name: `Clip ${i + 1}: Evento ${cities[i % 3]}`,
    description:
      i % 4 === 0
        ? 'Producción integral — edición, subtítulos, corrección de color y entrega en formato vertical 9:16 para redes sociales'
        : 'Edición — corte vertical 9:16',
    qty: (i % 3) + 1,
    unitPriceCents: 12_500 + i * 1_000,
  }));
  const totals = computeTotals(lineItems, 825);
  const invoiceDate = utc(2026, 10, 15);
  return {
    invoiceNo: 'STC-2026-002',
    kind: 'INVOICE',
    invoiceDate,
    dueDate: computeDueDate(invoiceDate, 'Net 30'),
    terms: 'Net 30',
    language: 'ES',
    issuer: ISSUER,
    billTo: {
      name: 'Alpha Alliance',
      lines: [
        'Attn: María López',
        '1200 Main St',
        'Houston, TX 77002',
        'maria@alpha.example',
      ],
    },
    items: lineItems.map((item, i) => ({
      ...item,
      amountCents: totals.items[i].amountCents,
    })),
    subtotalCents: totals.subtotalCents,
    taxCents: totals.taxCents,
    totalCents: totals.totalCents,
    taxRateBps: 825,
    notes: 'Pago a 30 días.',
    replacesInvoiceNo: null,
  };
}

// (c) Credit note replacing STC-2026-001.
const CREDIT_NOTE: RenderInvoiceInput = {
  invoiceNo: 'STC-CN-2026-001',
  kind: 'CREDIT_NOTE',
  invoiceDate: utc(2026, 10, 20),
  dueDate: utc(2026, 10, 20),
  terms: 'Due upon receipt',
  language: 'EN',
  issuer: {
    ...ISSUER,
    paymentLines: ['Credit applied to the next invoice for this client.'],
  },
  billTo: { name: 'Alpha Alliance', lines: [] },
  items: [
    {
      name: 'Evento Reus',
      description: 'Turnkey Event Production — cancelled leg, credited in full',
      qty: 1,
      unitPriceCents: 400_000,
      amountCents: 400_000,
    },
  ],
  subtotalCents: 400_000,
  taxCents: 0,
  totalCents: 400_000,
  taxRateBps: 0,
  notes: 'Evento Reus was cancelled by the client.',
  replacesInvoiceNo: 'STC-2026-001',
};

describe('renderInvoicePdf', () => {
  it('renders the seeded STC-2026-001 shape on one page', async () => {
    const pdf = await renderAndSave('invoice-a-STC-2026-001', SEEDED);
    expectPdf(pdf);
    expect(pageCount(pdf)).toBe(1);
  });

  it('paginates a 40-item ES invoice at Net 30 with 8.25% tax', async () => {
    const pdf = await renderAndSave(
      'invoice-b-STC-2026-002-es',
      longSpanishInvoice(),
    );
    expectPdf(pdf);
    expect(pageCount(pdf)).toBeGreaterThan(1);
  });

  it('renders a credit note that replaces an invoice', async () => {
    const pdf = await renderAndSave('invoice-c-STC-CN-2026-001', CREDIT_NOTE);
    expectPdf(pdf);
    expect(pageCount(pdf)).toBe(1);
  });
});
