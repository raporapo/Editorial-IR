/**
 * Putting a similarity score on a footing that means the same thing every time.
 *
 * ## The bug this exists for
 *
 * Cosine similarity has no fixed scale. Each model puts unrelated pairs wherever
 * its training left them, and the numbers are not close:
 *
 * | model            | two unrelated things | two related things |
 * | ---------------- | -------------------- | ------------------ |
 * | hashing (lexical)| 0.00                 | whatever overlaps  |
 * | CLIP ViT-B/32    | 0.184 ± 0.024        | ~0.25              |
 * | multilingual-e5  | **0.722** ± 0.027    | ~0.82              |
 *
 * Measured: 1,200 frame-to-unrelated-caption pairs for CLIP, and unrelated
 * sentence pairs for e5. e5's score for two things with nothing in common is
 * *three times* CLIP's score for a good match.
 *
 * Every threshold in this project was written against the hashing vectoriser,
 * where unrelated means zero. Swapping in a real embedding model — which this
 * project now does by default — left those constants in place, and two of them
 * stopped meaning anything:
 *
 * - **Search.** `minScore: 0.15` against e5 admits everything. Measured on a
 *   real 62-minute harbour project: the query "a rocket launching into space"
 *   returned all eleven events, scoring 0.486 to 0.517. A 3% spread across the
 *   entire corpus, every one of them above the threshold. The filter was not
 *   filtering and the order was noise.
 * - **Redundancy.** `clamp((similarity - 0.6) / 0.4)` in the rules. On that same
 *   project the *least* similar pair of events scored 0.747, which is redundancy
 *   0.368, and the median pair scored 0.813, which is 0.533 — over the 0.5 line
 *   that skill rules read as "redundant". More than half the footage was marked
 *   as repeating itself, on material where nothing repeated. That one is not a
 *   ranking nuisance; it drops clips from the cut.
 *
 * ## What replaces the constants
 *
 * The same question `labels_from_scores` asks of a row of labels, asked of a
 * corpus: **how far does this score stand out from what the same model said
 * about everything else here?**
 *
 * Nothing is configured per model, and deliberately so. A table of measured
 * constants would be wrong for the first model nobody measured, which is exactly
 * how the project got here. The corpus answers it instead: for any query, almost
 * everything in the project is unrelated to it, so the bulk of the scores *is*
 * the model's null distribution, observed directly at the moment it matters.
 *
 * Median and MAD rather than mean and standard deviation, because the handful of
 * real matches are outliers and must not be allowed to inflate the spread they
 * are being measured against.
 *
 * ## Where it declines to answer
 *
 * - **Too few values.** Measured on a three-event project: three pairwise
 *   similarities put the closest pair at z = 34.5. Three numbers cannot describe
 *   a distribution, and a confident number from them is worse than none.
 * - **No spread at all.** The lexical vectoriser scores most pairs exactly zero,
 *   so its median and MAD are both zero — and calibrating it would be wrong
 *   anyway, since zero already means "nothing in common". It falls through here
 *   without a special case.
 *
 * In both, `calibrationOf` returns nothing and the caller keeps the raw score.
 */

/** The centre and spread of what "unrelated" looks like for one model, here. */
export interface Calibration {
  /**
   * `measured` when the scores describe a floor with room above it.
   *
   * `undiscriminating` when they do not — see `FULL_STRENGTH_Z` for how that is
   * decided. The distinction matters because the two want opposite fallbacks: a
   * sample too small to judge should leave the raw score alone, while a set of
   * scores that has been *established* to carry no information should contribute
   * nothing rather than pass its raw value through.
   */
  kind: 'measured' | 'undiscriminating';
  /** Median: what a pair with nothing to do with each other scores. */
  centre: number;
  /** Normal-consistent MAD. Zero never reaches a caller. */
  spread: number;
  /** How many values it was estimated from, for reporting. */
  samples: number;
}

