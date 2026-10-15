import PDFDocument from 'pdfkit';
import { formatCents } from '../invoice-math';
import { STC_LOGO_PNG } from './logo';

/**
 * Renders an invoice or credit note to a PDF buffer. Port of the reportlab
 * layout from the original Python generator: US Letter, 54pt margins,
 * Helvetica only (pdfkit's built-in standard fonts — no font files on disk).
 *
 * Layout is computed top-down with explicit y positions. Content stops at
 * CONTENT_BOTTOM; footers are drawn into the zone below it on every page once
 * all content exists, so "Page N of M" is known (bufferPages).
 */

export type RenderInvoiceInput = {
  invoiceNo: string;
  kind: 'INVOICE' | 'CREDIT_NOTE';
  invoiceDate: Date;
  dueDate: Date;
  terms: string;
  language: 'EN' | 'ES';
  issuer: {
    legalName: string;
    dba: string;
    addressLine1: string;
    addressLine2: string;
    phone: string;
    ein: string;
    paymentLines: string[];
  };
  /** lines = non-empty address/contact lines */
  billTo: { name: string; lines: string[] };
  items: {
    name: string;
    description: string;
    qty: number;
    unitPriceCents: number;
    amountCents: number;
  }[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  taxRateBps: number;
  notes: string | null;
  replacesInvoiceNo: string | null;
};

type Doc = PDFKit.PDFDocument;
type Language = RenderInvoiceInput['language'];
type Item = RenderInvoiceInput['items'][number];
type Align = 'left' | 'right' | 'center';

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;
const RIGHT_EDGE = PAGE_WIDTH - MARGIN;
const FOOTER_RULE_Y = PAGE_HEIGHT - MARGIN - 22;
const CONTENT_BOTTOM = FOOTER_RULE_Y - 12;

const INK = '#1B1B1B';
const MUTED = '#6B6B6B';
const RULE = '#D9D9D9';
const SOFT = '#F3F3F3';

const LOGO_WIDTH = 170;
const LINE_GAP = 1;
const CELL_PAD = 8;
const QTY_WIDTH = 50;
const UNIT_WIDTH = 95;
const AMOUNT_WIDTH = 95;
const DESC_WIDTH = CONTENT_WIDTH - QTY_WIDTH - UNIT_WIDTH - AMOUNT_WIDTH;
const DESC_TEXT_WIDTH = DESC_WIDTH - 2 * CELL_PAD;
const QTY_X = MARGIN + DESC_WIDTH;
const UNIT_X = QTY_X + QTY_WIDTH;
const AMOUNT_X = UNIT_X + UNIT_WIDTH;
const TABLE_HEADER_HEIGHT = 22;
const TOTALS_WIDTH = 280;
const GRAND_TOTAL_HEIGHT = 28;
const SIGNATURE_RULE_WIDTH = 200;

type TextStyle = {
  font: 'Helvetica' | 'Helvetica-Bold';
  size: number;
  color: string;
};

const STYLE = {
  title: { font: 'Helvetica-Bold', size: 30, color: INK },
  metaLabel: { font: 'Helvetica', size: 9, color: MUTED },
  metaValue: { font: 'Helvetica', size: 9, color: INK },
  heading: { font: 'Helvetica', size: 9, color: MUTED },
  partyName: { font: 'Helvetica-Bold', size: 10, color: INK },
  body: { font: 'Helvetica', size: 9.5, color: INK },
  tableHeader: { font: 'Helvetica-Bold', size: 9, color: INK },
  itemName: { font: 'Helvetica-Bold', size: 10, color: INK },
  itemDescription: { font: 'Helvetica', size: 9, color: MUTED },
  cell: { font: 'Helvetica', size: 10, color: INK },
  totalsLabel: { font: 'Helvetica', size: 10, color: MUTED },
  totalsValue: { font: 'Helvetica', size: 10, color: INK },
  grandTotal: { font: 'Helvetica-Bold', size: 12, color: INK },
  small: { font: 'Helvetica', size: 8.5, color: MUTED },
  footer: { font: 'Helvetica', size: 8, color: MUTED },
} satisfies Record<string, TextStyle>;

type Labels = {
  invoice: string;
  creditNote: string;
  invoiceNo: string;
  creditNoteNo: string;
  invoiceDate: string;
  paymentTerms: string;
  dueDate: string;
  from: string;
  billTo: string;
  description: string;
  qty: string;
  unitPrice: string;
  amount: string;
  subtotal: string;
  tax: string;
  totalDue: string;
  totalCredit: string;
  paymentInfo: string;
  genericPayment: string[];
  notes: string;
  replaces: string;
  signature: string;
  thanks: string;
  page: (n: number, count: number) => string;
};

const LABELS: Record<Language, Labels> = {
  EN: {
    invoice: 'INVOICE',
    creditNote: 'CREDIT NOTE',
    invoiceNo: 'Invoice No.',
    creditNoteNo: 'Credit Note No.',
    invoiceDate: 'Invoice Date',
    paymentTerms: 'Payment Terms',
    dueDate: 'Due Date',
    from: 'FROM',
    billTo: 'BILL TO',
    description: 'Description',
    qty: 'Qty',
    unitPrice: 'Unit Price',
    amount: 'Amount',
    subtotal: 'Subtotal',
    tax: 'Tax',
    totalDue: 'TOTAL DUE (USD)',
    totalCredit: 'TOTAL CREDIT (USD)',
    paymentInfo: 'PAYMENT INFORMATION',
    genericPayment: [
      'Please remit payment by the due date.',
      'Contact us for bank, Zelle or wire details.',
    ],
    notes: 'NOTES',
    replaces: 'Replaces',
    signature: 'Authorized signature',
    thanks: 'Thank you for your business.',
    page: (n, count) => `Page ${n} of ${count}`,
  },
  ES: {
    invoice: 'FACTURA',
    creditNote: 'NOTA DE CRÉDITO',
    invoiceNo: 'Factura N.º',
    creditNoteNo: 'Nota de crédito N.º',
    invoiceDate: 'Fecha de factura',
    paymentTerms: 'Condiciones de pago',
    dueDate: 'Fecha de vencimiento',
    from: 'DE',
    billTo: 'FACTURAR A',
    description: 'Descripción',
    qty: 'Cant.',
    unitPrice: 'Precio unit.',
    amount: 'Importe',
    subtotal: 'Subtotal',
    tax: 'Impuesto',
    totalDue: 'TOTAL A PAGAR (USD)',
    totalCredit: 'TOTAL DEL CRÉDITO (USD)',
    paymentInfo: 'INFORMACIÓN DE PAGO',
    genericPayment: [
      'Por favor, realice el pago antes de la fecha de vencimiento.',
      'Contáctenos para obtener los datos bancarios, de Zelle o de transferencia.',
    ],
    notes: 'NOTAS',
    replaces: 'Sustituye a',
    signature: 'Firma autorizada',
    thanks: 'Gracias por su confianza.',
    page: (n, count) => `Página ${n} de ${count}`,
  },
};

const MONTHS: Record<Language, string[]> = {
  EN: [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ],
  ES: [
    'enero',
    'febrero',
    'marzo',
    'abril',
    'mayo',
    'junio',
    'julio',
    'agosto',
    'septiembre',
    'octubre',
    'noviembre',
    'diciembre',
  ],
};

/** "October 15, 2026" / "15 de octubre de 2026", from the UTC calendar day. */
function formatDate(date: Date, language: Language): string {
  const day = date.getUTCDate();
  const month = MONTHS[language][date.getUTCMonth()];
  const year = date.getUTCFullYear();
  return language === 'EN'
    ? `${month} ${day}, ${year}`
    : `${day} de ${month} de ${year}`;
}

/** 825 -> "8.25%", 800 -> "8%". */
function formatTaxRate(bps: number): string {
  return `${bps / 100}%`;
}

/** Width/height from the PNG IHDR chunk, so the logo keeps its aspect. */
function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function applyStyle(doc: Doc, style: TextStyle): void {
  doc.font(style.font).fontSize(style.size).fillColor(style.color);
}

function measureText(
  doc: Doc,
  style: TextStyle,
  text: string,
  width: number,
): number {
  if (text === '') {
    return 0;
  }
  applyStyle(doc, style);
  return doc.heightOfString(text, { width, lineGap: LINE_GAP });
}

/** Draws text and returns its wrapped height. */
function drawText(
  doc: Doc,
  style: TextStyle,
  text: string,
  x: number,
  y: number,
  width: number,
  align: Align = 'left',
): number {
  const height = measureText(doc, style, text, width);
  if (height > 0) {
    doc.text(text, x, y, { width, align, lineGap: LINE_GAP });
  }
  return height;
}

function drawRule(
  doc: Doc,
  x1: number,
  x2: number,
  y: number,
  color: string = RULE,
): void {
  doc
    .save()
    .moveTo(x1, y)
    .lineTo(x2, y)
    .lineWidth(0.5)
    .strokeColor(color)
    .stroke()
    .restore();
}

function fillRect(
  doc: Doc,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
): void {
  doc.save().rect(x, y, width, height).fill(color).restore();
}

/** Logo left, title + meta pairs right. Returns the y below the header. */
function drawHeader(
  doc: Doc,
  input: RenderInvoiceInput,
  labels: Labels,
): number {
  const logo = pngSize(STC_LOGO_PNG);
  const logoHeight = (LOGO_WIDTH * logo.height) / logo.width;
  doc.image(STC_LOGO_PNG, MARGIN, MARGIN, { width: LOGO_WIDTH });

  const isCreditNote = input.kind === 'CREDIT_NOTE';
  const title = isCreditNote ? labels.creditNote : labels.invoice;
  let y =
    MARGIN +
    drawText(doc, STYLE.title, title, MARGIN, MARGIN, CONTENT_WIDTH, 'right') +
    6;

  const valueWidth = 140;
  const labelWidth = 110;
  const valueX = RIGHT_EDGE - valueWidth;
  const labelX = valueX - 10 - labelWidth;
  const rows: [string, string][] = [
    [isCreditNote ? labels.creditNoteNo : labels.invoiceNo, input.invoiceNo],
    [labels.invoiceDate, formatDate(input.invoiceDate, input.language)],
    [labels.paymentTerms, input.terms],
    [labels.dueDate, formatDate(input.dueDate, input.language)],
  ];
  for (const [label, value] of rows) {
    drawText(doc, STYLE.metaLabel, label, labelX, y, labelWidth, 'right');
    const height = drawText(
      doc,
      STYLE.metaValue,
      value,
      valueX,
      y,
      valueWidth,
      'right',
    );
    y += Math.max(height, 11) + 3;
  }

  return Math.max(MARGIN + logoHeight, y) + 28;
}

function drawParty(
  doc: Doc,
  x: number,
  top: number,
  width: number,
  heading: string,
  name: string,
  lines: string[],
): number {
  let y = top;
  y += drawText(doc, STYLE.heading, heading, x, y, width) + 4;
  y += drawText(doc, STYLE.partyName, name, x, y, width) + 2;
  for (const line of lines) {
    if (line.trim() !== '') {
      y += drawText(doc, STYLE.body, line, x, y, width);
    }
  }
  return y;
}

/** From (left) and Bill To (right). Returns the y below the taller block. */
function drawParties(
  doc: Doc,
  input: RenderInvoiceInput,
  labels: Labels,
  top: number,
): number {
  const gutter = 24;
  const columnWidth = (CONTENT_WIDTH - gutter) / 2;
  const { issuer } = input;
  const fromBottom = drawParty(
    doc,
    MARGIN,
    top,
    columnWidth,
    labels.from,
    issuer.legalName,
    [
      issuer.dba,
      issuer.addressLine1,
      issuer.addressLine2,
      issuer.phone,
      `EIN ${issuer.ein}`,
    ],
  );
  const billToBottom = drawParty(
    doc,
    MARGIN + columnWidth + gutter,
    top,
    columnWidth,
    labels.billTo,
    input.billTo.name,
    input.billTo.lines,
  );
  return Math.max(fromBottom, billToBottom) + 28;
}

/** Right-aligned numeric cell, inset from the column's right edge. */
function drawNumberCell(
  doc: Doc,
  style: TextStyle,
  text: string,
  x: number,
  width: number,
  y: number,
): void {
  drawText(doc, style, text, x, y, width - CELL_PAD, 'right');
}

function drawTableHeader(doc: Doc, labels: Labels, top: number): number {
  fillRect(doc, MARGIN, top, CONTENT_WIDTH, TABLE_HEADER_HEIGHT, SOFT);
  const y = top + 7;
  drawText(
    doc,
    STYLE.tableHeader,
    labels.description,
    MARGIN + CELL_PAD,
    y,
    DESC_TEXT_WIDTH,
  );
  drawNumberCell(doc, STYLE.tableHeader, labels.qty, QTY_X, QTY_WIDTH, y);
  drawNumberCell(
    doc,
    STYLE.tableHeader,
    labels.unitPrice,
    UNIT_X,
    UNIT_WIDTH,
    y,
  );
  drawNumberCell(
    doc,
    STYLE.tableHeader,
    labels.amount,
    AMOUNT_X,
    AMOUNT_WIDTH,
    y,
  );
  return top + TABLE_HEADER_HEIGHT;
}

function measureItemRow(doc: Doc, item: Item): number {
  const nameHeight = measureText(
    doc,
    STYLE.itemName,
    item.name,
    DESC_TEXT_WIDTH,
  );
  const descriptionHeight = measureText(
    doc,
    STYLE.itemDescription,
    item.description,
    DESC_TEXT_WIDTH,
  );
  return (
    CELL_PAD +
    nameHeight +
    (descriptionHeight > 0 ? 2 + descriptionHeight : 0) +
    CELL_PAD
  );
}

function drawItemRow(
  doc: Doc,
  item: Item,
  top: number,
  height: number,
): number {
  const y = top + CELL_PAD;
  const textX = MARGIN + CELL_PAD;
  const nameHeight = drawText(
    doc,
    STYLE.itemName,
    item.name,
    textX,
    y,
    DESC_TEXT_WIDTH,
  );
  drawText(
    doc,
    STYLE.itemDescription,
    item.description,
    textX,
    y + nameHeight + 2,
    DESC_TEXT_WIDTH,
  );
  drawNumberCell(doc, STYLE.cell, String(item.qty), QTY_X, QTY_WIDTH, y);
  drawNumberCell(
    doc,
    STYLE.cell,
    formatCents(item.unitPriceCents),
    UNIT_X,
    UNIT_WIDTH,
    y,
  );
  drawNumberCell(
    doc,
    STYLE.cell,
    formatCents(item.amountCents),
    AMOUNT_X,
    AMOUNT_WIDTH,
    y,
  );
  drawRule(doc, MARGIN, RIGHT_EDGE, top + height);
  return top + height;
}

/**
 * Each row is measured before drawing; a row that would cross CONTENT_BOTTOM
 * starts a new page with the table header repeated. The table itself starts
 * on a new page if the header and first row would not fit together.
 */
function drawItems(
  doc: Doc,
  input: RenderInvoiceInput,
  labels: Labels,
  top: number,
): number {
  let start = top;
  const firstItem = input.items[0];
  if (
    firstItem !== undefined &&
    top + TABLE_HEADER_HEIGHT + measureItemRow(doc, firstItem) >
      CONTENT_BOTTOM
  ) {
    doc.addPage();
    start = MARGIN;
  }

  let y = drawTableHeader(doc, labels, start);
  for (const item of input.items) {
    const height = measureItemRow(doc, item);
    if (y + height > CONTENT_BOTTOM) {
      doc.addPage();
      y = drawTableHeader(doc, labels, MARGIN);
    }
    y = drawItemRow(doc, item, y, height);
  }
  return y;
}

/**
 * Totals, payment information, notes and signature. With paint = false
 * nothing is drawn and only the end y is computed, so the caller can move the
 * whole block to a new page when it does not fit.
 */
function layoutClosing(
  doc: Doc,
  input: RenderInvoiceInput,
  labels: Labels,
  top: number,
  paint: boolean,
): number {
  const text = (
    style: TextStyle,
    value: string,
    x: number,
    y: number,
    width: number,
    align: Align = 'left',
  ): number =>
    paint
      ? drawText(doc, style, value, x, y, width, align)
      : measureText(doc, style, value, width);

  let y = top + 16;

  // Totals
  const boxX = RIGHT_EDGE - TOTALS_WIDTH;
  const innerX = boxX + 10;
  const innerWidth = TOTALS_WIDTH - 20;
  const rows: [string, string][] = [
    [labels.subtotal, formatCents(input.subtotalCents)],
  ];
  if (input.taxRateBps > 0) {
    rows.push([
      `${labels.tax} (${formatTaxRate(input.taxRateBps)})`,
      formatCents(input.taxCents),
    ]);
  }
  for (const [label, value] of rows) {
    text(STYLE.totalsLabel, label, innerX, y, innerWidth);
    y += text(STYLE.totalsValue, value, innerX, y, innerWidth, 'right') + 6;
  }
  if (paint) {
    fillRect(doc, boxX, y, TOTALS_WIDTH, GRAND_TOTAL_HEIGHT, SOFT);
  }
  const totalLabel =
    input.kind === 'CREDIT_NOTE' ? labels.totalCredit : labels.totalDue;
  text(STYLE.grandTotal, totalLabel, innerX, y + 8, innerWidth);
  text(
    STYLE.grandTotal,
    formatCents(input.totalCents),
    innerX,
    y + 8,
    innerWidth,
    'right',
  );
  y += GRAND_TOTAL_HEIGHT + 28;

  // Payment information
  y += text(STYLE.heading, labels.paymentInfo, MARGIN, y, CONTENT_WIDTH) + 4;
  const paymentLines =
    input.issuer.paymentLines.length > 0
      ? input.issuer.paymentLines
      : labels.genericPayment;
  for (const line of paymentLines) {
    y += text(STYLE.body, line, MARGIN, y, CONTENT_WIDTH);
  }
  y += 20;

  // Notes
  const noteLines: string[] = [];
  if (input.replacesInvoiceNo !== null) {
    noteLines.push(`${labels.replaces} ${input.replacesInvoiceNo}`);
  }
  if (input.notes !== null && input.notes.trim() !== '') {
    noteLines.push(input.notes);
  }
  if (noteLines.length > 0) {
    y += text(STYLE.heading, labels.notes, MARGIN, y, CONTENT_WIDTH) + 4;
    for (const line of noteLines) {
      y += text(STYLE.body, line, MARGIN, y, CONTENT_WIDTH);
    }
    y += 20;
  }

  // Signature
  y += 30;
  if (paint) {
    drawRule(doc, MARGIN, MARGIN + SIGNATURE_RULE_WIDTH, y, MUTED);
  }
  y += 4;
  y +=
    text(STYLE.small, labels.signature, MARGIN, y, SIGNATURE_RULE_WIDTH) + 18;
  y += text(STYLE.body, labels.thanks, MARGIN, y, CONTENT_WIDTH);

  return y;
}

function drawClosing(
  doc: Doc,
  input: RenderInvoiceInput,
  labels: Labels,
  top: number,
): void {
  const height = layoutClosing(doc, input, labels, top, false) - top;
  let start = top;
  if (top + height > CONTENT_BOTTOM) {
    doc.addPage();
    start = MARGIN;
  }
  layoutClosing(doc, input, labels, start, true);
}

function drawFooters(
  doc: Doc,
  input: RenderInvoiceInput,
  labels: Labels,
): void {
  const { issuer } = input;
  const issuerLine =
    `${issuer.legalName} ${issuer.dba} · ` +
    `${issuer.addressLine1}, ${issuer.addressLine2} · ` +
    `${issuer.phone} · EIN ${issuer.ein}`;

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    // The footer sits inside the bottom margin; lift it while drawing so
    // pdfkit does not treat the footer text as overflow and add a page.
    const { margins } = doc.page;
    const savedBottom = margins.bottom;
    margins.bottom = 0;

    drawRule(doc, MARGIN, RIGHT_EDGE, FOOTER_RULE_Y);
    const lineHeight = drawText(
      doc,
      STYLE.footer,
      issuerLine,
      MARGIN,
      FOOTER_RULE_Y + 6,
      CONTENT_WIDTH,
      'center',
    );
    drawText(
      doc,
      STYLE.footer,
      `${input.invoiceNo} · ${labels.page(i + 1, range.count)}`,
      MARGIN,
      FOOTER_RULE_Y + 6 + lineHeight + 2,
      CONTENT_WIDTH,
      'right',
    );

    margins.bottom = savedBottom;
  }
}

export async function renderInvoicePdf(
  input: RenderInvoiceInput,
): Promise<Buffer> {
  const labels = LABELS[input.language];
  const documentTitle =
    input.kind === 'CREDIT_NOTE' ? labels.creditNote : 'Invoice';
  const doc = new PDFDocument({
    size: 'LETTER',
    margin: MARGIN,
    bufferPages: true,
    info: {
      Title: `${documentTitle} ${input.invoiceNo} — ${input.billTo.name}`,
      Author: `${input.issuer.legalName} ${input.issuer.dba}`,
    },
  });

  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // A throw here rejects the promise (executor semantics).
    let y = drawHeader(doc, input, labels);
    y = drawParties(doc, input, labels, y);
    y = drawItems(doc, input, labels, y);
    drawClosing(doc, input, labels, y);
    drawFooters(doc, input, labels);
    doc.end();
  });
}
