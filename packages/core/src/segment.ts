import {
  STILL_SLOT_MS,
  compareText,
  coverage,
  overlapMs,
  rangesOverlap,
  type AssetPlacement,
  type AudioEvent,
  type MaterialKind,
  type MaterialProfile,
  type MediaAsset,
  type MotionProfile,
  type ObservationTimeline,
  type Shot,
  type UserAnnotation,
  type Utterance,
} from '@editorial-ir/contracts';
import { kindOf, titleCards, type Span } from './materials.js';
import { textRoles, textKey } from './onscreen-text.js';

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
  /**
   * Of boundaries that score the same, merge the one joining the least material
   * rather than the first.
   *
   * Off for raw footage — unless a long take in it was divided, whose new
   * boundaries tie by construction — and on for everything else (see
   * `segmentAssets`). Where
   * nothing distinguishes one boundary from another — an edit with no
   * transcript, no vision model and a music bed that never falls silent, or a
   * recording cut into windows because no shot detector ran — every boundary
   * scores the same, and first-wins ate the footage from the front: a
   * sixty-second edit became one 34.5-second event followed by nine single
   * shots, and ten minutes of 3-second shots became seven 45-second events
   * followed by ninety-two 3-second ones. Raw camera footage rarely has enough
   * equally scored boundaries for the order to matter: on the worked example the
   * balanced rule moved three boundaries between equally scored shots (39 s and
   * 13 s became 26 s and 26 s) and its only effect on the cut was one more
   * 1.6-second shot of walking, so raw keeps the rule it has.
   */
  balancedTies?: boolean;
}

const DEFAULTS: Required<SegmentationOptions> = {
  minEventMs: 2000,
  maxEventMs: 45_000,
  targetEventMs: 9000,
  mergeThreshold: 0.38,
  silenceGapMs: 700,
  boundaryWindowMs: 1200,
  balancedTies: false,
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
  /**
   * What opened this atom when it was not a shot boundary: the place a long take
   * was divided, and why. Absent for a shot, a window and a user's cut.
   */
  opened_by?: 'similarity' | 'speech' | 'silence' | 'fixed';
}

export type SegmentMethod =
  'shot' | 'speech' | 'silence' | 'similarity' | 'user' | 'asset' | 'fixed' | 'title_card';

