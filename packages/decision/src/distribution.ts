import { expectedUnitValue } from '@editorial-ir/contracts';

/**
 * Turning point estimates into distributions, and back.
 *
 * Every backend must answer with a distribution, including the rule-based one.
 * That is not ceremony: the planner routinely has to choose between two events
 * whose scores differ by a hundredth, and the shape of the belief is the only
 * thing that distinguishes "clearly a payoff" from "could be a payoff or a
 * reaction". Throwing it away at the backend and inventing it later would be
 * worse than never having it.
 */

/**
 * Spreads a unit value across ordinal levels so that the expectation recovers
 * the value **exactly**.
 *
 * Exactness matters more than it looks. The user marking an event essential has
 * to produce a `story_importance` of 1, not 0.86, and a kernel that smears mass
 * symmetrically can never put the mean at the end of the scale — all its mass is
 * on one side. So the shape is chosen from the family of distributions that do
 * have the requested mean:
 *
 * - `concentration = 0` gives the maximum-entropy distribution with that mean,
 *   which is the honest shape for "this is my estimate and I have no further
 *   information". At the ends of the scale it collapses to a spike on its own,
 *   because no spread distribution can average out to the end of a scale.
 * - `concentration = 1` gives the minimal two-point distribution, for a backend
 *   that is confident.
 *
 * Both have the same mean, so any blend of them does too.
 */
export function unitToDistribution(value: number, levelCount: number, concentration = 0.4): number[] {
  if (levelCount <= 1) return [1];
  const clamped = Math.min(1, Math.max(0, value));
  const mean = clamped * (levelCount - 1);
  const weight = Math.min(1, Math.max(0, concentration));

  const spread = maximumEntropyDistribution(mean, levelCount);
  const peaked = twoPointDistribution(mean, levelCount);

  return spread.map((p, i) => round((1 - weight) * p + weight * (peaked[i] ?? 0)));
}

/**
 * The maximum-entropy distribution over {0 … n-1} with the given mean.
 *
 * It is the exponential family p_i proportional to exp(lambda * i), with lambda
 * found by bisection because the mean is monotonic in it. Assuming nothing
 * beyond the mean is exactly what a backend that reported only an estimate is
 * entitled to claim.
 */
export function maximumEntropyDistribution(mean: number, levelCount: number): number[] {
  const last = levelCount - 1;
  if (mean <= 0) return spike(0, levelCount);
  if (mean >= last) return spike(last, levelCount);

  let low = -60;
  let high = 60;
  let probabilities = uniform(levelCount);
  for (let iteration = 0; iteration < 60; iteration++) {
    const lambda = (low + high) / 2;
    probabilities = exponentialFamily(lambda, levelCount);
    const current = probabilities.reduce((sum, p, i) => sum + p * i, 0);
    if (Math.abs(current - mean) < 1e-9) break;
    if (current < mean) low = lambda;
    else high = lambda;
  }
  return probabilities;
}

/** The narrowest distribution with the given mean: mass on the two bracketing levels. */
export function twoPointDistribution(mean: number, levelCount: number): number[] {
  const last = levelCount - 1;
  if (mean <= 0) return spike(0, levelCount);
  if (mean >= last) return spike(last, levelCount);
  const lower = Math.floor(mean);
  const fraction = mean - lower;
  const out = new Array<number>(levelCount).fill(0);
  out[lower] = 1 - fraction;
  out[lower + 1] = fraction;
  return out;
}

function exponentialFamily(lambda: number, levelCount: number): number[] {
  // Shift by the largest exponent before exponentiating, or a steep lambda
  // overflows to Infinity and the whole distribution becomes NaN.
  const maxExponent = lambda >= 0 ? lambda * (levelCount - 1) : 0;
  const weights: number[] = [];
  let total = 0;
  for (let i = 0; i < levelCount; i++) {
    const w = Math.exp(lambda * i - maxExponent);
    weights.push(w);
    total += w;
  }
  return weights.map((w) => w / total);
}

function spike(index: number, levelCount: number): number[] {
  const out = new Array<number>(levelCount).fill(0);
  out[index] = 1;
  return out;
}

function uniform(levelCount: number): number[] {
  return new Array<number>(levelCount).fill(1 / levelCount);
}

/** Nearest level to a unit value. */
export function unitToLevel(value: number, levelCount: number): number {
  if (levelCount <= 1) return 0;
  return Math.round(Math.min(1, Math.max(0, value)) * (levelCount - 1));
}

/** Builds a complete score answer from one estimate. */
export function scoreFromUnit(
  value: number,
  levelCount: number,
  concentration = 0.4,
): { level: number; value: number; probabilities: number[] } {
  const probabilities = unitToDistribution(value, levelCount, concentration);
  return {
    level: unitToLevel(value, levelCount),
    // Recomputed from the distribution so that the stored value and the stored
    // distribution can never disagree.
    value: round(expectedUnitValue(probabilities, levelCount)),
    probabilities,
  };
}

/** Normalises arbitrary non-negative weights into a distribution. */
export function normalise(weights: Record<string, number>): Record<string, number> {
  const entries = Object.entries(weights).map(([k, v]) => [k, Math.max(0, v)] as const);
  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  if (total <= 0) {
    const uniform = round(1 / Math.max(1, entries.length));
    return Object.fromEntries(entries.map(([k]) => [k, uniform]));
  }
  return Object.fromEntries(entries.map(([k, v]) => [k, round(v / total)]));
}

/** The option with the most mass, breaking ties by name so runs are reproducible. */
export function argmax(probabilities: Record<string, number>): string {
  let best = '';
  let bestValue = -Infinity;
  for (const [key, value] of Object.entries(probabilities)) {
    if (value > bestValue || (value === bestValue && key < best)) {
      best = key;
      bestValue = value;
    }
  }
  return best;
}

/** Drops negligible mass so stored distributions stay small and readable. */
export function prune(probabilities: Record<string, number>, floor = 0.02): Record<string, number> {
  const kept = Object.entries(probabilities).filter(([, v]) => v >= floor);
  if (kept.length === 0) return probabilities;
  return normalise(Object.fromEntries(kept));
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
