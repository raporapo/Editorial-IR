import { compareText, type MediaAsset, type ObservationTimeline } from '@editorial-ir/contracts';

/**
 * Where the footage is both still and silent, so the expensive stages need not
 * look there.
 *
 * ## What it is for, and the one thing it must never do
 *
 * Model spend scales with how much footage there is, and a lot of footage is
 * nothing: the camera left running on a table, a tripod on an empty car park, a
 * lens cap, a screen recording nobody is touching. Describing those with a
 * vision-language model, judging them with a language model, embedding and
 * reading every sampled frame of them, costs the same as describing the best
 * moment of the day.
 *
 * What this must never do is change a time value. It does not cut, trim or
 * re-encode anything. The media is untouched, event boundaries are decided before
 * this is consulted and without it, and a source range or a timecode in a plan is
 * the same number whether the mask was applied or not. It is a list of spans
 * beside the media, and the only thing it decides is where not to spend.
 *
 * ## Both conditions, never one
 *
 * Silence alone is not enough, and the measurement is unambiguous about it: on
 * the test footage here 65-73% of every file is silent, and a silent drone shot
 * is exactly the thing a travel edit is made of. Stillness alone is not enough
 * either: a person talking to a locked-off camera is still, and is the content.
 * Only the intersection — nothing moving *and* nothing to hear — is safe to
 * skip, and measured on real footage it is rare: zero seconds of any edited
 * programme, zero of people seated in conversation, and the empty stretches of a
 * traffic camera between cars.
 *
 * ## Unknown is not inactive
 *
 * An asset with no picture analysis has no static spans. An asset with an audio
 * track that was not analysed has no silent spans. Either way nothing is skipped:
 * a missing measurement costs tokens, it never costs a moment. The only case that
 * counts as silent without a measurement is a file that has no audio at all.
 */

/** A stretch of one asset, in asset time, that was both still and silent. */
export interface InactiveSpan {
  asset_id: string;
  start_ms: number;
  end_ms: number;
}

/**
 * Kept active at each edge of a span.
 *
 * Detection resolves to a sample, and the moments either side of a static
 * stretch are exactly where something starts or stops happening — the car
 * entering frame, the first word. Half a second each side keeps them in.
 */
export const INACTIVE_MARGIN_MS = 500;

/** Shorter than this after the margins, and a span is not worth the bookkeeping. */
export const MIN_INACTIVE_MS = 3000;

interface Interval {
  start: number;
  end: number;
}

function intersect(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  const left = [...a].sort((x, y) => x.start - y.start);
  const right = [...b].sort((x, y) => x.start - y.start);
  while (i < left.length && j < right.length) {
    const start = Math.max(left[i]!.start, right[j]!.start);
    const end = Math.min(left[i]!.end, right[j]!.end);
    if (end > start) out.push({ start, end });
    if (left[i]!.end < right[j]!.end) i++;
    else j++;
  }
  return out;
}

function subtract(from: readonly Interval[], remove: readonly Interval[]): Interval[] {
  let pieces = [...from];
  for (const cut of remove) {
    const next: Interval[] = [];
    for (const piece of pieces) {
      if (cut.end <= piece.start || cut.start >= piece.end) {
        next.push(piece);
        continue;
      }
      if (cut.start > piece.start) next.push({ start: piece.start, end: cut.start });
      if (cut.end < piece.end) next.push({ start: cut.end, end: piece.end });
    }
    pieces = next;
  }
  return pieces;
}

function merge(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const interval of sorted) {
    const last = out.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else out.push({ ...interval });
  }
  return out;
}

/**
 * Level below which a stretch is silent whatever the rest of the recording does.
 *
 * Silence events come from a threshold fitted to each recording, and a recording
 * with no dynamic range — a muted phone clip, a screen capture with no
 * microphone, digital silence from end to end — deliberately gets none: an
 * adaptive detector has nothing to fit. Those are exactly the files most worth
 * not paying for, so an absolute floor catches them. -60 dBFS is below the room
 * tone of any microphone that was actually listening; digital silence reads
 * -100.
 */
export const ABSOLUTE_SILENCE_DB = -60;

/**
 * Level a silence event must also be under to count here.
 *
 * Silence events are relative to their recording — quiet *for this file* — so
 * under a music bed the stretches between the narration read as silence while
 * the music plays on at -25 dBFS. For deciding where not to spend, "quiet for
 * this file" is not enough: a title card over music is a title card with a
 * soundtrack. Room tone sits well under -45; music, traffic and a crowd do not.
 */
export const QUIET_ENOUGH_DB = -45;

/** Kept as speech either side of a timed word: breath, and timing error. */
const WORD_PADDING_MS = 250;

/** Shortest run below a level that counts, matching the silence detector. */
const MIN_FLOOR_RUN_MS = 300;

