import {
  coverage,
  normalizeText,
  type BooleanRequest,
  type BooleanResult,
  type ChoiceRequest,
  type ChoiceResult,
  type EditorialFlag,
  type EditorialMetric,
  type EventState,
  type ScoreRequest,
  type ScoreResult,
} from '@editorial-ir/contracts';
import type { DecisionBackendIdentity, EditorialDecisionModel } from '../types.js';
import { argmax, normalise, prune, scoreFromUnit } from '../distribution.js';

/**
 * Editorial judgement from rules alone.
 *
 * This is the backend the project guarantees. No model, no key, no GPU, no
 * network, and the same answer every time — which matters more than it sounds,
 * because it means the planner, the validator and every adapter can be tested
 * against a fixed set of judgements, and because a user can run the whole thing
 * before deciding whether better judgement is worth paying for.
 *
 * It is not as good as a model and it does not pretend to be: it reports a
 * `baseConfidence` of 0.4, and that number is what the escalation policy reads
 * when deciding which events deserve something better. What it does have is
 * legibility — every score here traces to an observation you can point at.
 */
export interface HeuristicDecisionOptions {
  /** Confidence to report. Lower makes the escalation policy reach for a model sooner. */
  baseConfidence?: number;
}

export class HeuristicDecisionBackend implements EditorialDecisionModel {
  readonly identity: DecisionBackendIdentity;

  constructor(options: HeuristicDecisionOptions = {}) {
    this.identity = {
      backend: 'heuristic',
      model: 'editorial-rules',
      modelVersion: '1',
      locality: 'local',
      mediaLeavesDevice: false,
      baseConfidence: options.baseConfidence ?? 0.4,
      costPerEventUsd: 0,
    };
  }

  async score(state: EventState, request: ScoreRequest): Promise<ScoreResult> {
    const estimate = estimateMetric(request.question_id as EditorialMetric, state);
    // A rule is a blunt instrument, so the distribution it implies is broad.
    // Pretending otherwise would let the planner treat a guess as a measurement.
    return scoreFromUnit(estimate, request.levels.length, 0.25);
  }

  async booleanProbability(state: EventState, request: BooleanRequest): Promise<BooleanResult> {
    return { probability: estimateFlag(request.question_id as EditorialFlag, state) };
  }

  async choice(state: EventState, request: ChoiceRequest): Promise<ChoiceResult> {
    if (request.question_id === 'narrative_role') {
      const weights = narrativeRoleWeights(state);
      const available = Object.fromEntries(
        request.options.map((o) => [o.value, weights[o.value] ?? 0.01]),
      );
      const probabilities = prune(normalise(available));
      return { selected: argmax(probabilities), probabilities };
    }
    // An unknown choice question gets an honest uniform answer rather than a
    // confident arbitrary one.
    const uniform = normalise(Object.fromEntries(request.options.map((o) => [o.value, 1])));
    return { selected: argmax(uniform), probabilities: uniform };
  }
}

/* -------------------------------------------------------------------------- */
/* Metric estimators                                                           */
/* -------------------------------------------------------------------------- */

/** Audio tags that indicate something is happening rather than merely playing. */
const LIVELY_AUDIO = new Set(['laughter', 'applause', 'cheering']);

export function estimateMetric(metric: EditorialMetric, state: EventState): number {
  switch (metric) {
    case 'story_importance':
      return storyImportance(state);
    case 'emotional_intensity':
      return emotionalIntensity(state);
    case 'context_relevance':
      return contextRelevance(state);
    case 'visual_quality':
      return state.observed.technical_quality ?? 0.5;
    case 'audio_quality':
      return audioQuality(state);
    case 'uniqueness':
      return 1 - redundancy(state);
    case 'redundancy':
      return redundancy(state);
    case 'continuity_previous':
      return continuityWith(state, state.previous_event);
    case 'continuity_next':
      return continuityWith(state, state.next_event);
    case 'information_density':
      return informationDensity(state);
    default:
      return 0.5;
  }
}

