import { z } from 'zod';

/**
 * Serialization convention
 * ------------------------
 * Every field that crosses a process or file boundary is `snake_case`, because
 * these documents are read by the Python perception runtime, by JSON Schema
 * tooling and by humans editing YAML. In-process TypeScript APIs that are never
 * serialized use `camelCase`.
 */

/** All contract objects reject unknown keys. See `docs/architecture/contracts.md`. */
export const obj = z.strictObject;

/** Integer milliseconds on some timeline. Never negative. */
export const Milliseconds = z.int().min(0).meta({
  id: 'Milliseconds',
  description: 'Integer milliseconds. Media time is always integer ms, never float seconds.',
});
export type Milliseconds = z.infer<typeof Milliseconds>;

/** A signed offset in milliseconds (may be negative). */
export const MillisecondsDelta = z.int().meta({ id: 'MillisecondsDelta' });

/** A calibrated confidence in [0, 1]. */
export const Confidence = z.number().min(0).max(1).meta({
  id: 'Confidence',
  description: 'Confidence in [0,1]. 1 means certain, 0 means no support at all.',
});
export type Confidence = z.infer<typeof Confidence>;

/** A probability in [0, 1]. Semantically distinct from confidence. */
export const Probability = z.number().min(0).max(1).meta({
  id: 'Probability',
  description:
    'Probability in [0,1]. Unlike Confidence this is a belief about the world, not about the model.',
});
export type Probability = z.infer<typeof Probability>;

/** A unit score in [0, 1] used for editorial metrics. */
export const UnitScore = z.number().min(0).max(1).meta({ id: 'UnitScore' });

/**
 * An instant, always UTC with a trailing Z.
 *
 * Validated, because the field beside it that says what it contains is checked
 * and this one was not: `min(1)` accepts "yesterday". A camera's
 * `creation_time` comes from whatever the container happens to say, and assets
 * are laid on the capture timeline in the order these strings sort in — so a
 * file written as `2026/05/17 09:00:00`, or with a local offset instead of Z,
 * ordered the footage wrongly and invented continuity that was never there.
 */
export const Iso8601 = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/,
    'expected an ISO-8601 instant in UTC, like 2026-05-17T09:00:00.000Z',
  )
  .meta({
    id: 'Iso8601',
    description: 'ISO-8601 timestamp, always UTC with a trailing Z.',
  });

/**
 * Reads a timestamp from somewhere that does not promise the canonical form.
 *
 * Returns the instant as `Iso8601`, or nothing at all. Nothing is the right
 * answer for a container whose date cannot be understood: ordering by file name
 * is arbitrary, and ordering by a misread date is wrong.
 */
export function toIso8601(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  // Some containers write `2026-05-17 09:00:00`, and some cameras use colons in
  // the date, which is what EXIF specifies: `2026:05:17 09:00:00`.
  const candidate = /^\d{4}:\d{2}:\d{2}[ T]/.test(trimmed)
    ? `${trimmed.slice(0, 10).replace(/:/g, '-')}T${trimmed.slice(11)}`
    : trimmed.replace(' ', 'T');
  const parsed = new Date(
    candidate.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(candidate) ? candidate : `${candidate}Z`,
  );
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * Ordering that does not depend on where the machine is.
 *
 * `localeCompare` reads a collation from the environment, and collations
 * genuinely disagree: `ä` sorts before `z` under `en-US` and after it under
 * `sv-SE`. Everything in this pipeline that decides an order — which asset goes
 * first on the capture timeline, which of two equally good moments wins a tie —
 * is part of the output, and the first thing the compiler promises is that the
 * same input produces byte-identical output. A Swedish user compiling the same
 * footage was getting a different capture timeline, and therefore different
 * events, different neighbours and a different cut.
 *
 * Code-point order is arbitrary and it is the same arbitrary order everywhere,
 * which is the property that matters here. It is not for anything a person
 * reads as a sorted list.
 */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export const Sha256 = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'sha256 must be 64 lowercase hex characters')
  .meta({ id: 'Sha256' });

/* -------------------------------------------------------------------------- */
/* Identifiers                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Identifier prefixes. The prefix is part of the identifier so that a bare id in
 * a log line, an LLM tool call or a validation error is self-describing.
 */
