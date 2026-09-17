import {
  compareText,
  coverage,
  overlapMs,
  rangesOverlap,
  type AssetPlacement,
  type AudioEvent,
  type MediaAsset,
  type ObservationTimeline,
  type Shot,
  type UserAnnotation,
  type Utterance,
} from '@editorial-ir/contracts';

/**
 * Turning shots into events.
 *
 * A shot is a camera unit. An event is a unit of meaning, and they are not the
 * same thing: three shots of walking up to a gate are one event, and a single
 * unbroken take of a conversation that changes subject is two. Everything above
 * this layer reasons about events, so getting the boundaries roughly right
 * matters more than almost anything else the compiler does.
 *
 * The method is agglomerative. Start from the smallest defensible units, score
 * every boundary between them by how much actually changes there, and merge the
 * weakest boundaries away until what is left is event-sized. Bottom-up rather
 * than top-down because the signals available — a shot change, a pause, a new
 * face — are all local, and a top-down split would have to invent a global
 * criterion none of them support.
 */

export interface SegmentationOptions {
  /** Nothing shorter than this survives as its own event. */
  minEventMs?: number;
  /** Nothing longer than this is ever produced by merging. */
  maxEventMs?: number;
  /** The event length the result should average out near. */
  targetEventMs?: number;
  /** Boundaries weaker than this are merged away. */
  mergeThreshold?: number;
  /** A pause at least this long counts as a boundary signal. */
  silenceGapMs?: number;
  /** Window either side of a boundary that signals are read from. */
  boundaryWindowMs?: number;
}

const DEFAULTS: Required<SegmentationOptions> = {
  minEventMs: 2000,
  maxEventMs: 45_000,
  targetEventMs: 9000,
  mergeThreshold: 0.38,
  silenceGapMs: 700,
  boundaryWindowMs: 1200,
};

/** The smallest unit segmentation works with: one shot, or a fixed window. */
export interface Atom {
  asset_id: string;
  start_ms: number;
  end_ms: number;
  shot_ids: string[];
  /** Frame that best represents this atom, for visual comparison. */
  representative_frame_ms: number;
  /** Strength of the shot boundary that opened it, when there was one. */
  change_score?: number;
}

export interface SegmentDraft {
  asset_id: string;
  /** Times within the asset. Capture-timeline positions are added later. */
  start_ms: number;
  end_ms: number;
  shot_ids: string[];
  method: 'shot' | 'speech' | 'silence' | 'similarity' | 'user' | 'asset' | 'fixed';
  boundary_confidence: number;
}

/**
 * Builds the atoms for one asset.
 *
 * Shots when they exist, fixed windows when they do not. The fallback matters:
 * an audio-only file and a machine without shot detection both still have to
 * produce events, and a single 40-minute event is not an event.
 */
export function buildAtoms(
  asset: MediaAsset,
  shots: readonly Shot[],
  options: SegmentationOptions = {},
  forcedSplits: readonly number[] = [],
): Atom[] {
  const settings = { ...DEFAULTS, ...options };
  const own = shots
    .filter((shot) => shot.asset_id === asset.id)
    .sort((a, b) => a.start_ms - b.start_ms);

  if (own.length > 0) {
    return cutAt(
      own.map((shot) => ({
        asset_id: asset.id,
        start_ms: shot.start_ms,
        end_ms: shot.end_ms,
        shot_ids: [shot.id],
        representative_frame_ms: shot.representative_frame_ms,
        ...(shot.change_score === undefined ? {} : { change_score: shot.change_score }),
      })),
      forcedSplits,
    );
  }

  const duration = asset.duration_ms;
  if (duration <= 0) return [];

  const window = Math.min(settings.targetEventMs, Math.max(settings.minEventMs, 5000));
  const atoms: Atom[] = [];
  for (let start = 0; start < duration; start += window) {
    const end = Math.min(duration, start + window);
    if (end - start < 200) break;
    atoms.push({
      asset_id: asset.id,
      start_ms: start,
      end_ms: end,
      shot_ids: [],
      representative_frame_ms: start + Math.floor((end - start) / 3),
    });
  }
  return cutAt(atoms, forcedSplits);
}

/**
 * Cuts atoms where the user demanded a boundary.
 *
 * A forced split can only be honoured at an atom edge, because that is where
 * boundaries are evaluated. Without this, "split here" quietly meant "split here
 * if a shot change happens to be within six hundred milliseconds" — and when it
 * was not, the annotation was accepted, reported, and discarded.
 *
 * The user saw two moments where the camera saw one take. That is exactly the
 * correction this exists to accept, so the atom gives way.
 */
