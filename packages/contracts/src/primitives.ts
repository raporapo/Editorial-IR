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

export const Iso8601 = z.string().min(1).meta({
  id: 'Iso8601',
  description: 'ISO-8601 timestamp, always UTC with a trailing Z.',
});

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
