import {
  CaptionBlock,
  CaptionEditError,
  CaptionParseError,
  formatClipSrt,
  formatSrtTimestamp,
  mergeEditedText,
  parseClipSrt,
  parseSrtTimestamp,
} from './clip-captions';

// The worker's generated-slice shape (copy of the worker test expectation).
const GENERATED =
  '1\n00:00:00,500 --> 00:00:01,750\nPrimera línea\nsegunda línea\n\n' +
  '2\n00:00:02,000 --> 00:00:03,000\nTexto final\n';

const GENERATED_BLOCKS: CaptionBlock[] = [
  {
    index: 1,
    startMs: 500,
    endMs: 1750,
    text: 'Primera línea\nsegunda línea',
  },
  { index: 2, startMs: 2000, endMs: 3000, text: 'Texto final' },
];

/** Runs fn, asserts it threw a CaptionEditError, and returns it. */
function captureEditError(fn: () => unknown): CaptionEditError {
  try {
    fn();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(CaptionEditError);
    return error as CaptionEditError;
  }
  throw new Error('expected CaptionEditError to be thrown');
}

describe('parseSrtTimestamp', () => {
  it('parses to exact integer milliseconds', () => {
    expect(parseSrtTimestamp('00:00:00,500')).toBe(500);
    expect(parseSrtTimestamp('01:02:03,004')).toBe(3_723_004);
    expect(parseSrtTimestamp('99:59:59,999')).toBe(359_999_999);
  });

  it.each(['00:60:00,000', '00:00:60,000', '0:00:00,000', '00:00:00.000'])(
    'rejects %s',
    (timestamp) => {
      expect(() => parseSrtTimestamp(timestamp)).toThrow(CaptionParseError);
      expect(() => parseSrtTimestamp(timestamp)).toThrow(
        `invalid SRT timestamp "${timestamp}"`,
      );
    },
  );
});

describe('formatSrtTimestamp', () => {
  it.each(['00:00:00,500', '00:00:01,750', '00:00:02,000', '00:00:03,000'])(
    'round-trips %s from GENERATED',
    (timestamp) => {
      expect(formatSrtTimestamp(parseSrtTimestamp(timestamp))).toBe(timestamp);
    },
  );

  it('widens hours past two digits instead of wrapping', () => {
    expect(formatSrtTimestamp(100 * 3_600_000)).toBe('100:00:00,000');
    expect(formatSrtTimestamp(100 * 3_600_000 + 1)).toBe('100:00:00,001');
  });

  it('throws RangeError on a negative value', () => {
    expect(() => formatSrtTimestamp(-1)).toThrow(RangeError);
    expect(() => formatSrtTimestamp(-1)).toThrow(
      'SRT milliseconds cannot be negative',
    );
  });

  it('throws RangeError on a non-integer value', () => {
    expect(() => formatSrtTimestamp(1.5)).toThrow(RangeError);
    expect(() => formatSrtTimestamp(1.5)).toThrow(
      'SRT milliseconds must be an integer',
    );
  });
});

describe('parseClipSrt', () => {
  it('parses GENERATED into two blocks with exact ms and text', () => {
    expect(parseClipSrt(GENERATED)).toEqual(GENERATED_BLOCKS);
  });

  it('gives identical blocks with LF text for CRLF input', () => {
    expect(parseClipSrt(GENERATED.replace(/\n/g, '\r\n'))).toEqual(
      GENERATED_BLOCKS,
    );
  });

  it('accepts a leading BOM', () => {
    expect(parseClipSrt(`\uFEFF${GENERATED}`)).toEqual(GENERATED_BLOCKS);
  });

  it('parses a block with no text line as empty text', () => {
    expect(parseClipSrt('1\n00:00:00,000 --> 00:00:01,000\n')).toEqual([
      { index: 1, startMs: 0, endMs: 1000, text: '' },
    ]);
  });

  it('ignores trailing junk on the timing line', () => {
    expect(parseClipSrt('1\n00:00:00,000 --> 00:00:01,000 X-extra\n')).toEqual([
      { index: 1, startMs: 0, endMs: 1000, text: '' },
    ]);
  });

  // Only CR/LF are stripped (text.strip("\r\n")), so CR/LF-only input has no
  // blocks while spaces-only input is a malformed first block, as in the worker.
  it.each(['', '\n', '\r\n\r\n'])(
    'rejects empty or CR/LF-only input %j',
    (input) => {
      expect(() => parseClipSrt(input)).toThrow(CaptionParseError);
      expect(() => parseClipSrt(input)).toThrow(
        'clip SRT has no subtitle blocks',
      );
    },
  );

  it('rejects spaces-only input as malformed at position 1', () => {
    expect(() => parseClipSrt('   ')).toThrow(CaptionParseError);
    expect(() => parseClipSrt('   ')).toThrow(
      'clip SRT block at position 1 is malformed',
    );
  });

  it('rejects a duplicate index', () => {
    const input =
      '1\n00:00:00,000 --> 00:00:01,000\nA\n\n' +
      '1\n00:00:01,000 --> 00:00:02,000\nB\n';
    expect(() => parseClipSrt(input)).toThrow(CaptionParseError);
    expect(() => parseClipSrt(input)).toThrow(
      'clip SRT contains duplicate block 1',
    );
  });

  it('reports the position of a chunk missing its timing line', () => {
    const input = '1\n00:00:00,000 --> 00:00:01,000\nA\n\n2\nTexto final\n';
    expect(() => parseClipSrt(input)).toThrow(CaptionParseError);
    expect(() => parseClipSrt(input)).toThrow(
      'clip SRT block at position 2 is malformed',
    );
  });

  it('reports minutes >= 60 as malformed at that position', () => {
    const input =
      '1\n00:00:00,000 --> 00:00:01,000\nA\n\n' +
      '2\n00:60:00,000 --> 00:60:01,000\nB\n';
    expect(() => parseClipSrt(input)).toThrow(CaptionParseError);
    expect(() => parseClipSrt(input)).toThrow(
      'clip SRT block at position 2 is malformed',
    );
  });
});