export interface SegmentDraft {
  asset_id: string;
  /** Times within the asset. Capture-timeline positions are added later. */
  start_ms: number;
  end_ms: number;
  shot_ids: string[];
  method: SegmentMethod;
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

/**
 * A pause at least this long is a place an unbroken take may be divided.
 *
 * Longer than the breath between two sentences of one thought, which the
 * boundary scoring already reads as a weak silence at 700 ms; shorter than the
 * three to eight seconds a narrator leaves between the screens of a tutorial,
 * which is the pause the screen-recording probe had between every slide.
 */
export const TAKE_PAUSE_MS = 1500;

/**
 * How much the picture has to change, where it starts moving after holding
 * still, for that to be a place a take may be divided.
 *
 * In grey levels of the motion envelope — the most any of the twelve cells of
 * a 64x36 frame changed between two samples — taken as the most it reaches in
 * the first second of movement.
 *
 * Measured: the six slides of the screen-recording probe changed at 8.0 to 12.2,
 * and a picture coming back after a freeze at 94; on the three real
 * static-camera files, the moments a person or a car started to move peaked at
 * 0.52 to 2.07. Four sits between the two: a new picture, rather than something
 * stirring in the same one. Without it every one of those stirrings was a
 * boundary nothing could score — a ten-minute take of somebody fidgeting in
 * front of a tripod became a hundred events, merged from the front into six of
 * 45 seconds and ninety-two of 3.
 */
export const TAKE_CHANGE_MOTION = 4;

/** Where a long take shows that something changed, gathered once per asset. */
export interface TakeEvidence {
  /** The picture changed after holding still, or the text in it changed. */
  visual: number[];
  /** Gaps between utterances of at least {@link TAKE_PAUSE_MS}. */
  pauses: Span[];
  /** Silences of at least {@link TAKE_PAUSE_MS}. */
  silences: Span[];
}

export function takeEvidence(
  assetId: string,
  observations: ObservationTimeline,
  roles: ReadonlyMap<string, string> = textRoles(observations.ocr),
): TakeEvidence {
  // A still stretch ends where the picture moves again. Only a change the size
  // of a new picture counts; where nothing measured how much it changed (a
  // static span handed in with no envelope), the span is taken at its word.
  const profile = observations.motion_profiles.find((p) => p.asset_id === assetId);
  const stillEnds = observations.video_events
    .filter((event) => event.asset_id === assetId && event.event_type === 'static')
    .map((event) => event.end_ms)
    .sort((a, b) => a - b);
  const visual = stillEnds.filter(
    (end) => !profile || changeAfter(profile, end) >= TAKE_CHANGE_MOTION,
  );

  // Scene text that changed between two reads: the slide is a different slide.
  // Subtitles are left out, because they change every few seconds whatever the
  // picture does.
  const moments = new Map<number, Set<string>>();
  for (const read of observations.ocr) {
    if (read.asset_id !== assetId || roles.get(read.id) !== 'scene') continue;
    const keys = moments.get(read.start_ms) ?? new Set<string>();
    keys.add(textKey(read.text));
    moments.set(read.start_ms, keys);
  }
  //
  // Where between the two reads it changed is the moment the picture changed,
  // when the motion analysis saw it do so there; only with no such moment is it
  // the midpoint. Reads were one per shot, and a slide read ten seconds after
  // the last one put its boundary five seconds from the change: measured on the
  // screen-recording probe once each slide was read, the midpoints fell at
  // 19.75, 44.5 and 54.5 s against changes at 20, 40 and 50.
  const times = [...moments.keys()].sort((a, b) => a - b);
  for (let i = 1; i < times.length; i++) {
    const from = times[i - 1]!;
    const to = times[i]!;
    const before = moments.get(from)!;
    const after = moments.get(to)!;
    const same = before.size === after.size && [...before].every((key) => after.has(key));
    if (same) continue;
    const middle = Math.round((from + to) / 2);
    const changed = stillEnds
      .filter((end) => end > from && end <= to)
      .sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle) || a - b)[0];
    visual.push(changed ?? middle);
  }

  const pauses: Span[] = [];
  let spoken = -Infinity;
  for (const utterance of observations.utterances
    .filter((u) => u.asset_id === assetId)
    .sort((a, b) => a.start_ms - b.start_ms || compareText(a.id, b.id))) {
    if (Number.isFinite(spoken) && utterance.start_ms - spoken >= TAKE_PAUSE_MS) {
      pauses.push({ start_ms: spoken, end_ms: utterance.start_ms });
    }
    spoken = Math.max(spoken, utterance.end_ms);
  }

  const silences = observations.audio_events
    .filter(
      (event) =>
        event.asset_id === assetId &&
        event.event_type === 'silence' &&
        event.end_ms - event.start_ms >= TAKE_PAUSE_MS,
    )
    .map((event) => ({ start_ms: event.start_ms, end_ms: event.end_ms }));

  return { visual: [...new Set(visual)].sort((a, b) => a - b), pauses, silences };
}

/** The most the picture changes in the first second after `ms`. */
function changeAfter(profile: MotionProfile, ms: number): number {
  const first = Math.round(ms / profile.hop_ms);
  const last = Math.min(profile.motion.length, first + Math.ceil(1000 / profile.hop_ms));
  let most = 0;
  for (let i = first; i < last; i++) most = Math.max(most, profile.motion[i] ?? 0);
  return most;
}

/**
 * Divides every atom longer than an event may be.
 *
 * A shot was never divided, and `maxEventMs` limited only what merging could
 * build, so one unbroken take was one event however long it ran: a sixty-second
 * screen recording of six slides was one event read once, a ten-minute take was
 * one event of ten minutes, and a camera left running gave [30, 60, 30, 60]
 * seconds. The file header promises that "a single unbroken take of a
 * conversation that changes subject is two", and nothing did it.
 *
 * A long atom is divided where it shows a change, strongest evidence first: the
 * picture changing as much as a new picture does after holding still (see
 * {@link TAKE_CHANGE_MOTION}), or its text changing; then the pauses between
 * utterances; then silences. Every such point inside it is used, so the pieces
 * are what happened rather than a count; a piece still too long goes on to the
 * next kind of evidence, and with none left it is divided into the fewest equal
 * parts that fit. The ordinary merging then decides which of
 * the new boundaries are worth keeping, exactly as it does for shots.
 *
 * An atom no longer than `maxEventMs` is returned untouched, so footage whose
 * every shot fits — the worked example's longest is 41.5 s — is segmented
 * exactly as it was.
 */
