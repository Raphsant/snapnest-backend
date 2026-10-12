/**
 * Clip-caption SRT parsing, serialising and edit merging for the manifest
 * approval caption editor. Pure functions only: no Nest, no S3.
 *
 * Ported from snapnest-worker worker/captions.py, which owns the format.
 * Output must match it byte for byte and parsing rule for rule:
 *   - SRT_TIMESTAMP_RE (:25-28)         -> SRT_TIMESTAMP_RE
 *   - CLIP_SRT_BLOCK_RE (:38-44)        -> CLIP_SRT_BLOCK_RE
 *   - parse_srt_timestamp (:65-77)      -> parseSrtTimestamp
 *   - format_srt_timestamp (:80-88)     -> formatSrtTimestamp
 *   - parse_clip_srt (:97-113) and
 *     _parse_srt (:245-279)             -> parseClipSrt
 *   - format_clip_srt (:116-134)        -> formatClipSrt
 *   - _normalise_newlines (:282-283)    -> normaliseNewlines
 *   - validate_edited_slice (:176-221)  -> mergeEditedText (count, then index)
 *
 * mergeEditedText adds two checks the worker enforces later in creative
 * (worker/stages/creative.py:461-465 rejects an edit with no text) or that
 * would otherwise produce a file the worker cannot parse (a blank line inside
 * a block's text splits it into a malformed block at :259).
 *
 * Messages drop the worker's "assemble: " / "captions: clip X" prefixes;
 * they are surfaced to the dashboard, not logged by a stage.
 */

/** One SRT block: clip-relative integer milliseconds and verbatim text. */
export type CaptionBlock = {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
};

/** A clip SRT that does not satisfy the worker's parse rules. */
export class CaptionParseError extends Error {
  override name = 'CaptionParseError';
}

/**
 * An operator edit rejected against the generated slice. `position` is the
 * 1-based block position the error refers to, when it refers to one.
 */
export class CaptionEditError extends Error {
  override name = 'CaptionEditError';

  constructor(
    message: string,
    readonly position?: number,
  ) {
    super(message);
  }
}

const SRT_TIMESTAMP_RE = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/;

// fullmatch semantics: no `m` flag, so `$` is end of input only (Python \Z),
// and [\s\S] stands in for `.` under re.DOTALL.
const CLIP_SRT_BLOCK_RE =
  /^(\d+)(?:\r\n|\n)(\d{2}:\d{2}:\d{2},\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2},\d{3})[^\r\n]*(?:(?:\r\n|\n)([\s\S]*))?$/;

const BLOCK_SEPARATOR_RE = /(?:\r\n|\n){2,}/;

/** text.strip("\r\n"): only CR and LF, from both ends. */
const SURROUNDING_CRLF_RE = /^[\r\n]+|[\r\n]+$/g;

function normaliseNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * Parses an SRT timestamp (HH:MM:SS,mmm) into exact integer milliseconds.
 * Throws CaptionParseError for any other shape, or minutes/seconds >= 60.
 */
export function parseSrtTimestamp(s: string): number {
  const match = SRT_TIMESTAMP_RE.exec(s);
  if (match === null) {
    throw new CaptionParseError(`invalid SRT timestamp "${s}"`);
  }
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  const seconds = Number.parseInt(match[3], 10);
  const milliseconds = Number.parseInt(match[4], 10);
  if (minutes >= 60 || seconds >= 60) {
    throw new CaptionParseError(`invalid SRT timestamp "${s}"`);
  }
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
}

/**
 * Formats integer milliseconds as HH:MM:SS,mmm. Hours widen past two digits
 * rather than wrapping, as Python's {:02d} does. Throws RangeError on a
 * negative or non-integer value (the worker's :02d also rejects floats).
 */
