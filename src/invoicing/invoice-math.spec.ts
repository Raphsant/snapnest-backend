import {
  computeDueDate,
  computeTotals,
  formatCents,
  formatInvoiceNo,
  InvoiceMathError,
  parseInvoiceNo,
  pdfFilename,
  servicesSummary,
} from './invoice-math';

const utc = (y: number, m: number, d: number): Date =>
  new Date(Date.UTC(y, m - 1, d));

describe('formatInvoiceNo', () => {
  it('formats invoices and credit notes', () => {
    expect(formatInvoiceNo('INVOICE', 2026, 2)).toBe('STC-2026-002');
    expect(formatInvoiceNo('CREDIT_NOTE', 2026, 2)).toBe('STC-CN-2026-002');
  });

  it('accepts the 001 and 999 bounds', () => {
    expect(formatInvoiceNo('INVOICE', 2026, 1)).toBe('STC-2026-001');
    expect(formatInvoiceNo('INVOICE', 2026, 999)).toBe('STC-2026-999');
  });

  it('rejects seq outside 1..999 and non-integers', () => {
    expect(() => formatInvoiceNo('INVOICE', 2026, 0)).toThrow(InvoiceMathError);
    expect(() => formatInvoiceNo('INVOICE', 2026, 1000)).toThrow(
      InvoiceMathError,
    );
    expect(() => formatInvoiceNo('INVOICE', 2026, 1.5)).toThrow(
      InvoiceMathError,
    );
  });

  it('rejects years that are not four digits', () => {
    expect(() => formatInvoiceNo('INVOICE', 999, 1)).toThrow(InvoiceMathError);
    expect(() => formatInvoiceNo('INVOICE', 10000, 1)).toThrow(
      InvoiceMathError,
    );
  });
});

describe('parseInvoiceNo', () => {
  it('round-trips with formatInvoiceNo', () => {
    for (const kind of ['INVOICE', 'CREDIT_NOTE'] as const) {
      for (const seq of [1, 42, 999]) {
        const no = formatInvoiceNo(kind, 2026, seq);
        expect(parseInvoiceNo(no)).toEqual({ kind, year: 2026, seq });
        expect(formatInvoiceNo(kind, 2026, seq)).toBe(no);
      }
    }
  });

  it.each([
    '',
    'STC-2026-000',
    'STC-2026-1',
    'STC-2026-0001',
    'STC-26-001',
    'stc-2026-001',
    'STC-XX-2026-001',
    ' STC-2026-001',
    'STC-2026-001 ',
    'STC-2026-001.pdf',
  ])('returns null for %p', (input) => {
    expect(parseInvoiceNo(input)).toBeNull();
  });
});

describe('computeDueDate', () => {
  it('keeps the same day for "Due upon receipt"', () => {
    expect(computeDueDate(utc(2026, 10, 13), 'Due upon receipt')).toEqual(
      utc(2026, 10, 13),
    );
  });

  it('adds Net 30 across a month end', () => {
    expect(computeDueDate(utc(2026, 10, 15), 'Net 30')).toEqual(
      utc(2026, 11, 14),
    );
    expect(computeDueDate(utc(2026, 12, 15), 'Net 30')).toEqual(
      utc(2027, 1, 14),
    );
  });

  it('is case-insensitive and allows no space', () => {
    expect(computeDueDate(utc(2026, 10, 1), 'net30')).toEqual(
      utc(2026, 10, 31),
    );
    expect(computeDueDate(utc(2026, 10, 1), 'NET 15')).toEqual(
      utc(2026, 10, 16),
    );
  });

  it.each(['Net 0', 'Net -5', 'Net', 'Upon delivery', ''])(
    'keeps the same day for %p',
    (terms) => {
      expect(computeDueDate(utc(2026, 10, 13), terms)).toEqual(
        utc(2026, 10, 13),
      );
    },
  );

  it('does not mutate the input date', () => {
    const invoiceDate = utc(2026, 10, 13);
    computeDueDate(invoiceDate, 'Net 30');
    expect(invoiceDate).toEqual(utc(2026, 10, 13));
  });
});