export function subdivideLongAtoms(
  atoms: readonly Atom[],
  evidence: TakeEvidence,
  options: SegmentationOptions = {},
): Atom[] {
  const settings = { ...DEFAULTS, ...options };
  return atoms.flatMap((atom) => subdivide(atom, evidence, settings, 0));
}

const TAKE_LEVELS = ['similarity', 'speech', 'silence'] as const;

function subdivide(
  atom: Atom,
  evidence: TakeEvidence,
  settings: Required<SegmentationOptions>,
  level: number,
): Atom[] {
  if (atom.end_ms - atom.start_ms <= settings.maxEventMs) return [atom];
  const min = settings.minEventMs;
  const fits = (at: number): boolean => at >= atom.start_ms + min && at <= atom.end_ms - min;
  const inside = (span: Span): boolean =>
    span.start_ms >= atom.start_ms && span.end_ms <= atom.end_ms;

  for (let l = level; l < TAKE_LEVELS.length; l++) {
    const kind = TAKE_LEVELS[l]!;
    const candidates =
      kind === 'similarity'
        ? evidence.visual
        : (kind === 'speech' ? evidence.pauses : evidence.silences)
            .filter(inside)
            .map((span) => Math.round((span.start_ms + span.end_ms) / 2));

    const points: number[] = [];
    for (const at of [...new Set(candidates)].sort((a, b) => a - b)) {
      if (!fits(at)) continue;
      if (at - (points.at(-1) ?? atom.start_ms) < min) continue;
      points.push(at);
    }
    if (points.length === 0) continue;
    return splitAtom(atom, points, kind).flatMap((piece) =>
      subdivide(piece, evidence, settings, l + 1),
    );
  }

  const parts = Math.ceil((atom.end_ms - atom.start_ms) / settings.maxEventMs);
  const even = Array.from({ length: parts - 1 }, (_, k) =>
    Math.round(atom.start_ms + ((k + 1) * (atom.end_ms - atom.start_ms)) / parts),
  );
  return splitAtom(atom, even, 'fixed');
}

function splitAtom(
  atom: Atom,
  points: readonly number[],
  openedBy: NonNullable<Atom['opened_by']>,
): Atom[] {
  const out: Atom[] = [];
  let from = atom.start_ms;
  for (const [index, at] of [...points, atom.end_ms].entries()) {
    const representative = from + Math.floor((at - from) / 3);
    if (index === 0) {
      out.push({ ...atom, end_ms: at, representative_frame_ms: representative });
    } else {
      // What the camera's cut score and the parent's opener said was about the
      // start of the take, not about this point inside it.
      const { change_score: _score, opened_by: _opener, ...rest } = atom;
      void _score;
      void _opener;
      out.push({
        ...rest,
        start_ms: from,
        end_ms: at,
        representative_frame_ms: representative,
        opened_by: openedBy,
      });
    }
    from = at;
  }
  return out;
}

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
  /**
   * Where title cards and cuts to black begin and end, in an edited asset.
   *
   * A card introduces what follows it, so there is always a boundary where it
   * begins and never one where it ends. Weaker than the user: a split or a merge
   * the user asked for at the same place wins.
   */
  cardStarts?: readonly number[];
  cardEnds?: readonly number[];
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
  else {
    // Atoms are cut at every card edge, so a card's boundary sits on it; the
    // nearer of the two edges decides, because a half-second flash of black has
    // both within the window the user's boundaries are matched in.
    const toStart = nearestMs(context.cardStarts, at);
    const toEnd = nearestMs(context.cardEnds, at);
    if (toStart <= MIN_ATOM_MS && toStart <= toEnd) signals.forced = 'split';
    else if (toEnd <= MIN_ATOM_MS) signals.forced = 'merge';
  }

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

function nearestMs(list: readonly number[] | undefined, at: number): number {
  let best = Infinity;
  for (const ms of list ?? []) best = Math.min(best, Math.abs(ms - at));
  return best;
}

/**
 * Scores closer than this are the same score.
 *
 * Only arithmetic noise: a boundary with no signal at all scores exactly 0.5,
 * and two with the same signals score the same to the last bit.
 */