export function formatSrtTimestamp(ms: number): string {
  if (!Number.isSafeInteger(ms)) {
    throw new RangeError('SRT milliseconds must be an integer');
  }
  if (ms < 0) {
    throw new RangeError('SRT milliseconds cannot be negative');
  }
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  const millis = ms % 1_000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(millis, 3)}`;
}

/**
 * Parses a clip-relative SRT (the worker's generated slice or a saved edit).
 * Text may be absent (a blanked block); CRLF and lone CR in text become LF.
 * Throws CaptionParseError naming the first malformed or duplicate block.
 */
export function parseClipSrt(input: string): CaptionBlock[] {
  // utf-8-sig drops exactly one leading BOM.
  const unmarked = input.startsWith('\uFEFF') ? input.slice(1) : input;
  const payload = unmarked.replace(SURROUNDING_CRLF_RE, '');
  if (payload === '') {
    throw new CaptionParseError('clip SRT has no subtitle blocks');
  }

  const blocks: CaptionBlock[] = [];
  const seen = new Set<number>();
  const chunks = payload.split(BLOCK_SEPARATOR_RE);
  for (let i = 0; i < chunks.length; i++) {
    const position = i + 1;
    const malformed = new CaptionParseError(
      `clip SRT block at position ${position} is malformed`,
    );
    const match = CLIP_SRT_BLOCK_RE.exec(chunks[i]);
    if (match === null) {
      throw malformed;
    }
    const index = Number.parseInt(match[1], 10);
    if (!Number.isSafeInteger(index)) {
      throw malformed;
    }
    // Worker order: duplicate check precedes timestamp parsing.
    if (seen.has(index)) {
      throw new CaptionParseError(`clip SRT contains duplicate block ${index}`);
    }
    seen.add(index);

    let startMs: number;
    let endMs: number;
    try {
      startMs = parseSrtTimestamp(match[2]);
      endMs = parseSrtTimestamp(match[3]);
    } catch (error: unknown) {
      if (error instanceof CaptionParseError) {
        throw malformed;
      }
      throw error;
    }

    blocks.push({
      index,
      startMs,
      endMs,
      text: normaliseNewlines(match[4] ?? ''),
    });
  }
  return blocks;
}

/**
 * Serialises blocks exactly as the worker's format_clip_srt: indexes as
 * given (no renumbering), text verbatim, an empty-text block as just its
 * index and timing lines, "\n\n" between blocks and a trailing "\n". LF
 * only; the caller encodes UTF-8.
 */
export function formatClipSrt(blocks: CaptionBlock[]): string {
  const entries = blocks.map((block) => {
    const entry =
      `${block.index}\n` +
      `${formatSrtTimestamp(block.startMs)} --> ` +
      formatSrtTimestamp(block.endMs);
    return block.text !== '' ? `${entry}\n${block.text}` : entry;
  });
  return entries.join('\n\n') + '\n';
}

/**
 * Applies operator text edits to the generated slice. Each edit's text is
 * newline-normalised and trimmed. Count and per-position index must match
 * the generated blocks; timings always come from the generated slice.
 * Throws CaptionEditError for the first failure, checked in order: count,
 * index, blank line inside a block's text, no text in any block.
 */
export function mergeEditedText(
  generated: CaptionBlock[],
  edits: { index: number; text: string }[],
): CaptionBlock[] {
  if (edits.length !== generated.length) {
    throw new CaptionEditError(
      `edited captions have ${edits.length} block(s), expected ${generated.length}`,
    );
  }

  for (let i = 0; i < generated.length; i++) {
    if (edits[i].index !== generated[i].index) {
      throw new CaptionEditError(
        `block at position ${i + 1} has index ${edits[i].index}, expected ${generated[i].index}`,
        i + 1,
      );
    }
  }

  const texts = edits.map((edit) => normaliseNewlines(edit.text).trim());

  for (let i = 0; i < texts.length; i++) {
    if (texts[i].includes('\n\n')) {
      throw new CaptionEditError(
        `block ${generated[i].index} text contains a blank line`,
        i + 1,
      );
    }
  }

  if (texts.every((text) => text === '')) {
    throw new CaptionEditError('edited captions have no text');
  }

  return generated.map((block, i) => ({ ...block, text: texts[i] }));
}