function cutAt(atoms: Atom[], splits: readonly number[]): Atom[] {
  if (splits.length === 0) return atoms;

  const out: Atom[] = [];
  for (const atom of atoms) {
    const inside = [...new Set(splits)]
      .filter((at) => at > atom.start_ms + MIN_ATOM_MS && at < atom.end_ms - MIN_ATOM_MS)
      .sort((a, b) => a - b);
    if (inside.length === 0) {
      out.push(atom);
      continue;
    }

    let from = atom.start_ms;
    for (const [index, at] of [...inside, atom.end_ms].entries()) {
      out.push({
        ...atom,
        start_ms: from,
        end_ms: at,
        representative_frame_ms: from + Math.floor((at - from) / 3),
        // The opening boundary of every piece after the first is the user's, not
        // a camera change, so the camera's score does not describe it.
        ...(index === 0 ? {} : { change_score: undefined }),
      });
      from = at;
    }
  }
  return out;
}

/** The shortest piece worth making; below this a split produces nothing usable. */
const MIN_ATOM_MS = 200;

interface BoundarySignals {
  /** Set only when a signal was actually available. */
  visual?: number;
  speechSpanning?: boolean;
  speakerChange?: number;
  silence?: number;
  shotChange?: number;
  topic?: number;
  /** The user demanded a boundary here, or demanded there not be one. */
  forced?: 'split' | 'merge';
}

/**
 * How much changes at a boundary, in [0,1].
 *
 * Weights are renormalised over the signals that exist, so a machine with no
 * transcriber and no vision model gets a meaningful score from shot changes and
 * silence alone rather than a diluted one.
 */
export function separationScore(signals: BoundarySignals): number {
  if (signals.forced === 'split') return 1;
  if (signals.forced === 'merge') return 0;

  // Speech running across a boundary is the strongest evidence there is: a
  // sentence does not straddle two events.
  if (signals.speechSpanning) return 0.05;

  const terms: { value: number; weight: number }[] = [];
  if (signals.visual !== undefined) terms.push({ value: signals.visual, weight: 0.4 });
  if (signals.silence !== undefined) terms.push({ value: signals.silence, weight: 0.25 });
  if (signals.shotChange !== undefined) terms.push({ value: signals.shotChange, weight: 0.15 });
  if (signals.topic !== undefined) terms.push({ value: signals.topic, weight: 0.2 });
  if (signals.speakerChange !== undefined)
    terms.push({ value: signals.speakerChange, weight: 0.15 });

  if (terms.length === 0) return 0.5;

  const totalWeight = terms.reduce((sum, t) => sum + t.weight, 0);
  const score = terms.reduce((sum, t) => sum + t.value * t.weight, 0) / totalWeight;
  return Math.min(1, Math.max(0, score));
}

export interface SegmentContext {
  utterances: readonly Utterance[];
  audioEvents: readonly AudioEvent[];
  /** Cosine similarity between two frames, when a visual model produced vectors. */
  frameSimilarity?: (assetId: string, aMs: number, bMs: number) => number | undefined;
  /** Boundaries the user demanded, in asset time. */
  forcedSplits?: readonly number[];
  forcedMerges?: readonly number[];
}

