import { z } from 'zod';

/**
 * A single error type across the whole toolchain, carrying a stable `code`.
 *
 * The CLI prints the code, tests assert on it, and adapters branch on it. The
 * message is for humans and may change; the code may not.
 */
export const ERROR_CODES = [
  'invalid_input',
  'schema_violation',
  'not_found',
  'already_exists',
  'unsupported',
  'media_error',
  'perception_failed',
  'decision_failed',
  'skill_error',
  'plan_invalid',
  'adapter_failed',
  'stale_fingerprint',
  'budget_exceeded',
  'cancelled',
  'io_error',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class EditorialError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'EditorialError';
    this.code = code;
    this.details = details;
  }

  static is(value: unknown): value is EditorialError {
    return value instanceof EditorialError;
  }

  toJSON(): { error: { code: ErrorCode; message: string; details: Record<string, unknown> } } {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

/**
 * Parses with a Zod schema and throws a uniform error on failure.
 *
 * Every model output, every file read from disk and every hand-written YAML goes
 * through this. It is the practical form of "an agent's free-form output never
 * reaches the next stage unvalidated".
 */
export function parseOrThrow<T extends z.ZodType>(
  schema: T,
  value: unknown,
  what: string,
): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new EditorialError('schema_violation', `${what} failed validation: ${formatZodError(result.error)}`, {
    what,
    issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })),
  });
}

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((i) => {
      const path = i.path.length ? i.path.join('.') : '(root)';
      return `${path}: ${i.message}`;
    })
    .join('; ');
}