describe('formatClipSrt', () => {
  it('reproduces GENERATED byte for byte', () => {
    expect(formatClipSrt(parseClipSrt(GENERATED))).toBe(GENERATED);
  });

  it('serialises a blank middle block as index and timing only, and round-trips', () => {
    const blocks: CaptionBlock[] = [
      { index: 1, startMs: 0, endMs: 1000, text: 'A' },
      { index: 2, startMs: 1000, endMs: 2000, text: '' },
      { index: 3, startMs: 2000, endMs: 3000, text: 'C' },
    ];
    const srt = formatClipSrt(blocks);

    expect(srt).toBe(
      '1\n00:00:00,000 --> 00:00:01,000\nA\n\n' +
        '2\n00:00:01,000 --> 00:00:02,000\n\n' +
        '3\n00:00:02,000 --> 00:00:03,000\nC\n',
    );
    expect(parseClipSrt(srt)).toEqual(blocks);
  });

  it('writes indexes as given without renumbering', () => {
    expect(
      formatClipSrt([
        { index: 5, startMs: 0, endMs: 1000, text: 'A' },
        { index: 9, startMs: 1000, endMs: 2000, text: 'B' },
      ]),
    ).toBe(
      '5\n00:00:00,000 --> 00:00:01,000\nA\n\n' +
        '9\n00:00:01,000 --> 00:00:02,000\nB\n',
    );
  });
});

describe('mergeEditedText', () => {
  let generated: CaptionBlock[];

  beforeEach(() => {
    generated = parseClipSrt(GENERATED);
  });

  it('returns the generated timings with the new text', () => {
    const merged = mergeEditedText(generated, [
      { index: 1, text: 'Hola' },
      { index: 2, text: 'Adiós' },
    ]);

    expect(merged).toEqual([
      { index: 1, startMs: 500, endMs: 1750, text: 'Hola' },
      { index: 2, startMs: 2000, endMs: 3000, text: 'Adiós' },
    ]);
    expect(generated).toEqual(GENERATED_BLOCKS);
  });

  it('normalises CRLF, lone CR and surrounding whitespace in edit text', () => {
    const merged = mergeEditedText(generated, [
      { index: 1, text: '  Uno\r\ndos\rtres  \n' },
      { index: 2, text: 'Texto final' },
    ]);

    expect(merged[0].text).toBe('Uno\ndos\ntres');
  });

  it('allows blanking one block', () => {
    const merged = mergeEditedText(generated, [
      { index: 1, text: '   ' },
      { index: 2, text: 'Texto final' },
    ]);

    expect(merged[0]).toEqual({
      index: 1,
      startMs: 500,
      endMs: 1750,
      text: '',
    });
    expect(formatClipSrt(merged)).toBe(
      '1\n00:00:00,500 --> 00:00:01,750\n\n' +
        '2\n00:00:02,000 --> 00:00:03,000\nTexto final\n',
    );
  });

  it('rejects a count mismatch', () => {
    const error = captureEditError(() =>
      mergeEditedText(generated, [{ index: 1, text: 'Solo' }]),
    );

    expect(error.message).toBe('edited captions have 1 block(s), expected 2');
    expect(error.position).toBeUndefined();
  });

  it('rejects an index mismatch and sets position', () => {
    const error = captureEditError(() =>
      mergeEditedText(generated, [
        { index: 1, text: 'a' },
        { index: 3, text: 'b' },
      ]),
    );

    expect(error.message).toBe('block at position 2 has index 3, expected 2');
    expect(error.position).toBe(2);
  });

  it.each(['b\n\nc', 'b\r\n\r\nc'])(
    'rejects a blank line inside text %j and sets position',
    (text) => {
      const error = captureEditError(() =>
        mergeEditedText(generated, [
          { index: 1, text: 'a' },
          { index: 2, text },
        ]),
      );

      expect(error.message).toBe('block 2 text contains a blank line');
      expect(error.position).toBe(2);
    },
  );

  it('rejects an edit where every block is blank, with no position', () => {
    const error = captureEditError(() =>
      mergeEditedText(generated, [
        { index: 1, text: '' },
        { index: 2, text: ' \r\n ' },
      ]),
    );

    expect(error.message).toBe('edited captions have no text');
    expect(error.position).toBeUndefined();
  });

  it('reports an index mismatch at position 2 before a blank line at position 1', () => {
    const fn = (): CaptionBlock[] =>
      mergeEditedText(generated, [
        { index: 1, text: 'a\n\nb' },
        { index: 3, text: 'c' },
      ]);

    expect(fn).toThrow(CaptionEditError);
    expect(fn).toThrow('block at position 2 has index 3, expected 2');
    expect(captureEditError(fn).position).toBe(2);
  });
});