/**
 * Below this there is no distribution, only numbers.
 *
 * The failure it exists to stop is not subtle: measured on a three-event
 * project, three pairwise similarities put the closest pair at z = 34.5. Five is
 * where a median of absolute deviations starts to describe the bulk rather than
 * an accident of which two things happened to be closest — and it is low enough
 * that the aspects a real project actually has stay calibrated. At eight, the
 * `speech` aspect of an eleven-event project fell through, because only six of
 * its events had anyone speaking, and the uncalibrated scores it fell back to
 * then won every query.
 *
 * Under it the answer is "I cannot tell", which the callers turn into their
 * existing uncalibrated behaviour rather than into a guess.
 */
export const MIN_SAMPLES = 5;

/**
 * The distance, in robust deviations, at which a score is as good as it gets.
 *
 * Measured rather than chosen. On a real 62-minute project the most similar pair
 * of events sits at z = 3.72 and the 90th percentile at 2.89; a matched
 * text pair measured directly against e5's null sits at z ≈ 3.7 and a matched
 * CLIP image-caption pair at z ≈ 2.75. Four puts the strongest real match this
 * has been measured on near the top of the range without pinning it there, and
 * leaves the median — a pair with nothing in common — at exactly zero.
 *
 * It also decides what "undiscriminating" means, and that is the useful part.
 * If `centre + FULL_STRENGTH_Z * spread` exceeds 1, a full-strength match would
 * need a cosine above 1: there is less room above the floor than there is noise
 * in it, so the ordering within these scores is the noise. Measured on the
 * `audio` aspect of a real project, whose text is "music speech" for almost
 * every event: centre 0.9754, spread 0.0271, so full strength would sit at
 * 1.084. Left alone it produced a strength of 1.000 and beat a genuinely better
 * match in another aspect. Every other aspect of the same project lands between
 * 0.900 and 0.984, so the line separates them cleanly without being drawn for
 * them.
 */
export const FULL_STRENGTH_Z = 4;

function median(sorted: readonly number[]): number {
  const middle = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * What "unrelated" looks like in this set of scores, or nothing if it cannot say.
 *
 * `scores` is every candidate's similarity for one query, or every pairwise
 * similarity in a corpus. Both are dominated by unrelated pairs, which is what
 * makes the bulk of them an estimate of the model's floor.
 */
export function calibrationOf(scores: readonly number[]): Calibration | undefined {
  if (scores.length < MIN_SAMPLES) return undefined;
  const sorted = [...scores].sort((a, b) => a - b);
  const centre = median(sorted);
  const deviations = sorted.map((value) => Math.abs(value - centre)).sort((a, b) => a - b);
  // 1.4826 makes the MAD comparable to a standard deviation for normal data, so
  // that the z below means what a z usually means.
  const spread = median(deviations) * 1.4826;
  if (!(spread > 0)) return undefined;
  // Less headroom than noise: the differences between these scores are the
  // noise. See FULL_STRENGTH_Z.
  const kind = centre + FULL_STRENGTH_Z * spread > 1 ? 'undiscriminating' : 'measured';
  return { kind, centre, spread, samples: scores.length };
}

/**
 * A raw similarity as a strength in [0,1], on the same footing for any model.
 *
 * Without a calibration this is the identity, which is what keeps the lexical
 * vectoriser and every small project behaving exactly as before.
 *
 * Strictly monotone in `score`, which matters: calibration cannot reorder
 * results within one aspect. What it changes is the absolute number — so a
 * threshold means something — and the comparison *between* aspects whose
 * vectors came from different models.
 */
export function strengthOf(score: number, calibration?: Calibration): number {
  if (!calibration) return score;
  // Established to carry no information, which is not the same as unmeasured.
  // Passing the raw score through here is what let an aspect that says the same
  // thing about every event win on the luckiest rounding.
  if (calibration.kind === 'undiscriminating') return 0;
  const z = (score - calibration.centre) / calibration.spread;
  if (z <= 0) return 0;
  return Math.min(1, z / FULL_STRENGTH_Z);
}