const SCORE_TIE = 1e-9;

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
      ...(left.opened_by === undefined ? {} : { opened_by: left.opened_by }),
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
    let weakestCombined = Infinity;
    for (let i = 0; i < scores.length; i++) {
      const score = scores[i] ?? 1;
      const combined = durationOf(segments[i]!) + durationOf(segments[i + 1]!);
      if (combined > settings.maxEventMs) continue;
      // Of boundaries that score the same, the one joining the least material
      // when ties are balanced, and otherwise the first (see `balancedTies`).
      const better = settings.balancedTies
        ? score < weakestScore - SCORE_TIE ||
          (Math.abs(score - weakestScore) <= SCORE_TIE && combined < weakestCombined)
        : score < weakestScore;
      if (better) {
        weakestScore = score;
        weakest = i;
        weakestCombined = combined;
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
  // A merge is a boundary the user asked to have removed, and the event that
  // swallowed it is theirs as much as a split is. It said `shot`, so the record
  // did not show the correction anywhere.
  if (context.forcedMerges?.some((ms) => ms > segment.start_ms && ms < segment.end_ms))
    return 'user';
  if (nearestMs(context.cardStarts, segment.start_ms) <= MIN_ATOM_MS) return 'title_card';
  if (segment.opened_by) return segment.opened_by;
  if (segment.shot_ids.length > 0) return 'shot';
  if (context.utterances.some((u) => rangesOverlap(u, segment))) return 'speech';
  return 'fixed';
}

/**
 * Segments every asset. Events never straddle two recordings.
 *
 * How depends on what the asset is (see `materials.ts`), and `raw` — the
 * default, and what every asset is when no classification is given — goes down
 * the one path every file went down before kinds existed:
 *
 * - a still is one event, over the slot it has on the capture timeline;
 * - a clip the user already trimmed is one event, whole, whether or not a shot
 *   detector ran — the fallback windows turned a seven-second clip into five
 *   seconds and two;
 * - a recording the user annotated `merge` as a whole is kept whole, which is
 *   what that annotation now means (it pointed at a boundary past the end of the
 *   file and did nothing);
 * - an edited video begins an event at every title card and cut to black, and
 *   the card belongs to what it introduces;
 * - anything else is atoms, long takes divided, merged by how much changes at
 *   each boundary.
 */
export function segmentAssets(
  assets: readonly MediaAsset[],
  observations: ObservationTimeline,
  annotations: readonly UserAnnotation[],
  options: SegmentationOptions = {},
  frameSimilarity?: SegmentContext['frameSimilarity'],
  placements: readonly AssetPlacement[] = [],
  materials: readonly Pick<MaterialProfile, 'asset_id' | 'kind'>[] = [],
): SegmentDraft[] {
  const settings = { ...DEFAULTS, ...options };
  const drafts: SegmentDraft[] = [];
  const offsets = new Map(placements.map((placement) => [placement.asset_id, placement.offset_ms]));
  const roles = textRoles(observations.ocr);

  for (const asset of [...assets].sort((a, b) => compareText(a.id, b.id))) {
    const kind = kindOf(materials, asset);
    const where = {
      assetId: asset.id,
      offsetMs: offsets.get(asset.id) ?? 0,
      durationMs: extentOf(asset),
    };
    const forcedSplits = forcedBoundaries(annotations, where, 'split');
    const context: SegmentContext = {
      utterances: observations.utterances,
      audioEvents: observations.audio_events,
      ...(frameSimilarity ? { frameSimilarity } : {}),
      forcedSplits,
      forcedMerges: forcedBoundaries(annotations, where, 'merge_with_next'),
    };

    if (asset.kind === 'image') {
      drafts.push(wholeDraft(asset, [], 'asset'));
      continue;
    }

    const keepWhole = keepsWhole(annotations, asset.id);
    if (keepWhole || isWholeKind(kind)) {
      if (asset.duration_ms <= 0) continue;
      const shotIds = observations.shots
        .filter((shot) => shot.asset_id === asset.id)
        .sort((a, b) => a.start_ms - b.start_ms || compareText(a.id, b.id))
        .map((shot) => shot.id);
      const whole = cutAt([wholeAtom(asset, shotIds)], forcedSplits);
      // One piece is the whole file, and whose decision that was is the method.
      // Pieces mean the user also split it, and the ordinary merging honours
      // those cuts and marks them as theirs.
      if (whole.length === 1) drafts.push(wholeDraft(asset, shotIds, keepWhole ? 'user' : 'asset'));
      else drafts.push(...segmentAtoms(whole, context, options));
      continue;
    }

    let atoms = buildAtoms(asset, observations.shots, options, forcedSplits);
    if (atoms.length === 0) continue;

    if (kind === 'edited') {
      // Only cards with something after them: an end card introduces nothing,
      // and is left to close the event it follows.
      const cards = titleCards(asset, observations, roles).filter(
        (card) => card.end_ms <= asset.duration_ms - settings.minEventMs,
      );
      if (cards.length > 0) {
        atoms = cutAt(
          atoms,
          cards.flatMap((card) => [card.start_ms, card.end_ms]),
        );
        context.cardStarts = cards.map((card) => card.start_ms);
        context.cardEnds = cards.map((card) => card.end_ms);
      }
    }

    const whole = atoms.length;
    atoms = subdivideLongAtoms(atoms, takeEvidence(asset.id, observations, roles), options);
    // Raw footage keeps first-wins, because its shot boundaries carry the
    // detector's score and rarely tie. The places a long take was divided carry
    // none, so they tie by construction, and first-wins merged them from the
    // front into 45-second events followed by a tail of 3-second ones.
    const divided = atoms.length > whole;
    drafts.push(
      ...segmentAtoms(atoms, context, {
        ...options,
        balancedTies: options.balancedTies ?? (kind !== 'raw' || divided),
      }),
    );
  }

  return drafts;
}

/** Kinds that are one event per file. */
function isWholeKind(kind: MaterialKind): boolean {
  return kind === 'clip' || kind === 'still';
}

/** How much of the capture timeline an asset occupies: a still has a slot. */
function extentOf(asset: MediaAsset): number {
  return asset.kind === 'image' ? STILL_SLOT_MS : asset.duration_ms;
}

function wholeAtom(asset: MediaAsset, shotIds: string[]): Atom {
  const end = extentOf(asset);
  return {
    asset_id: asset.id,
    start_ms: 0,
    end_ms: end,
    shot_ids: shotIds,
    representative_frame_ms: Math.floor(end / 3),
  };
}

function wholeDraft(asset: MediaAsset, shotIds: string[], method: SegmentMethod): SegmentDraft {
  return {
    asset_id: asset.id,
    start_ms: 0,
    end_ms: extentOf(asset),
    shot_ids: shotIds,
    method,
    // The first event of an asset starts where the asset does, which is as sure
    // as a boundary gets; the same number the merging gives every first event.
    boundary_confidence: 0.9,
  };
}

/**
 * Whether the user asked for a whole recording to be one moment.
 *
 * `oea annotate asset_001 merge` is advertised, and it was read as "merge the
 * boundary at the end of this file" — where events never meet, because they do
 * not straddle recordings — so it was accepted, reported, and did nothing.
 * Merging everything in one file into one event is the only thing it can mean.
 */
function keepsWhole(annotations: readonly UserAnnotation[], assetId: string): boolean {
  return annotations.some(
    (a) =>
      a.type === 'boundary' &&
      a.action === 'merge_with_next' &&
      a.anchor.length === 0 &&
      a.target.kind === 'asset' &&
      a.target.asset_id === assetId,
  );
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
      if (a.type !== 'boundary') return [];

      // An event id, resolved to the footage it named when the correction was
      // made. `oea annotate evt_0003 split 00:00:40` and `oea annotate evt_0003
      // merge` are both forms the CLI's own help advertises, and both were
      // dropped here: the annotation was written, reported as applied, listed
      // in the event's `annotation_refs`, and did nothing. Merging asks for the
      // boundary at the end of that material to go; splitting asks for one
      // inside it, at `at_ms`.
      const anchor = a.anchor.find((range) => range.asset_id === where.assetId);
      if (anchor) {
        if (action === 'merge_with_next') return [anchor.end_ms];
        if (a.at_ms === undefined) return [];
        const local = a.at_ms - where.offsetMs;
        return local > anchor.start_ms && local < anchor.end_ms ? [local] : [];
      }
      // An annotation anchored somewhere else is not about this asset.
      if (a.anchor.length > 0) return [];

      // A whole recording: splitting at a point inside it. Merging a whole
      // recording is not a boundary at all, and is read by `keepsWhole`.
      if (a.target.kind === 'asset') {
        if (a.target.asset_id !== where.assetId) return [];
        if (action === 'merge_with_next') return [];
        return a.at_ms === undefined ? [] : [a.at_ms - where.offsetMs];
      }

      if (a.target.kind !== 'time_range') return [];

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
