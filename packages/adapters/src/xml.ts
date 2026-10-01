/**
 * Characters XML 1.0 cannot represent at all.
 *
 * Matching control characters is the whole point here, so the rule that warns
 * about them has nothing useful to say.
 */
// eslint-disable-next-line no-control-regex
const UNREPRESENTABLE = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]', 'g');

/**
 * Escapes text for XML.
 *
 * Not optional: file names and event descriptions in this project are user
 * content, routinely contain ampersands and Japanese punctuation, and one
 * unescaped ampersand makes the whole file unopenable.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(UNREPRESENTABLE, '');
}

/** A linear gain for a level in decibels, which is how FCP7 XML writes a level. */
export function dbToGain(db: number): number {
  return Math.round(10 ** (db / 20) * 1_000_000) / 1_000_000;
}