export const ID_PREFIXES = {
  project: 'prj',
  asset: 'asset',
  shot: 'shot',
  utterance: 'utt',
  audioEvent: 'aev',
  ocr: 'ocr',
  frame: 'frm',
  chapter: 'chp',
  event: 'evt',
  relation: 'rel',
  embedding: 'emb',
  assessment: 'asm',
  annotation: 'ann',
  plan: 'plan',
  operation: 'op',
  revision: 'rev',
  modelRun: 'run',
  skill: 'skl',
  conflict: 'cfl',
  review: 'rvo',
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

const ID_BODY = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * An optional field, as it actually arrives over a JSON boundary.
 *
 * JSON has no `undefined`. A producer in another language writes `null` for a
 * field it has no value for, and a schema that only accepts absence rejects a
 * perfectly correct message. Both are accepted and normalised to absence, so the
 * TypeScript type stays `T | undefined` and nothing downstream has to think
 * about which one arrived.
 *
 * Used for every optional field in the perception protocol, which is the one
 * place a non-TypeScript producer writes into these schemas.
 */
export function jsonOptional<T extends z.ZodType>(schema: T) {
  return schema
    .nullish()
    .transform((value) => (value === null ? undefined : value)) as unknown as z.ZodOptional<T>;
}

/** Builds a Zod schema for an identifier carrying a specific prefix. */
export function idSchema<P extends string>(prefix: P, description?: string) {
  return z
    .string()
    .refine(
      (v) => v.startsWith(`${prefix}_`) && ID_BODY.test(v.slice(prefix.length + 1)),
      `expected an identifier of the form "${prefix}_…"`,
    )
    .meta({
      id: `${prefix}Id`,
      description: description ?? `Identifier prefixed with "${prefix}_".`,
    });
}

const ID_ALPHABET = '0123456789abcdefghijkmnpqrstuvwxyz'; // Crockford-ish: no l, o

/**
 * A random identifier. Used only where two independently produced documents
 * could collide (projects, plans, model runs).
 *
 * Everything the compiler produces in bulk uses {@link seqId} instead, because a
 * reproducible pipeline must produce byte-identical output for identical input.
 */
export function newId(prefix: string, length = 12): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return `${prefix}_${out}`;
}

/**
 * A deterministic, ordered identifier such as `evt_0031`.
 *
 * Deterministic ids are what make the whole compiler reproducible: the same
 * media and the same settings must produce a byte-identical Editorial IR, or
 * golden tests and caching are both impossible.
 */
export function seqId(prefix: string, n: number, width = 4): string {
  return `${prefix}_${String(n).padStart(width, '0')}`;
}

/* -------------------------------------------------------------------------- */
/* Time                                                                        */
/* -------------------------------------------------------------------------- */

export const TimeRange = obj({
  start_ms: Milliseconds,
  end_ms: Milliseconds,
})
  .refine((r) => r.end_ms > r.start_ms, {
    message: 'end_ms must be strictly greater than start_ms',
    path: ['end_ms'],
  })
  .meta({ id: 'TimeRange', description: 'A half-open interval [start_ms, end_ms).' });
export type TimeRange = z.infer<typeof TimeRange>;

export function durationOf(range: { start_ms: number; end_ms: number }): number {
  return range.end_ms - range.start_ms;
}

export function rangesOverlap(
  a: { start_ms: number; end_ms: number },
  b: { start_ms: number; end_ms: number },
): boolean {
  return a.start_ms < b.end_ms && b.start_ms < a.end_ms;
}

export function overlapMs(
  a: { start_ms: number; end_ms: number },
  b: { start_ms: number; end_ms: number },
): number {
  return Math.max(0, Math.min(a.end_ms, b.end_ms) - Math.max(a.start_ms, b.start_ms));
}

