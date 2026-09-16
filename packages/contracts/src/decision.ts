import { z } from 'zod';
import { Milliseconds, Probability, UnitScore, obj } from './primitives.js';
import { Affect } from './event.js';

/**
 * The decision layer's contract.
 *
 * Asking a language model to emit `"importance": 0.82` and storing the number is
 * the easy version and the wrong one: nobody can say what 0.82 meant, two runs
 * are not comparable, and there is nothing to calibrate. So the interface is
 * three primitives with defined semantics instead:
 *
 * - `choice`   — pick from a closed set of options, with a distribution
 * - `score`    — place on a labelled ordinal scale, with a distribution
 * - `boolean`  — probability that a statement holds
 *
 * Any backend can implement them: a rule-based one, a small local model with
 * structured output, or a hosted decision API. The IR is identical either way,
 * which is what keeps every backend optional.
 */

/**
 * The structured state a decision backend sees.
 *
 * Note what is absent: no pixels, no audio, no asset paths. The backend judges
 * an already-understood event, so it is cheap, fast and reproducible, and the
 * expensive video understanding upstream is never repeated per question.
 */
export const EventState = obj({
  event_id: z.string(),
  duration_ms: Milliseconds,
  /** Where the event falls in the project, in [0,1]. Endings behave differently from openings. */
  relative_position: UnitScore,
  observed: obj({
    speech: z.array(z.string()).default([]),
    visual_labels: z.array(z.string()).default([]),
    ocr: z.array(z.string()).default([]),
    audio: z.array(z.string()).default([]),
    shot_count: z.int().min(0).default(0),
    speech_ratio: UnitScore.default(0),
    silence_ratio: UnitScore.default(0),
    technical_quality: UnitScore.optional(),
  }),
  semantic: obj({
    description: z.string().default(''),
    event_type: z.string().default(''),
    entities: obj({
      people: z.array(z.string()).default([]),
      places: z.array(z.string()).default([]),
      topics: z.array(z.string()).default([]),
    }).prefault({}),
    affect: Affect.default({}),
  }),
  previous_event: obj({ description: z.string(), event_type: z.string() }).optional(),
  next_event: obj({ description: z.string(), event_type: z.string() }).optional(),
  /** User knowledge, verbatim. A backend may weigh it but must never contradict it. */
  user_context: obj({
    occasion: z.string().optional(),
    goal: z.string().optional(),
    tone: z.array(z.string()).default([]),
    /** Who the piece is for, when the user said. */
    audience: z.string().optional(),
    /**
     * How the user wants the piece to open, carry and finish.
     *
     * Optional rather than empty-by-default, because "they did not say" and
     * "they said nothing in particular" are different things to a model reading
     * this, and only the first should leave it free to decide.
     */
    wanted_opening: z.array(z.string()).optional(),
    wanted_middle: z.array(z.string()).optional(),
    wanted_ending: z.array(z.string()).optional(),
    notes: z.array(z.string()).default([]),
    essential: z.boolean().default(false),
  }).prefault({}),
  /** Similarity to the most similar other event, in [0,1]. Feeds redundancy. */
  max_similarity_to_others: UnitScore.optional(),
}).meta({ id: 'EventState', title: 'EventState' });
export type EventState = z.infer<typeof EventState>;

export const ChoiceOption = obj({
  value: z.string(),
  /** What this option means. Sent to the backend; the wording is part of the contract. */
  description: z.string().default(''),
}).meta({ id: 'ChoiceOption' });
export type ChoiceOption = z.infer<typeof ChoiceOption>;

export const ChoiceRequest = obj({
  question_id: z.string(),
  question: z.string(),
  options: z.array(ChoiceOption).min(2),
}).meta({ id: 'ChoiceRequest' });
export type ChoiceRequest = z.infer<typeof ChoiceRequest>;

export const ChoiceResult = obj({
  selected: z.string(),
  probabilities: z.record(z.string(), Probability).default({}),
}).meta({ id: 'ChoiceResult' });
export type ChoiceResult = z.infer<typeof ChoiceResult>;

export const ScoreLevel = obj({
  /** Ordinal level, 0-based and ascending. */
  level: z.int().min(0),
  label: z.string(),
  description: z.string().default(''),
}).meta({ id: 'ScoreLevel' });
export type ScoreLevel = z.infer<typeof ScoreLevel>;

export const ScoreRequest = obj({
  question_id: z.string(),
  question: z.string(),
  levels: z.array(ScoreLevel).min(2),
}).meta({ id: 'ScoreRequest' });
export type ScoreRequest = z.infer<typeof ScoreRequest>;

export const ScoreResult = obj({
  level: z.int().min(0),
  /**
   * The expected level normalised to [0,1].
   *
   * Using the expectation rather than the argmax is deliberate: a distribution
   * split between "important" and "essential" should land between them, not
   * snap to whichever had one more percent.
   */
  value: UnitScore,
  probabilities: z.array(Probability).default([]),
}).meta({ id: 'ScoreResult' });
export type ScoreResult = z.infer<typeof ScoreResult>;

export const BooleanRequest = obj({
  question_id: z.string(),
  /** A statement to judge, phrased so that "true" is unambiguous. */
  statement: z.string(),
}).meta({ id: 'BooleanRequest' });
export type BooleanRequest = z.infer<typeof BooleanRequest>;

export const BooleanResult = obj({
  probability: Probability,
}).meta({ id: 'BooleanResult' });
export type BooleanResult = z.infer<typeof BooleanResult>;

/**
 * Turns an ordinal distribution into a unit score.
 *
 * Exported because both the interface definition and every backend must agree on
 * it; a backend that normalises differently would silently change what every
 * Skill rule threshold means.
 */
export function expectedUnitValue(probabilities: number[], levelCount: number): number {
  if (levelCount <= 1) return 0;
  const total = probabilities.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0.5;
  let expectation = 0;
  for (let i = 0; i < probabilities.length; i++)
    expectation += (i * (probabilities[i] ?? 0)) / total;
  return Math.min(1, Math.max(0, expectation / (levelCount - 1)));
}
