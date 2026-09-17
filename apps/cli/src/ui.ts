/**
 * Terminal output.
 *
 * No dependency, and colour only when someone is actually looking at a
 * terminal: this tool's output is piped into files and read by other programs
 * often enough that escape codes in a redirect would be a bug rather than a
 * cosmetic issue. `NO_COLOR` is honoured because it is the convention.
 */
const ESC = String.fromCharCode(27);

const useColour =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== 'dumb' &&
  process.stdout.isTTY === true;

const code = (open: number, close: number) => (text: string) =>
  useColour ? `${ESC}[${open}m${text}${ESC}[${close}m` : text;

export const colour = {
  bold: code(1, 22),
  dim: code(2, 22),
  red: code(31, 39),
  green: code(32, 39),
  yellow: code(33, 39),
  blue: code(34, 39),
  magenta: code(35, 39),
  cyan: code(36, 39),
  grey: code(90, 39),
};

export function heading(text: string): void {
  process.stdout.write(`\n${colour.bold(text)}\n`);
}

export function line(text = ''): void {
  process.stdout.write(`${text}\n`);
}

export function detail(label: string, value: string): void {
  process.stdout.write(`  ${colour.grey(`${label}:`)} ${value}\n`);
}

export function success(text: string): void {
  process.stdout.write(`${colour.green('ok')} ${text}\n`);
}

export function warn(text: string): void {
  process.stderr.write(`${colour.yellow('!')} ${text}\n`);
}

export function fail(text: string): void {
  process.stderr.write(`${colour.red('x')} ${text}\n`);
}

export function note(text: string): void {
  process.stdout.write(`${colour.grey(text)}\n`);
}

/** A single-line progress indicator that leaves no trace when it finishes. */
export class Progress {
  private lastLength = 0;
  private readonly enabled = process.stderr.isTTY === true && process.env.NO_COLOR === undefined;

  update(stage: string, message: string, done: number, total: number): void {
    if (!this.enabled) return;
    const percent = total > 0 ? Math.round((done / total) * 100) : 0;
    const text = `  ${stage} ${percent}%${message ? ` ${message}` : ''}`;
    process.stderr.write(`\r${text.padEnd(this.lastLength)}`);
    this.lastLength = Math.max(this.lastLength, text.length);
  }

  clear(): void {
    if (!this.enabled || this.lastLength === 0) return;
    process.stderr.write(`\r${' '.repeat(this.lastLength)}\r`);
    this.lastLength = 0;
  }
}

/** Left-aligned columns, sized to their content. */
export function table(rows: string[][], options: { indent?: number } = {}): void {
  if (rows.length === 0) return;
  const indent = ' '.repeat(options.indent ?? 2);
  const widths: number[] = [];
  for (const row of rows) {
    for (const [index, cell] of row.entries()) {
      widths[index] = Math.max(widths[index] ?? 0, displayWidth(cell));
    }
  }
  for (const row of rows) {
    const cells = row.map((cell, index) =>
      index === row.length - 1 ? cell : pad(cell, widths[index] ?? 0),
    );
    process.stdout.write(`${indent}${cells.join('  ')}\n`);
  }
}

const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

/**
 * Width in terminal columns.
 *
 * Japanese text is full width, so counting code points would misalign every
 * table in the product's first language.
 */
export function displayWidth(text: string): number {
  const visible = text.replace(ANSI_PATTERN, '');
  let width = 0;
  for (const char of visible) {
    width += isFullWidth(char.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return width;
}

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

function isFullWidth(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

const ELLIPSIS = '...';

/**
 * Truncates to a column width, with an ellipsis.
 *
 * The ellipsis has to be paid for out of the same budget, or every truncated
 * cell is three columns wider than the column it is in, and the whole table
 * shears.
 */
export function truncate(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  const budget = Math.max(0, width - ELLIPSIS.length);
  let out = '';
  let used = 0;
  for (const char of text) {
    const charWidth = isFullWidth(char.codePointAt(0) ?? 0) ? 2 : 1;
    if (used + charWidth > budget) break;
    out += char;
    used += charWidth;
  }
  return `${out}${ELLIPSIS}`;
}

/** A compact bar, for showing a score in a list. */
export function bar(value: number, width = 10): string {
  const filled = Math.round(Math.min(1, Math.max(0, value)) * width);
  return `${'#'.repeat(filled)}${colour.grey('.'.repeat(width - filled))}`;
}

export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

export function formatCost(usd: number): string {
  if (usd === 0) return 'nothing';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}
