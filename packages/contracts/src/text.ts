/**
 * Text normalisation, defined once.
 *
 * This is contract rather than convenience: a Skill rule that says
 * `mentions: "USJ"` has to match the same way the search index matches and the
 * same way the redundancy check matches. Three implementations of "roughly the
 * same normalisation" would make a rule behave differently depending on which
 * layer read it, and that is not a bug anyone would find quickly.
 */

/** Folds width and case, and reduces punctuation and symbols to single spaces. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whitespace tokens of a normalised string. Empty tokens are dropped. */
export function tokenize(text: string): string[] {
  const normalized = normalizeText(text);
  return normalized.length === 0 ? [] : normalized.split(' ');
}

/**
 * Characters from scripts that are written without spaces between words.
 *
 * Kana, CJK ideographs and half-width katakana. Whitespace tokenisation finds
 * exactly one token in a Japanese sentence, which is the same as finding none,
 * so these runs are matched by character bigram instead.
 */
const SPACELESS_SCRIPT =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/u;

/**
 * Splits text into the units matching actually compares.
 *
 * Latin runs become words; runs of a spaceless script become character bigrams.
 * Applying bigrams to English too would look tidier and would be wrong: almost
 * any two English sentences share most of their bigrams, so every rule would
 * match everything.
 */
export function matchFeatures(text: string): string[] {
  const features: string[] = [];
  for (const token of tokenize(text)) {
    for (const segment of splitByScript(token)) {
      if (segment.spaceless) {
        if (segment.text.length === 1) {
          features.push(segment.text);
          continue;
        }
        for (let i = 0; i + 2 <= segment.text.length; i++) features.push(segment.text.slice(i, i + 2));
      } else if (segment.text.length > 1) {
        features.push(segment.text);
      }
    }
  }
  return features;
}

function splitByScript(token: string): { text: string; spaceless: boolean }[] {
  const segments: { text: string; spaceless: boolean }[] = [];
  let current = '';
  let currentSpaceless: boolean | undefined;

  for (const char of token) {
    const spaceless = SPACELESS_SCRIPT.test(char);
    if (currentSpaceless === undefined || spaceless === currentSpaceless) {
      current += char;
      currentSpaceless = spaceless;
      continue;
    }
    // A digit or a latin letter inside a Japanese phrase keeps the phrase
    // together; only a real script change starts a new segment.
    if (!spaceless && /[0-9a-z]/.test(char) && currentSpaceless) {
      current += char;
      continue;
    }
    segments.push({ text: current, spaceless: currentSpaceless });
    current = char;
    currentSpaceless = spaceless;
  }

  if (current.length > 0 && currentSpaceless !== undefined) {
    segments.push({ text: current, spaceless: currentSpaceless });
  }
  return segments;
}

/**
 * Overlap between two texts in [0,1].
 *
 * Deliberately asymmetric: it measures how much of `needle` appears in
 * `haystack`, which is the question actually being asked when checking whether
 * an event serves the user's stated goal. A short goal matching part of a long
 * description should score high, and symmetric measures punish exactly that.
 */
export function coverage(needle: string, haystack: string): number {
  const wanted = new Set(matchFeatures(needle));
  if (wanted.size === 0) return 0;
  const available = new Set(matchFeatures(haystack));
  if (available.size === 0) return 0;
  let found = 0;
  for (const feature of wanted) if (available.has(feature)) found++;
  return found / wanted.size;
}

/** True when any of `needles` appears in `haystack`, under the same normalisation. */
export function mentionsAny(haystack: string, needles: string[]): boolean {
  if (needles.length === 0) return false;
  const available = normalizeText(haystack);
  return needles.some((n) => {
    const normalized = normalizeText(n);
    return normalized.length > 0 && available.includes(normalized);
  });
}