function storyImportance(state: EventState): number {
  // The user's word is not a heuristic input; it is the answer.
  if (state.user_context.essential) return 1;

  let value = 0.3;
  value += 0.25 * emotionalIntensity(state);
  value += 0.2 * informationDensity(state);
  value += 0.15 * contextRelevance(state);
  value += 0.1 * (state.semantic.entities.people.length > 0 ? 1 : 0);
  value -= 0.25 * redundancy(state);
  // A moment nobody stayed on is rarely the moment that mattered.
  if (state.duration_ms < 1500) value -= 0.1;
  return clamp(value);
}

function emotionalIntensity(state: EventState): number {
  const affectValues = Object.values(state.semantic.affect);
  let value = affectValues.length > 0 ? Math.max(...affectValues) : 0.2;
  if (state.observed.audio.some((a) => LIVELY_AUDIO.has(a))) value = Math.max(value, 0.65);
  return clamp(value);
}

function contextRelevance(state: EventState): number {
  const wanted = [
    state.user_context.occasion ?? '',
    state.user_context.goal ?? '',
    ...state.user_context.tone,
    ...state.user_context.notes,
  ]
    .filter((s) => s.length > 0)
    .join(' ');

  // With nothing stated there is nothing to be relevant to, so neither reward
  // nor punish: a flat 0.5 leaves the ranking to the other metrics.
  if (wanted.length === 0) return 0.5;

  const have = [
    state.semantic.description,
    state.semantic.event_type,
    ...state.semantic.entities.places,
    ...state.semantic.entities.topics,
    ...state.observed.speech,
    ...state.observed.ocr,
  ].join(' ');

  return clamp(0.35 + 0.65 * coverage(wanted, have));
}

function audioQuality(state: EventState): number {
  // Without a real measurement the observable proxies are how much of the event
  // carries speech and how much of it is dead.
  const speech = state.observed.speech_ratio;
  const silence = state.observed.silence_ratio;
  if (speech === 0 && silence === 0) return 0.5;
  return clamp(0.45 + 0.45 * speech - 0.3 * Math.max(0, silence - 0.5));
}

function redundancy(state: EventState): number {
  const similarity = state.max_similarity_to_others;
  if (similarity === undefined) return 0.2;
  // Similarity is not redundancy until it is high: two events in the same room
  // are similar without either being disposable.
  return clamp((similarity - 0.6) / 0.4);
}

function continuityWith(
  state: EventState,
  neighbour: { description: string; event_type: string } | undefined,
): number {
  // Nothing on that side means nothing to jar against.
  if (!neighbour) return 0.5;
  const sameType = neighbour.event_type === state.semantic.event_type;
  const overlap = coverage(neighbour.description, state.semantic.description);
  return clamp(0.35 + (sameType ? 0.2 : 0) + 0.45 * overlap);
}

function informationDensity(state: EventState): number {
  const seconds = Math.max(1, state.duration_ms / 1000);
  const characters = state.observed.speech.join('').length;
  // Around ten characters a second is ordinary conversational pace in both
  // Japanese and English once punctuation is gone.
  const speechDensity = clamp(characters / seconds / 10);
  const onScreen = state.observed.ocr.length > 0 ? 0.15 : 0;
  // A shot of a night view says nothing and shows something. Counting only
  // words would rank every wordless shot in a travel film as empty, which is
  // how an automatic cut ends up being all talking and no place.
  const seen = clamp(state.observed.visual_labels.length / 5) * 0.25;
  return clamp(0.7 * speechDensity + onScreen + seen);
}

/* -------------------------------------------------------------------------- */
/* Flag estimators                                                             */
/* -------------------------------------------------------------------------- */

/** Openings that cannot stand alone: the sentence refers to something unseen. */
const DEICTIC_OPENERS = [
  'それ', 'これ', 'あれ', 'そこ', 'ここ', 'その', 'この', 'あの', 'だから', 'でも', 'そして',
  'this', 'that', 'these', 'those', 'so ', 'but ', 'and ', 'then ', 'it ',
];