function belowLevel(rmsDb: readonly number[], hopMs: number, levelDb: number): Interval[] {
  const out: Interval[] = [];
  let start = -1;
  for (let i = 0; i <= rmsDb.length; i++) {
    const quiet = i < rmsDb.length && rmsDb[i]! < levelDb;
    if (quiet && start < 0) start = i;
    if (!quiet && start >= 0) {
      if ((i - start) * hopMs >= MIN_FLOOR_RUN_MS)
        out.push({ start: start * hopMs, end: i * hopMs });
      start = -1;
    }
  }
  return out;
}

/** Whether the file carries sound at all, as far as ingest could tell. */
function hasAudioTrack(asset: MediaAsset): boolean {
  if (asset.kind === 'audio') return true;
  if (asset.audio_codec !== undefined) return true;
  return (asset.audio_streams?.length ?? 0) > 0;
}

/**
 * Where one asset is silent, by the one definition of silence this project has.
 *
 * Quiet for this recording *and* quiet in absolute terms (under
 * {@link QUIET_ENOUGH_DB}), or so quiet that no microphone was listening (under
 * {@link ABSOLUTE_SILENCE_DB}). A file with no audio track is silent end to end;
 * one whose sound was never analysed has no silence, because unknown is not
 * silent. A profile with no level envelope measured nothing, so the silence
 * events stand exactly as the detector reported them.
 *
 * Exported because three things ask where the silence is and they must not
 * disagree: the mask below, the planner snapping a cut to a quiet moment, and
 * the planner taking pauses out of speech. The planner used to read the
 * per-recording silence events directly, and under a music bed those fire in
 * every gap between the narration while the music plays on at -25 dBFS — a cut
 * "snapped to silence" there lands in the middle of a bar, and a pause "removed"
 * there chops the music.
 *
 * The mask states the same rule inline, in `inactiveCandidatesFor`, and a test
 * (`packages/core/test/silence.test.ts`) holds the two to each other: change
 * one and the test fails until the other agrees.
 *
 * Words are not subtracted here. The mask removes what the transcriber heard
 * with a margin of its own, and the pause remover never cuts inside a word; both
 * do so where they need it, so that this stays a statement about the sound
 * alone.
 */
export function silentSpans(
  observations: Pick<ObservationTimeline, 'audio_events' | 'audio_profiles'>,
  asset: MediaAsset,
): { start_ms: number; end_ms: number }[] {
  if (asset.kind === 'image') return [];
  if (!hasAudioTrack(asset)) return [{ start_ms: 0, end_ms: asset.duration_ms }];

  const profile = observations.audio_profiles.find((p) => p.asset_id === asset.id);
  const analysed =
    profile !== undefined || observations.audio_events.some((e) => e.asset_id === asset.id);
  if (!analysed) return [];
  const relative = merge(
    observations.audio_events
      .filter((e) => e.asset_id === asset.id && e.event_type === 'silence')
      .map((e) => ({ start: e.start_ms, end: e.end_ms })),
  );
  const silent =
    profile && profile.rms_db.length > 0
      ? merge([
          ...intersect(relative, belowLevel(profile.rms_db, profile.hop_ms, QUIET_ENOUGH_DB)),
          ...belowLevel(profile.rms_db, profile.hop_ms, ABSOLUTE_SILENCE_DB),
        ])
      : relative;
  return silent.map((s) => ({ start_ms: s.start, end_ms: s.end }));
}

/**
 * Every inactive span in the project.
 *
 * Deterministic and cheap: it is recomputed from observations on every compile
 * rather than stored, so a change to the thresholds never needs a re-analysis and
 * never leaves a stale mask behind.
 */
export function inactiveSpans(
  observations: ObservationTimeline,
  assets: readonly MediaAsset[],
  options: { marginMs?: number; minMs?: number } = {},
): InactiveSpan[] {
  const margin = options.marginMs ?? INACTIVE_MARGIN_MS;
  const minimum = options.minMs ?? MIN_INACTIVE_MS;
  const spans: InactiveSpan[] = [];

  for (const asset of assets) {
    const still = inactiveCandidatesFor(observations, asset);
    for (const interval of still) {
      const start = interval.start + margin;
      const end = interval.end - margin;
      if (end - start >= minimum) spans.push({ asset_id: asset.id, start_ms: start, end_ms: end });
    }
  }
  return spans.sort((a, b) => compareText(a.asset_id, b.asset_id) || a.start_ms - b.start_ms);
}

