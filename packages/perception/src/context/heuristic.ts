import type { DescribeParams, DescribeResult } from '@editorial-ir/contracts';
import type { ContextModel, ModelIdentity } from '../types.js';
import { normalizeText } from '../text-embedding/hashing.js';

/**
 * A context model that uses no model at all.
 *
 * It reads the observations and assembles a description from them: what was
 * said, what was on screen, what the sound was doing. It is not a substitute for
 * a vision-language model and it does not pretend to be — it returns a low
 * confidence, which is precisely the signal the escalation policy uses to decide
 * which events are worth spending a real model on.
 *
 * Its real job is that the pipeline has no dead end. A user with no GPU, no API
 * key and no patience still gets an Editorial IR, a semantic timeline and a
 * rough cut, and can then decide whether better understanding is worth paying
 * for. A system that refuses to run until it has a GPU never gets that far.
 */
export interface HeuristicContextOptions {
  /** Longest description to assemble, in characters. */
  maxLength?: number;
}

export class HeuristicContextModel implements ContextModel {
  readonly identity: ModelIdentity;
  private readonly maxLength: number;

  constructor(options: HeuristicContextOptions = {}) {
    this.maxLength = options.maxLength ?? 140;
    this.identity = {
      backend: 'heuristic',
      model: 'observation-summary',
      modelVersion: '1',
      locality: 'local',
      mediaLeavesDevice: false,
    };
  }

  async describe(params: DescribeParams): Promise<DescribeResult> {
    return describeFromObservations(params, this.maxLength);
  }
}

/** Separated from the class so the whole mapping is testable as a pure function. */
export function describeFromObservations(params: DescribeParams, maxLength = 140): DescribeResult {
  const speech = params.transcript.filter((t) => t.trim().length > 0);
  const ocr = params.ocr.filter((t) => t.trim().length > 0);
  const audio = params.audio_tags;

  const parts: string[] = [];
  if (speech.length > 0) parts.push(speech.join(' '));
  if (ocr.length > 0) parts.push(`[${ocr.slice(0, 3).join(' / ')}]`);
  if (parts.length === 0 && audio.length > 0) parts.push(audio.join(', '));

  const description = truncate(parts.join(' ').trim() || 'no speech or on-screen text', maxLength);

  return {
    model: 'observation-summary',
    description,
    event_type: inferEventType(speech, ocr, audio),
    ...(speech[0] ? { title: truncate(speech[0], 40) } : {}),
    entities: { people: [], places: [], objects: [], topics: keywordsOf(speech, ocr) },
    affect: inferAffect(speech, audio),
    // Deliberately low. An observation summary is not an understanding, and the
    // escalation policy reads this number to decide what deserves a real model.
    confidence: speech.length > 0 ? 0.35 : 0.2,
  };
}

/**
 * Keyword rules for the event type.
 *
 * Bilingual because the first users of this project speak Japanese and the
 * second speak English, and a system that only recognises one of them produces
 * an unusable timeline for the other.
 */
const EVENT_TYPE_RULES: { type: string; patterns: RegExp[] }[] = [
  { type: 'arrival', patterns: [/着いた|到着|ついた/, /\b(arrived|we'?re here|made it)\b/] },
  { type: 'departure', patterns: [/出発|行こう|でかけ/, /\b(let'?s go|heading out|leaving)\b/] },
  { type: 'meal', patterns: [/食べ|美味し|おいし|ごはん|ランチ|ディナー/, /\b(eat|eating|delicious|lunch|dinner|tasty)\b/] },
  { type: 'travel', patterns: [/電車|バス|車|移動|駅/, /\b(train|bus|car|station|driving)\b/] },
  { type: 'reaction', patterns: [/すごい|やば|うわ|えー/, /\b(wow|amazing|oh my|no way)\b/] },
  { type: 'explanation', patterns: [/つまり|理由|説明|というのは/, /\b(because|the reason|basically|so what)\b/] },
  { type: 'farewell', patterns: [/また来|さよなら|ありがとう|おわり/, /\b(goodbye|see you|thank you|that'?s it)\b/] },
];

export function inferEventType(speech: string[], ocr: string[], audio: string[]): string {
  const haystack = normalizeText([...speech, ...ocr].join(' '));
  for (const rule of EVENT_TYPE_RULES) {
    if (rule.patterns.some((p) => p.test(haystack))) return rule.type;
  }
  if (audio.includes('laughter')) return 'reaction';
  if (speech.length === 0) return 'b_roll';
  return 'moment';
}

export function inferAffect(speech: string[], audio: string[]): Record<string, number> {
  const affect: Record<string, number> = {};
  const haystack = normalizeText(speech.join(' '));

  if (audio.includes('laughter')) {
    affect.humour = 0.7;
    affect.happiness = 0.6;
  }
  if (audio.includes('applause') || audio.includes('cheering')) affect.excitement = 0.7;
  if (audio.includes('crowd')) affect.excitement = Math.max(affect.excitement ?? 0, 0.4);
  if (/すごい|やば|うわ|最高/.test(haystack) || /\b(wow|amazing|awesome|incredible)\b/.test(haystack)) {
    affect.excitement = Math.max(affect.excitement ?? 0, 0.65);
  }
  if (/ありがとう|嬉しい|楽しい/.test(haystack) || /\b(happy|glad|thank you|love)\b/.test(haystack)) {
    affect.happiness = Math.max(affect.happiness ?? 0, 0.6);
  }
  if (audio.includes('silence') && speech.length === 0) affect.calm = 0.5;

  return affect;
}

/** Longest tokens, which in practice are the content words in both scripts. */
export function keywordsOf(speech: string[], ocr: string[], limit = 5): string[] {
  const counts = new Map<string, number>();
  for (const text of [...speech, ...ocr]) {
    for (const token of normalizeText(text).split(' ')) {
      if (token.length < 2) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([token]) => token);
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}