export function signalsAt(
  before: Atom,
  after: Atom,
  context: SegmentContext,
  options: SegmentationOptions = {},
): BoundarySignals {
  const settings = { ...DEFAULTS, ...options };
  const at = after.start_ms;
  const window = settings.boundaryWindowMs;
  const signals: BoundarySignals = {};

  const forcedSplit = context.forcedSplits?.some((ms) => Math.abs(ms - at) <= window / 2);
  const forcedMerge = context.forcedMerges?.some((ms) => Math.abs(ms - at) <= window / 2);
  if (forcedSplit) signals.forced = 'split';
  else if (forcedMerge) signals.forced = 'merge';

  const assetUtterances = context.utterances.filter((u) => u.asset_id === before.asset_id);

  const spanning = assetUtterances.find((u) => u.start_ms < at - 120 && u.end_ms > at + 120);
  if (spanning) signals.speechSpanning = true;

  const beforeSpeech = assetUtterances.filter((u) => rangesOverlap(u, before));
  const afterSpeech = assetUtterances.filter((u) => rangesOverlap(u, after));

  if (beforeSpeech.length > 0 && afterSpeech.length > 0) {
    const lastBefore = beforeSpeech.at(-1);
    const firstAfter = afterSpeech[0];
    if (lastBefore?.speaker_id && firstAfter?.speaker_id) {
      signals.speakerChange = lastBefore.speaker_id === firstAfter.speaker_id ? 0 : 1;
    }
    const beforeText = beforeSpeech.map((u) => u.text).join(' ');
    const afterText = afterSpeech.map((u) => u.text).join(' ');
    // Coverage in both directions, so a long passage and a short reply are
    // compared fairly.
    const shared = Math.max(coverage(afterText, beforeText), coverage(beforeText, afterText));
    signals.topic = 1 - shared;
  }

  const silence = context.audioEvents
    .filter((event) => event.asset_id === before.asset_id && event.event_type === 'silence')
    .map((event) => overlapMs(event, { start_ms: at - window, end_ms: at + window }))
    .reduce((longest, ms) => Math.max(longest, ms), 0);
  if (silence > 0) {
    signals.silence = Math.min(1, silence / (settings.silenceGapMs * 2));
  }

  if (after.change_score !== undefined) signals.shotChange = after.change_score;

  const similarity = context.frameSimilarity?.(
    before.asset_id,
    before.representative_frame_ms,
    after.representative_frame_ms,
  );
  if (similarity !== undefined) signals.visual = Math.min(1, Math.max(0, 1 - similarity));

  return signals;
}

/**
 * Merges atoms into events for one asset.
 *
 * Two passes. The first is obligatory: anything shorter than the minimum is not
 * an event and is absorbed into whichever neighbour it resembles more. The
 * second is discretionary: weak boundaries are merged away until what remains
 * has boundaries worth having, subject to a cap on how many events an asset of
 * this length should produce.
 */
export function segmentAtoms(
  atoms: readonly Atom[],
  context: SegmentContext,
  options: SegmentationOptions = {},
): SegmentDraft[] {
  const settings = { ...DEFAULTS, ...options };
  if (atoms.length === 0) return [];

  let segments: Atom[] = atoms.map((atom) => ({ ...atom, shot_ids: [...atom.shot_ids] }));
  const separations = (list: Atom[]): number[] =>
    list.slice(1).map((after, i) => separationScore(signalsAt(list[i]!, after, context, settings)));

  const durationOf = (atom: Atom): number => atom.end_ms - atom.start_ms;

  const mergeAt = (list: Atom[], index: number): Atom[] => {
    const left = list[index];
    const right = list[index + 1];
    if (!left || !right) return list;
    const merged: Atom = {
      asset_id: left.asset_id,
      start_ms: left.start_ms,
      end_ms: right.end_ms,
      shot_ids: [...left.shot_ids, ...right.shot_ids],
      // Keep the frame from the longer half: it represents more of the result.
      representative_frame_ms:
        durationOf(left) >= durationOf(right)
          ? left.representative_frame_ms
          : right.representative_frame_ms,
      ...(left.change_score === undefined ? {} : { change_score: left.change_score }),
    };
    return [...list.slice(0, index), merged, ...list.slice(index + 2)];
  };

  // Pass one: absorb anything too short to be an event.
  let changed = true;
  while (changed && segments.length > 1) {
    changed = false;
    const scores = separations(segments);
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (!segment || durationOf(segment) >= settings.minEventMs) continue;

      const leftScore = i > 0 ? (scores[i - 1] ?? 1) : Infinity;
      const rightScore = i < segments.length - 1 ? (scores[i] ?? 1) : Infinity;
      const leftFits =
        i > 0 && durationOf(segments[i - 1]!) + durationOf(segment) <= settings.maxEventMs;
      const rightFits =
        i < segments.length - 1 &&
        durationOf(segment) + durationOf(segments[i + 1]!) <= settings.maxEventMs;

      // Join the side it is more continuous with; a forced split is never crossed.
      if (leftFits && (leftScore <= rightScore || !rightFits) && leftScore < 1) {
        segments = mergeAt(segments, i - 1);
        changed = true;
        break;
      }
      if (rightFits && rightScore < 1) {
        segments = mergeAt(segments, i);
        changed = true;
        break;
      }
    }
  }

  // Pass two: merge away boundaries that are not worth having.
  const totalDuration = segments.reduce((sum, segment) => sum + durationOf(segment), 0);
  const maxEvents = Math.max(1, Math.ceil((totalDuration / settings.targetEventMs) * 1.5));

  while (segments.length > 1) {
    const scores = separations(segments);
    let weakest = -1;
    let weakestScore = Infinity;
    for (let i = 0; i < scores.length; i++) {
      const score = scores[i] ?? 1;
      const combined = durationOf(segments[i]!) + durationOf(segments[i + 1]!);
      if (combined > settings.maxEventMs) continue;
      if (score < weakestScore) {
        weakestScore = score;
        weakest = i;
      }
    }
    if (weakest < 0) break;

    const overCap = segments.length > maxEvents;
    if (weakestScore >= settings.mergeThreshold && !overCap) break;
    // A boundary the user demanded is never merged away, even to meet the cap.
    if (weakestScore >= 1) break;

    segments = mergeAt(segments, weakest);
  }

  const finalScores = separations(segments);
  return segments.map((segment, index) => ({
    asset_id: segment.asset_id,
    start_ms: segment.start_ms,
    end_ms: segment.end_ms,
    shot_ids: segment.shot_ids,
    method: methodFor(segment, context),
    // How sure we are that this event *starts* where it does.
    boundary_confidence:
      index === 0 ? 0.9 : Math.min(1, 0.4 + 0.6 * (finalScores[index - 1] ?? 0.5)),
  }));
}