function inactiveCandidatesFor(observations: ObservationTimeline, asset: MediaAsset): Interval[] {
  const whole: Interval[] = [{ start: 0, end: asset.duration_ms }];
  if (asset.kind === 'image') return [];

  // The picture. An audio-only file has none, so there is nothing to see and
  // only the sound decides.
  let visuallyQuiet: Interval[];
  if (asset.kind === 'audio') {
    visuallyQuiet = whole;
  } else {
    const analysed = observations.motion_profiles.some((p) => p.asset_id === asset.id);
    // Only `static`. Black is recorded but is not by itself quiet: a city at night
    // is dark, and it is the ending. A black frame that is also still is static
    // anyway, because nothing in it changes.
    const quiet = observations.video_events
      .filter((e) => e.asset_id === asset.id && e.event_type === 'static')
      .map((e) => ({ start: e.start_ms, end: e.end_ms }));
    // No picture analysis at all: unknown, so not inactive.
    if (!analysed && quiet.length === 0) return [];
    visuallyQuiet = merge(quiet);
  }

  // The sound. A file with no audio track is silent by construction; one whose
  // audio was never analysed is unknown, and unknown is not silent.
  let silent: Interval[];
  if (!hasAudioTrack(asset)) {
    silent = whole;
  } else {
    const profile = observations.audio_profiles.find((p) => p.asset_id === asset.id);
    const analysed =
      profile !== undefined || observations.audio_events.some((e) => e.asset_id === asset.id);
    if (!analysed) return [];
    const relative = merge(
      observations.audio_events
        .filter((e) => e.asset_id === asset.id && e.event_type === 'silence')
        .map((e) => ({ start: e.start_ms, end: e.end_ms })),
    );
    // A profile with no hops measured no level, so the events stand alone.
    silent =
      profile && profile.rms_db.length > 0
        ? merge([
            ...intersect(relative, belowLevel(profile.rms_db, profile.hop_ms, QUIET_ENOUGH_DB)),
            ...belowLevel(profile.rms_db, profile.hop_ms, ABSOLUTE_SILENCE_DB),
          ])
        : relative;
  }

  // Words the transcriber heard override a silence the level meter reported: a
  // whisper under a loud fan is speech, and the transcript is the better witness.
  //
  // The words, not the utterance, where there are word timings. A transcriber
  // with voice-activity filtering can return one utterance spanning the silence
  // it removed — measured, 8.4 s to 91.0 s around eighty seconds of digital
  // silence, while its own words put the pause between 10.1 s and 90.0 s.
  const spoken = observations.utterances
    .filter((u) => u.asset_id === asset.id)
    .flatMap((u) =>
      u.words && u.words.length > 0
        ? u.words.map((w) => ({
            start: w.start_ms - WORD_PADDING_MS,
            end: w.end_ms + WORD_PADDING_MS,
          }))
        : [{ start: u.start_ms, end: u.end_ms }],
    );

  return merge(subtract(intersect(visuallyQuiet, silent), spoken));
}

/** How much of `[start, end)` of one asset lies inside inactive spans. */
export function inactiveMsWithin(
  spans: readonly InactiveSpan[],
  assetId: string,
  start: number,
  end: number,
): number {
  let total = 0;
  for (const span of spans) {
    if (span.asset_id !== assetId) continue;
    const overlap = Math.min(end, span.end_ms) - Math.max(start, span.start_ms);
    if (overlap > 0) total += overlap;
  }
  return total;
}

/** Whether one moment of one asset is inside an inactive span. */
export function isInactive(spans: readonly InactiveSpan[], assetId: string, at: number): boolean {
  return spans.some((s) => s.asset_id === assetId && at >= s.start_ms && at < s.end_ms);
}

/**
 * Timestamps to analyse, with those inside inactive spans thinned to one each.
 *
 * One rather than none, because an inactive span is still part of the footage:
 * the IR should know what the empty car park looked like, and a search for "car
 * park" should be able to find it. It needs one look, not forty.
 */
export function thinTimestamps(
  timestamps: readonly number[],
  spans: readonly InactiveSpan[],
  assetId: string,
): { kept: number[]; dropped: number } {
  const mine = spans.filter((s) => s.asset_id === assetId);
  if (mine.length === 0) return { kept: [...timestamps], dropped: 0 };

  const represented = new Set<InactiveSpan>();
  const kept: number[] = [];
  let dropped = 0;
  for (const t of [...timestamps].sort((a, b) => a - b)) {
    const span = mine.find((s) => t >= s.start_ms && t < s.end_ms);
    if (!span) {
      kept.push(t);
      continue;
    }
    if (represented.has(span)) {
      dropped++;
      continue;
    }
    represented.add(span);
    kept.push(t);
  }
  return { kept, dropped };
}

/**
 * Active time an event may keep and still count as quiet as a whole.
 *
 * The margins alone take a second off every span, so an event that is exactly
 * one still, silent stretch is never 100% inactive. Beyond the margins, half a
 * second more is allowed and no more: anything longer that moves or makes a
 * sound is something a model should look at.
 */
export const QUIET_ACTIVE_ALLOWANCE_MS = 2 * INACTIVE_MARGIN_MS + 500;

/**
 * Whether a stretch of one asset is quiet enough that no model need be asked
 * about it: long enough to have been measured, and still and silent throughout
 * but for its edges.
 */
export function isQuietRange(
  spans: readonly InactiveSpan[],
  assetId: string,
  start: number,
  end: number,
): boolean {
  const duration = end - start;
  if (duration < MIN_INACTIVE_MS) return false;
  const inactive = inactiveMsWithin(spans, assetId, start, end);
  return inactive > 0 && duration - inactive <= QUIET_ACTIVE_ALLOWANCE_MS;
}

/** Total inactive time, for the report. */
export function totalInactiveMs(spans: readonly InactiveSpan[]): number {
  return spans.reduce((sum, s) => sum + (s.end_ms - s.start_ms), 0);
}
