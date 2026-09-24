import type { OcrObservation } from '@editorial-ir/contracts';

/**
 * Telling the kinds of text in a picture apart.
 *
 * OCR reads everything that looks like letters, and on an edited video that is
 * three different things. Read on a real-shaped test programme — a sixty-second
 * edit with two title cards, fourteen burned-in subtitles and a test pattern
 * behind it — twenty-four lines came back:
 *
 * - the subtitles, which are what was said: fourteen sentences, five of them
 *   read twice with different spacing (`Then the rain started` and
 *   `Thentherain started`), all at the bottom of the frame;
 * - the scene text, which is what was shown: `HARBOUR DAYS` and `CHAPTERTWO` on
 *   the cards, in the middle of the frame;
 * - a counter burned into the picture (`80010:00:00`, `09:09:09.833`, `25`),
 *   which is neither, and which became the title of a chapter.
 *
 * Treated as one list, the subtitles were the most prominent "text on screen",
 * the counter named the chapter, and the words of a subtitle about lunch made a
 * harbour montage a `meal`. Each kind is now read for what it is.
 */

export type TextRole = 'subtitle' | 'scene' | 'junk';

/**
 * Where subtitles are, as a fraction of the frame height from the top.
 *
 * Measured on the programme above: every subtitle box was centred between 0.90
 * and 0.91, the title cards at 0.50 and the counter at 0.02. Broadcast and web
 * subtitles sit in the bottom fifth by convention; a quarter leaves room for two
 * lines.
 */
export const SUBTITLE_BAND_TOP = 0.75;

/**
 * How many separate reads it takes to call the bottom band a subtitle track.
 *
 * One sentence at the bottom of one frame is as likely to be a banner in shot as
 * a subtitle. Subtitles recur — the programme above had one on screen three
 * seconds in every four — and three reads is the fewest that says so. OCR reads
 * one frame per shot, so it takes three shots with a sentence in the bottom
 * band: a subtitled clip of one or two shots keeps its lines as scene text,
 * which the describer still reads, rather than having a banner taken for a
 * track.
 */
export const SUBTITLE_MIN_READS = 3;

/**
 * Text that is a counter or a timecode rather than something shown.
 *
 * No letter in it, and either a colon between digits — `80010:00:00`,
 * `000'20:60:60`, `00:00:10.008` were all read off test patterns and camera
 * overlays in the probes — or three characters or fewer, which is a frame counter
 * (`25`, `63`, `390`). A number that says something, like `29.97` on a settings
 * screen or a year on a banner, is longer than that and has no colon, and stays.
 */
export function isTimecodeLike(text: string): boolean {
  const compact = text.replace(/\s+/g, '');
  if (compact.length === 0) return true;
  if (/\p{L}/u.test(compact)) return false;
  if (/\d[:;]\d/.test(compact)) return true;
  return compact.length <= 3;
}

/** The same line however OCR happened to space or case it. */
export function textKey(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

/**
 * Whether a line reads like something said rather than something labelled.
 *
 * Two words; or six characters of a script written without spaces; or one run of
 * twelve letters, which is a sentence whose spaces OCR lost
 * (`Minefellapartimmediately` was read that way). `SHOP` at the bottom of a
 * frame is a sign; `今日はUSJだね` is a sentence.
 */
function sentenceLike(text: string): boolean {
  if (!/\p{L}/u.test(text)) return false;
  const words = text
    .trim()
    .split(/\s+/)
    .filter((word) => /\p{L}/u.test(word));
  const compact = text.replace(/\s+/g, '');
  if (words.length >= 2) return true;
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(compact)) {
    return compact.length >= 6;
  }
  return compact.length >= 12;
}

function inBottomBand(bbox: OcrObservation['bbox']): boolean {
  if (!bbox) return false;
  const [, y, , h] = bbox;
  return y + h / 2 >= SUBTITLE_BAND_TOP;
}

/**
 * The role of every OCR read, by id.
 *
 * Subtitles are decided per asset, because "recurring" is a property of the file
 * rather than of one read: an asset whose bottom band holds sentence-like text in
 * at least {@link SUBTITLE_MIN_READS} separate reads has a subtitle track, and
 * those reads are its subtitles. A read with no box is scene text — which is
 * every read in the worked example, whose recorded OCR carries none, so its
 * events are what they were.
 */
export function textRoles(ocr: readonly OcrObservation[]): Map<string, TextRole> {
  const roles = new Map<string, TextRole>();
  const candidates = new Map<string, OcrObservation[]>();
  for (const read of ocr) {
    if (isTimecodeLike(read.text)) {
      roles.set(read.id, 'junk');
      continue;
    }
    if (inBottomBand(read.bbox) && sentenceLike(read.text)) {
      const list = candidates.get(read.asset_id) ?? [];
      list.push(read);
      candidates.set(read.asset_id, list);
    }
    roles.set(read.id, 'scene');
  }
  for (const reads of candidates.values()) {
    const moments = new Set(reads.map((read) => read.start_ms));
    if (moments.size < SUBTITLE_MIN_READS) continue;
    for (const read of reads) roles.set(read.id, 'subtitle');
  }
  return roles;
}

/**
 * Lines once each, in the order they first appeared.
 *
 * Two reads of the same line — `Then the rain started` and `Thentherain
 * started`, the same subtitle read in two shots — are one line. Of the spellings
 * the one with the most words is kept, because OCR loses spaces and never
 * invents them.
 */
export function distinctLines(texts: readonly string[]): string[] {
  const order: string[] = [];
  const best = new Map<string, string>();
  for (const text of texts) {
    const key = textKey(text);
    if (key.length === 0) continue;
    const kept = best.get(key);
    if (kept === undefined) {
      order.push(key);
      best.set(key, text);
    } else if (wordCount(text) > wordCount(kept)) {
      best.set(key, text);
    }
  }
  return order.map((key) => best.get(key)!);
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).length;
}