describe('computeTotals', () => {
  it('computes amounts, subtotal, tax and total', () => {
    expect(
      computeTotals(
        [
          { qty: 2, unitPriceCents: 150_000 },
          { qty: 1, unitPriceCents: 900_000 },
        ],
        825,
      ),
    ).toEqual({
      items: [{ amountCents: 300_000 }, { amountCents: 900_000 }],
      subtotalCents: 1_200_000,
      taxCents: 99_000,
      totalCents: 1_299_000,
    });
  });

  it('rounds tax half up at exactly .5 cents', () => {
    // 1000 * 825 / 10000 = 82.5 -> 83
    expect(computeTotals([{ qty: 1, unitPriceCents: 1000 }], 825).taxCents).toBe(
      83,
    );
    // 200 * 25 / 10000 = 0.5 -> 1
    expect(computeTotals([{ qty: 1, unitPriceCents: 200 }], 25).taxCents).toBe(
      1,
    );
  });

  it('rounds 1 cent at 825 bps down to 0 tax', () => {
    // 1 * 825 / 10000 = 0.0825 -> 0
    expect(computeTotals([{ qty: 1, unitPriceCents: 1 }], 825)).toEqual({
      items: [{ amountCents: 1 }],
      subtotalCents: 1,
      taxCents: 0,
      totalCents: 1,
    });
  });

  it('allows a zero unit price and the 0 and 10000 bps bounds', () => {
    expect(computeTotals([{ qty: 1, unitPriceCents: 0 }], 0).totalCents).toBe(0);
    expect(
      computeTotals([{ qty: 1, unitPriceCents: 500 }], 10_000).totalCents,
    ).toBe(1000);
  });

  it.each([
    ['empty items', [], 0],
    ['qty 0', [{ qty: 0, unitPriceCents: 100 }], 0],
    ['fractional qty', [{ qty: 1.5, unitPriceCents: 100 }], 0],
    ['fractional price', [{ qty: 1, unitPriceCents: 99.5 }], 0],
    ['negative price', [{ qty: 1, unitPriceCents: -1 }], 0],
    ['negative tax', [{ qty: 1, unitPriceCents: 100 }], -1],
    ['tax above 10000', [{ qty: 1, unitPriceCents: 100 }], 10_001],
    ['fractional tax', [{ qty: 1, unitPriceCents: 100 }], 82.5],
  ])('throws on %s', (_label, items, bps) => {
    expect(() => computeTotals(items, bps)).toThrow(InvoiceMathError);
  });
});

describe('formatCents', () => {
  it.each([
    [0, '$0.00'],
    [5, '$0.05'],
    [99, '$0.99'],
    [100, '$1.00'],
    [123_456, '$1,234.56'],
    [1_200_000, '$12,000.00'],
    [123_456_789, '$1,234,567.89'],
    [-1, '-$0.01'],
    [-1_200_000, '-$12,000.00'],
  ])('formats %p as %p', (cents, expected) => {
    expect(formatCents(cents)).toBe(expected);
  });

  it('throws on non-integer cents', () => {
    expect(() => formatCents(1.5)).toThrow(InvoiceMathError);
  });
});

describe('pdfFilename', () => {
  it('uses the UTC calendar day', () => {
    expect(pdfFilename('STC-2026-002', 'ALPHA', utc(2026, 10, 15))).toBe(
      'STC-2026-002_ALPHA_2026-10-15.pdf',
    );
  });
});

describe('servicesSummary', () => {
  it('uses the shared description prefix', () => {
    expect(
      servicesSummary([
        {
          name: 'Evento Houston',
          description: 'Turnkey Event Production — planning',
        },
        {
          name: 'Evento Reus',
          description: 'Turnkey Event Production — catering',
        },
      ]),
    ).toBe('Turnkey Event Production: Evento Houston / Evento Reus');
  });

  it('uses the prefix for a single item', () => {
    expect(
      servicesSummary([
        {
          name: 'Evento Houston / Evento Reus / Evento Madrid',
          description:
            'Turnkey Event Production — end-to-end planning, venue sourcing, catering and on-site coordination',
        },
      ]),
    ).toBe(
      'Turnkey Event Production: Evento Houston / Evento Reus / Evento Madrid',
    );
  });

  it('omits the prefix when prefixes differ', () => {
    expect(
      servicesSummary([
        { name: 'A', description: 'Production — x' },
        { name: 'B', description: 'Editing — y' },
      ]),
    ).toBe('A / B');
  });

  it('omits the prefix when any description lacks the separator', () => {
    expect(
      servicesSummary([
        { name: 'A', description: 'Production — x' },
        { name: 'B', description: 'Production - y' },
      ]),
    ).toBe('A / B');
  });

  it('truncates to 200 chars with an ellipsis', () => {
    const summary = servicesSummary([
      { name: 'x'.repeat(250), description: 'no prefix' },
    ]);
    expect(summary).toHaveLength(200);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('leaves exactly 200 chars untouched', () => {
    const name = 'y'.repeat(200);
    expect(servicesSummary([{ name, description: '' }])).toBe(name);
  });
});