/** Formats milliseconds as `HH:MM:SS.mmm`. */
export function formatTimecode(ms: number, withMillis = true): string {
  const sign = ms < 0 ? '-' : '';
  const t = Math.abs(Math.round(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const frac = t % 1000;
  const base = `${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return withMillis ? `${base}.${String(frac).padStart(3, '0')}` : base;
}

/** Parses `HH:MM:SS(.mmm)`, `MM:SS(.mmm)` or a bare seconds value into ms. */
export function parseTimecode(input: string): number {
  const trimmed = input.trim();
  const m = /^(?:(\d+):)?(?:(\d+):)?(\d+)(?:[.,](\d{1,3}))?$/.exec(trimmed);
  if (!m) throw new Error(`invalid timecode: ${JSON.stringify(input)}`);
  const [, a, b, c, frac] = m;
  let h = 0;
  let min = 0;
  const sec = Number(c);
  if (a !== undefined && b !== undefined) {
    h = Number(a);
    min = Number(b);
  } else if (a !== undefined) {
    min = Number(a);
  }
  const millis = frac ? Number(frac.padEnd(3, '0')) : 0;
  return ((h * 60 + min) * 60 + sec) * 1000 + millis;
}

/* -------------------------------------------------------------------------- */
/* SMPTE timecode                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Whether a rational frame rate is one of the NTSC family: a whole rate slowed
 * by 1000/1001, such as 24000/1001, 30000/1001 or 60000/1001.
 *
 * Asked of the numbers rather than of "has a denominator": 2500/101 is the
 * measured average of a phone clip that dropped frames, not an NTSC rate, and
 * reading every rate with a denominator as NTSC wrote it into a sequence as
 * 25 fps slowed by 1000/1001 — a rate no camera has ever recorded.
 */
export function isNtscRate(num: number, den: number): boolean {
  return den === 1001 && num % 1000 === 0 && num > 0;
}

/**
 * Whether drop-frame counting is defined at this rate.
 *
 * Only for 30000/1001 and 60000/1001. Drop-frame exists to keep a 29.97 clock's
 * labels in step with the wall clock; 23.976 has no drop-frame form, and a
 * timecode with a `;` at 24000/1001 is a mistake, not a convention.
 */
export function supportsDropFrame(num: number, den: number): boolean {
  return den === 1001 && (num === 30_000 || num === 60_000);
}

/** The labels a timecode counts in: the whole frames per second it writes. */
export function timecodeBase(num: number, den: number): number {
  return Math.max(1, Math.round(num / den));
}

/** Frame numbers dropped each minute at a drop-frame rate: 2 at 29.97, 4 at 59.94. */
function droppedPerMinute(base: number): number {
  return Math.round(base / 15);
}

/**
 * Frames to a SMPTE timecode, `HH:MM:SS:FF`, or `HH:MM:SS;FF` when drop-frame.
 *
 * Drop-frame drops frame *labels*, never frames: at 29.97 the labels :00 and
 * :01 are skipped at the start of every minute except each tenth, which is what
 * keeps 01:00:00;00 an hour of wall-clock time. Counting 29.97 footage without
 * it drifts 3.6 seconds an hour, and an edit list that disagrees with the
 * media's own timecode by that much conforms the wrong frames.
 *
 * Wraps at 24 hours, as a timecode does.
 */
export function framesToSmpte(
  frames: number,
  num: number,
  den: number,
  dropFrame: boolean = supportsDropFrame(num, den),
): string {
  const base = timecodeBase(num, den);
  const drop = dropFrame && supportsDropFrame(num, den);
  let label = Math.max(0, Math.round(frames));

  if (drop) {
    const dropped = droppedPerMinute(base);
    const perMinute = base * 60 - dropped;
    const perTenMinutes = base * 600 - dropped * 9;
    const tens = Math.floor(label / perTenMinutes);
    const rest = label % perTenMinutes;
    label +=
      dropped * 9 * tens +
      (rest > dropped ? dropped * Math.floor((rest - dropped) / perMinute) : 0);
  }

  const ff = label % base;
  const totalSeconds = Math.floor(label / base);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600) % 24;
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(hh)}:${two(mm)}:${two(ss)}${drop ? ';' : ':'}${two(ff)}`;
}

/**
 * A SMPTE timecode to a frame count at a rational rate.
 *
 * Drop-frame is read from the timecode itself — a `;`, `.` or `,` before the
 * frames, which is how ffprobe reports a 29.97 camera's clock (`01:00:00;00`) —
 * and honoured only where drop-frame is defined. `dropFrame` overrides the
 * separator for a label that is known to count one way: a record start typed
 * as `01:00:00:00` for a drop-frame list means the label the list will print
 * as `01:00:00;00`, and reading it as non-drop put the first event at
 * 01:00:03;18. Returns undefined for anything that is not a timecode, so a tag
 * holding something else is ignored rather than read as midnight.
 */
export function smpteToFrames(
  timecode: string,
  num: number,
  den: number,
  dropFrame?: boolean,
): number | undefined {
  const match = /^(\d{1,2})[:;.](\d{2})[:;.](\d{2})([:;.,])(\d{2,3})$/.exec(timecode.trim());
  if (!match) return undefined;
  const [, h, m, s, separator, f] = match;
  const base = timecodeBase(num, den);
  const hh = Number(h);
  const mm = Number(m);
  const ss = Number(s);
  const ff = Number(f);
  if (mm > 59 || ss > 59 || ff >= base) return undefined;
  const drop = (dropFrame ?? separator !== ':') && supportsDropFrame(num, den);
  const labels = ((hh * 60 + mm) * 60 + ss) * base + ff;
  if (!drop) return labels;
  const minutes = hh * 60 + mm;
  return labels - droppedPerMinute(base) * (minutes - Math.floor(minutes / 10));
}