function methodFor(segment: Atom, context: SegmentContext): SegmentDraft['method'] {
  if (context.forcedSplits?.some((ms) => Math.abs(ms - segment.start_ms) < 1200)) return 'user';
  if (segment.shot_ids.length > 0) return 'shot';
  if (context.utterances.some((u) => rangesOverlap(u, segment))) return 'speech';
  return 'fixed';
}

/** Segments every asset. Events never straddle two recordings. */
export function segmentAssets(
  assets: readonly MediaAsset[],
  observations: ObservationTimeline,
  annotations: readonly UserAnnotation[],
  options: SegmentationOptions = {},
  frameSimilarity?: SegmentContext['frameSimilarity'],
  placements: readonly AssetPlacement[] = [],
): SegmentDraft[] {
  const drafts: SegmentDraft[] = [];
  const offsets = new Map(placements.map((placement) => [placement.asset_id, placement.offset_ms]));

  for (const asset of [...assets].sort((a, b) => compareText(a.id, b.id))) {
    const where = {
      assetId: asset.id,
      offsetMs: offsets.get(asset.id) ?? 0,
      durationMs: asset.duration_ms,
    };
    const forcedSplits = forcedBoundaries(annotations, where, 'split');
    const atoms = buildAtoms(asset, observations.shots, options, forcedSplits);
    if (atoms.length === 0) continue;

    const context: SegmentContext = {
      utterances: observations.utterances,
      audioEvents: observations.audio_events,
      ...(frameSimilarity ? { frameSimilarity } : {}),
      forcedSplits,
      forcedMerges: forcedBoundaries(annotations, where, 'merge_with_next'),
    };

    drafts.push(...segmentAtoms(atoms, context, options));
  }

  return drafts;
}

/**
 * Where the user asked for a cut, in the time this asset is measured in.
 *
 * Two coordinate systems meet here and they used to be confused. A `time_range`
 * annotation that names no asset is capture time — every other consumer reads it
 * that way, `oea annotate`'s own help calls it "a stretch of the capture
 * timeline", and the CLI provides no syntax for anything else — while atoms,
 * and everything else in this file, are measured from the start of one asset.
 *
 * The value was passed through unconverted, so "split at 00:10:00" was compared
 * against a position ten minutes into *every* file rather than ten minutes into
 * the recording. On the worked example that annotation was accepted, reported,
 * and then did nothing at all: 73 events before, 73 after, none marked `user`.
 * Silently discarding what the user told it is the one thing this project must
 * never do.
 */
function forcedBoundaries(
  annotations: readonly UserAnnotation[],
  where: { assetId: string; offsetMs: number; durationMs: number },
  action: 'split' | 'merge_with_next',
): number[] {
  return annotations
    .filter((a) => a.type === 'boundary' && a.action === action)
    .flatMap((a) => {
      if (a.type !== 'boundary' || a.target.kind !== 'time_range') return [];

      // Named an asset: the time is already that asset's, and it applies to no
      // other. Named none: capture time, which belongs to whichever asset it
      // lands in — and to no other, which is what the old `?? assetId` broke.
      if (a.target.asset_id !== undefined) {
        if (a.target.asset_id !== where.assetId) return [];
        return [a.at_ms ?? a.target.start_ms];
      }

      const captureMs = a.at_ms ?? a.target.start_ms;
      const local = captureMs - where.offsetMs;
      if (local < 0 || local > where.durationMs) return [];
      return [local];
    })
    .sort((a, b) => a - b);
}