export function estimateFlag(flag: EditorialFlag, state: EventState): number {
  switch (flag) {
    case 'preserve':
      return state.user_context.essential ? 1 : clamp(0.15 + 0.85 * storyImportance(state));
    case 'redundant':
      return redundancy(state);
    case 'establishing_shot':
      return clamp(
        (state.observed.speech.length === 0 ? 0.4 : 0.05) +
          (state.semantic.entities.places.length > 0 ? 0.3 : 0) +
          (state.observed.shot_count <= 2 ? 0.2 : 0) +
          (state.duration_ms >= 2000 ? 0.1 : 0),
      );
    case 'b_roll_candidate':
      return clamp(
        (state.observed.speech_ratio < 0.2 ? 0.5 : 0.05) + 0.4 * (state.observed.technical_quality ?? 0.5),
      );
    case 'opening_candidate':
      return clamp(
        (state.relative_position < 0.2 ? 0.35 : 0.05) +
          0.4 * emotionalIntensity(state) +
          (state.semantic.event_type === 'arrival' || state.semantic.event_type === 'departure' ? 0.2 : 0),
      );
    case 'ending_candidate':
      return clamp(
        (state.relative_position > 0.75 ? 0.4 : 0.05) +
          0.3 * emotionalIntensity(state) +
          (state.semantic.event_type === 'farewell' ? 0.3 : 0),
      );
    case 'requires_previous_context': {
      const opener = normalizeText(state.observed.speech[0] ?? '');
      const deictic = DEICTIC_OPENERS.some((d) => opener.startsWith(normalizeText(d)));
      return clamp((deictic ? 0.55 : 0.15) + (state.semantic.event_type === 'reaction' ? 0.25 : 0));
    }
    case 'contains_dead_air':
      return clamp(state.observed.silence_ratio);
    default:
      return 0.5;
  }
}

/* -------------------------------------------------------------------------- */
/* Narrative role                                                              */
/* -------------------------------------------------------------------------- */

export function narrativeRoleWeights(state: EventState): Record<string, number> {
  const weights: Record<string, number> = {
    setup: 0.1,
    context: 0.1,
    build_up: 0.1,
    transition: 0.1,
    payoff: 0.1,
    climax: 0.05,
    reaction: 0.1,
    resolution: 0.05,
    ending: 0.05,
    filler: 0.1,
  };

  const type = state.semantic.event_type;
  const intensity = emotionalIntensity(state);
  const position = state.relative_position;

  if (type === 'travel' || type === 'departure') weights.transition = (weights.transition ?? 0) + 0.5;
  if (type === 'arrival') {
    weights.payoff = (weights.payoff ?? 0) + 0.35;
    weights.setup = (weights.setup ?? 0) + 0.15;
  }
  if (type === 'reaction') weights.reaction = (weights.reaction ?? 0) + 0.5;
  if (type === 'explanation') weights.context = (weights.context ?? 0) + 0.5;
  if (type === 'farewell') weights.ending = (weights.ending ?? 0) + 0.6;
  if (type === 'b_roll') {
    weights.context = (weights.context ?? 0) + 0.2;
    weights.transition = (weights.transition ?? 0) + 0.2;
  }

  if (position < 0.15) weights.setup = (weights.setup ?? 0) + 0.3;
  if (position > 0.85) {
    weights.resolution = (weights.resolution ?? 0) + 0.25;
    weights.ending = (weights.ending ?? 0) + 0.25;
  }

  if (intensity > 0.8) weights.climax = (weights.climax ?? 0) + 0.3 * intensity;
  else if (intensity > 0.6) weights.payoff = (weights.payoff ?? 0) + 0.25;

  // Nothing said, nothing felt, nothing on screen and nothing distinctive in
  // frame: that is filler, and calling it anything else is how a rough cut fills
  // up with material nobody wanted. Requiring all four matters — a wordless shot
  // of a city at night is not filler, it is the ending.
  const nothingSeen = state.observed.visual_labels.length === 0;
  if (state.observed.speech.length === 0 && intensity < 0.3 && state.observed.ocr.length === 0 && nothingSeen) {
    weights.filler = (weights.filler ?? 0) + 0.4;
  } else if (state.observed.speech.length === 0 && !nothingSeen) {
    // Wordless but with something in frame: that is what b-roll and
    // establishing shots are made of.
    weights.context = (weights.context ?? 0) + 0.2;
    weights.transition = (weights.transition ?? 0) + 0.15;
  }

  return weights;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
