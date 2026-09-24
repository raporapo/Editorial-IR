import {
  STATIC_MOTION_THRESHOLD,
  compareText,
  overlapMs,
  type MaterialKind,
  type MaterialProfile,
  type MediaAsset,
  type ObservationTimeline,
  type ProjectContext,
  type Shot,
} from '@editorial-ir/contracts';
import { ABSOLUTE_SILENCE_DB } from './activity.js';
import { textRoles, type TextRole } from './onscreen-text.js';

/**
 * What kind of material each file is.
 *
 * The rules that turn a camera's raw recording into events are the wrong rules
 * for everything else a person drops into a folder. Fed an edited programme,
 * they merged thirteen of its cuts into a 34-second first event and left the
 * rest as single shots, buried its second title card in the middle of an event,
 * and named the chapter after a counter burned into the test pattern. Fed a
 * folder of eight clips the user had already trimmed, they found every clip a
 * duplicate of every other and kept two. Fed four photographs beside a video,
 * they dropped the photographs. None of that was a bug in the raw-footage rules;
 * it was the raw-footage rules applied to material they were not written for.
 *
 * So each asset is classified once, after observation and before segmentation,
 * from what was measured — cuts, silence, black, stillness, text — and the kind
 * decides which rules apply. The classification is an inference and is recorded
 * as one, with its evidence in words and its numbers beside them; the user's own
 * word in `background.materials` always wins.
 *
 * `raw` is the default and goes down exactly the path every file went down before
 * this existed. The worked example's three recordings classify `raw`.
 */

/**
 * Cuts a minute at and above which a file reads as edited.
 *
 * Measured with this project's own shot detector: the edited programmes cut 5.0
 * (a short film) to 16.1 (a music video) times a minute, and the synthetic edited
 * programme in the probes 20; unedited camera files cut 0 to 0.8 times a minute,
 * and a real drone flight 0.23. Three sits in the empty stretch between.
 */
export const EDITED_MIN_CUTS_PER_MIN = 3;

/**
 * The longest median shot an edited file may have.
 *
 * The cut rate alone is not enough, and the worked example is why: handheld
 * footage of a day out, with the detector firing on whip pans and people walking
 * past the lens, cuts 3.4 to 4.1 times a minute — inside the gap above — but its
 * median shot is 14 to 17 seconds, because the "cuts" are short interruptions of
 * long takes. The edited programmes measured had medians of 1.7 to 8.4 seconds.
 * Eleven sits between the two.
 */
export const EDITED_MAX_MEDIAN_SHOT_MS = 11_000;

/**
 * Less material than this and a cut rate means nothing.
 *
 * Two cuts in twenty seconds is six a minute and could be one camera stopping and
 * starting twice.
 */
export const EDITED_MIN_DURATION_MS = 30_000;

/**
 * The longest a file can be and still be read as a clip the user already chose.
 *
 * Phone clips and social cuts that people keep whole run a few seconds to a
 * quarter of a minute; the probe's folder of pre-trimmed clips ran 3 to 8
 * seconds.
 */
export const CLIP_MAX_MS = 15_000;

/**
 * Detections this close together are one moving stretch, not several cuts.
 *
 * On fast-changing content the detector fires at its 800 ms minimum again and
 * again: an 8-second clip came back as ten 0.8-second shots, and a real cut in
 * the edited probe was lost among four such slices. Folding them into their
 * neighbour before counting keeps a busy clip a clip.
 */
export const BURST_SHOT_MS = 1000;

/**
 * The longest a title card is held.
 *
 * The cards in the edited probe were 1.5 seconds; a card is held as long as it
 * takes to read, and rarely more than five.
 */
export const TITLE_CARD_MAX_MS = 6000;

/**
 * Mean brightness, 0-255, under which a still shot is a card.
 *
 * White titles on black measured 4.1 and 5.4 in the edited probe; the darkest
 * moving shot in the same programme was 26.6. The black detector cannot see
 * these, because it asks that nearly all of the frame be dark and the title's
 * letters are not.
 */
export const CARD_MAX_MEAN_LUMA = 20;

/**
 * Text lines in one read at which a picture is a page of text rather than a scene.
 *
 * The settings screen in the screen-recording probe read as nine lines from one
 * frame; every read in the worked example, and the scene text of the edited
 * probe, is one line — a sign, a title card.
 */
const TEXT_HEAVY_LINES_PER_READ = 4;

/**
 * Words in a file name that say it is a screen recording.
 *
 * What macOS (`Screen Recording …`, `画面収録 …`), iOS (`ScreenRecording_…`),
 * OBS and Windows (`キャプチャ`) name their files, and what people call the ones
 * they make.
 */
const SCREEN_NAME =
  /(^|[^a-z])(screen|capture|screencast)|(^|[^a-z])obs([^a-z]|$)|画面収録|キャプチャ/i;

/** A span of an asset, in asset time. */
export interface Span {
  start_ms: number;
  end_ms: number;
}

/** The kind to assume when nothing classified the asset: what the file itself says. */
export function defaultKind(asset: MediaAsset): MaterialKind {
  if (asset.kind === 'image') return 'still';
  if (asset.kind === 'audio') return 'audio_only';
  return 'raw';
}

/** The kind decided for an asset, or what the file itself says when none was. */
export function kindOf(
  materials: readonly Pick<MaterialProfile, 'asset_id' | 'kind'>[],
  asset: MediaAsset,
): MaterialKind {
  return materials.find((profile) => profile.asset_id === asset.id)?.kind ?? defaultKind(asset);
}

/**
 * The shots of one asset with detector bursts folded away.
 *
 * A run of shots shorter than {@link BURST_SHOT_MS} joins the shot before it
 * (the one after, at the very start), so a stretch the detector stuttered over
 * counts once.
 */
export function steadyShots(assetId: string, shots: readonly Shot[]): Span[] {
  const own = shots
    .filter((shot) => shot.asset_id === assetId)
    .sort((a, b) => a.start_ms - b.start_ms || compareText(a.id, b.id));
  const out: Span[] = [];
  let pending: Span | undefined;
  for (const shot of own) {
    const span = { start_ms: shot.start_ms, end_ms: shot.end_ms };
    if (span.end_ms - span.start_ms < BURST_SHOT_MS) {
      const last = out.at(-1);
      if (last) last.end_ms = Math.max(last.end_ms, span.end_ms);
      else pending = pending ? { ...pending, end_ms: span.end_ms } : span;
      continue;
    }
    if (pending) {
      span.start_ms = Math.min(span.start_ms, pending.start_ms);
      pending = undefined;
    }
    out.push(span);
  }
  if (pending) out.push(pending);
  return out;
}

/**
 * Title cards and cuts to black inside an asset.
 *
 * A card is a black span the picture analysis reported, or a shot no longer than
 * {@link TITLE_CARD_MAX_MS} that holds perfectly still and is either dark or
 * carries text in the middle of the frame. Stillness is required because a dark
 * or captioned shot that moves is a scene; it is measured on the motion
 * envelope, skipping the first sample of the shot, which compares across the cut.
 * With no picture analysis there is no stillness to measure and nothing is
 * called a card — unknown is not a card.
 */
export function titleCards(
  asset: MediaAsset,
  observations: ObservationTimeline,
  roles: ReadonlyMap<string, TextRole> = textRoles(observations.ocr),
): Span[] {
  const spans: Span[] = observations.video_events
    .filter((event) => event.asset_id === asset.id && event.event_type === 'black')
    .map((event) => ({ start_ms: event.start_ms, end_ms: event.end_ms }));

  const profile = observations.motion_profiles.find((p) => p.asset_id === asset.id);
  if (profile) {
    const centred = observations.ocr.filter(
      (read) =>
        read.asset_id === asset.id &&
        roles.get(read.id) === 'scene' &&
        read.bbox !== undefined &&
        Math.abs(read.bbox[1] + read.bbox[3] / 2 - 0.5) <= 0.25,
    );
    for (const shot of observations.shots) {
      if (shot.asset_id !== asset.id) continue;
      const length = shot.end_ms - shot.start_ms;
      if (length > TITLE_CARD_MAX_MS) continue;

      // Sample i is taken at i x hop and compared with the one before it, so the
      // first sample of a shot compares it with the shot before and is skipped.
      const samples: { motion: number; luma: number }[] = [];
      const first = Math.ceil((shot.start_ms + profile.hop_ms) / profile.hop_ms);
      const last = Math.min(profile.motion.length, Math.ceil(shot.end_ms / profile.hop_ms));
      for (let i = first; i < last; i++) {
        samples.push({ motion: profile.motion[i]!, luma: profile.luma[i] ?? 0 });
      }
      if (samples.length < 2) continue;
      if (samples.some((sample) => sample.motion > STATIC_MOTION_THRESHOLD)) continue;

      const meanLuma = samples.reduce((sum, s) => sum + s.luma, 0) / samples.length;
      const titled = centred.some(
        (read) => read.start_ms >= shot.start_ms && read.start_ms < shot.end_ms,
      );
      if (meanLuma <= CARD_MAX_MEAN_LUMA || titled) {
        spans.push({ start_ms: shot.start_ms, end_ms: shot.end_ms });
      }
    }
  }

  // Overlapping and touching spans are one card: a fade to black and the title
  // that comes up out of it.
  const merged: Span[] = [];
  for (const span of spans.sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms)) {
    const last = merged.at(-1);
    if (last && span.start_ms <= last.end_ms) last.end_ms = Math.max(last.end_ms, span.end_ms);
    else merged.push({ ...span });
  }
  return merged;
}

/**
 * Classifies every asset.
 *
 * Runs on fresh and on reused observations alike, because it reads nothing but
 * the observations and the assets: a reused analysis gets exactly the kinds a
 * fresh one would, and a change to these rules never needs a re-analysis.
 */
export function classifyMaterials(
  assets: readonly MediaAsset[],
  observations: ObservationTimeline,
  context?: Pick<ProjectContext, 'background'>,
): MaterialProfile[] {
  const roles = textRoles(observations.ocr);
  const overrides = context?.background.materials ?? {};
  return [...assets]
    .sort((a, b) => compareText(a.id, b.id))
    .map((asset) => {
      const signals = measure(asset, observations, roles);
      // Own keys only: a file called `constructor` or `toString` would
      // otherwise find a function on every object and call it a kind.
      const override = Object.hasOwn(overrides, asset.id)
        ? overrides[asset.id]
        : Object.hasOwn(overrides, asset.file_name)
          ? overrides[asset.file_name]
          : undefined;
      if (override !== undefined) {
        return {
          asset_id: asset.id,
          kind: override,
          confidence: 1,
          provenance: 'user_provided' as const,
          evidence: ['set in context.yaml under background.materials'],
          signals,
        };
      }
      const decided = decide(asset, signals);
      return {
        asset_id: asset.id,
        kind: decided.kind,
        confidence: decided.confidence,
        provenance: 'inferred' as const,
        evidence: decided.evidence,
        signals,
      };
    });
}

function measure(
  asset: MediaAsset,
  observations: ObservationTimeline,
  roles: ReadonlyMap<string, TextRole>,
): Record<string, number> {
  const duration = asset.duration_ms;
  const signals: Record<string, number> = {
    duration_ms: duration,
    has_audio: hasAudio(asset) ? 1 : 0,
    variable_frame_rate: asset.variable_frame_rate === true ? 1 : 0,
  };
  if (asset.kind === 'image' || duration <= 0) return signals;
  const whole = { start_ms: 0, end_ms: duration };
  const minutes = duration / 60_000;

  // Cuts, only when a detector looked: no shots at all is "not measured", which
  // is not the same as "no cuts".
  const steady = steadyShots(asset.id, observations.shots);
  if (steady.length > 0) {
    const cuts = steady.length - 1;
    const lengths = steady.map((s) => s.end_ms - s.start_ms).sort((a, b) => a - b);
    signals.cuts = cuts;
    signals.cut_rate_per_min = round2(cuts / minutes);
    signals.median_shot_ms = lengths[Math.floor(lengths.length / 2)]!;
  }

  const utterances = observations.utterances.filter((u) => u.asset_id === asset.id);
  const speechMs =
    utterances.length > 0
      ? utterances.reduce((sum, u) => sum + overlapMs(u, whole), 0)
      : observations.audio_events
          .filter((e) => e.asset_id === asset.id && e.event_type === 'speech')
          .reduce((sum, e) => sum + overlapMs(e, whole), 0);
  const audioProfile = observations.audio_profiles.find((p) => p.asset_id === asset.id);
  if (utterances.length > 0 || audioProfile)
    signals.speech_ratio = round3(Math.min(1, speechMs / duration));
  if (audioProfile && audioProfile.rms_db.length > 0) {
    const silent = audioProfile.rms_db.filter((db) => db < ABSOLUTE_SILENCE_DB).length;
    signals.silence_ratio = round3(silent / audioProfile.rms_db.length);
  }

  const videoEvents = observations.video_events.filter((e) => e.asset_id === asset.id);
  if (observations.motion_profiles.some((p) => p.asset_id === asset.id)) {
    signals.black_ms = videoEvents
      .filter((e) => e.event_type === 'black')
      .reduce((sum, e) => sum + e.end_ms - e.start_ms, 0);
    signals.static_ratio = round3(
      videoEvents
        .filter((e) => e.event_type === 'static')
        .reduce((sum, e) => sum + overlapMs(e, whole), 0) / duration,
    );
    signals.title_cards = innerCards(asset, observations, roles).length;
  }

  const reads = observations.ocr.filter(
    (r) => r.asset_id === asset.id && roles.get(r.id) !== 'junk',
  );
  if (reads.length > 0) {
    const moments = new Set(reads.map((r) => r.start_ms));
    const subtitles = reads.filter((r) => roles.get(r.id) === 'subtitle');
    signals.subtitle_reads = new Set(subtitles.map((r) => r.start_ms)).size;
    signals.subtitle_share = round3(subtitles.length / reads.length);
    signals.text_lines_per_read = round2(
      reads.filter((r) => roles.get(r.id) === 'scene').length / moments.size,
    );
  }
  return signals;
}

/** Cards with material after them: an end card introduces nothing. */
function innerCards(
  asset: MediaAsset,
  observations: ObservationTimeline,
  roles: ReadonlyMap<string, TextRole>,
): Span[] {
  return titleCards(asset, observations, roles).filter(
    (card) => card.start_ms > 0 && card.end_ms < asset.duration_ms,
  );
}

function decide(
  asset: MediaAsset,
  signals: Record<string, number>,
): { kind: MaterialKind; confidence: number; evidence: string[] } {
  if (asset.kind === 'image') {
    return { kind: 'still', confidence: 1, evidence: ['a still image'] };
  }
  if (asset.kind === 'audio' || (asset.video_codec === undefined && asset.width === undefined)) {
    return {
      kind: 'audio_only',
      confidence: 1,
      evidence: [asset.kind === 'audio' ? 'an audio file' : 'the file has no picture'],
    };
  }

  const seconds = (ms: number): string => `${Math.round(ms / 100) / 10} s`;
  const duration = signals.duration_ms ?? 0;
  const rate = signals.cut_rate_per_min;
  const median = signals.median_shot_ms;
  const cuts = signals.cuts;

  if (SCREEN_NAME.test(stem(asset.file_name))) {
    return {
      kind: 'screen_recording',
      confidence: 0.8,
      evidence: [`the file name says so ("${asset.file_name}")`],
    };
  }
  if (
    signals.variable_frame_rate === 1 &&
    (signals.static_ratio ?? 0) >= 0.5 &&
    (signals.text_lines_per_read ?? 0) >= TEXT_HEAVY_LINES_PER_READ
  ) {
    return {
      kind: 'screen_recording',
      confidence: 0.6,
      evidence: [
        'a variable frame rate, as screen recorders write',
        `still for ${Math.round((signals.static_ratio ?? 0) * 100)}% of its length`,
        `${signals.text_lines_per_read} lines of text in each frame read`,
      ],
    };
  }

  if (
    duration >= EDITED_MIN_DURATION_MS &&
    rate !== undefined &&
    median !== undefined &&
    rate >= EDITED_MIN_CUTS_PER_MIN &&
    median <= EDITED_MAX_MEDIAN_SHOT_MS
  ) {
    return {
      kind: 'edited',
      // Past five a minute is inside the range every edited programme measured
      // fell in; between three and five is the gap where the two could meet.
      confidence: rate >= 5 ? 0.9 : 0.7,
      evidence: [
        `${rate} cuts a minute over ${seconds(duration)}, where camera footage cuts under one`,
        `half its shots are ${seconds(median)} or shorter`,
      ],
    };
  }
  if (
    duration >= EDITED_MIN_DURATION_MS &&
    (signals.title_cards ?? 0) > 0 &&
    (signals.subtitle_reads ?? 0) > 0
  ) {
    return {
      kind: 'edited',
      confidence: 0.7,
      evidence: [
        `${signals.title_cards} title card(s) or cuts to black between its sections`,
        'subtitles burned into the picture',
      ],
    };
  }

  if (duration > 0 && duration <= CLIP_MAX_MS && (cuts ?? 0) <= 1) {
    return {
      kind: 'clip',
      confidence: 0.7,
      evidence: [
        `${seconds(duration)} long with ${cuts === undefined ? 'no cut measured' : cuts === 0 ? 'no cut' : 'one cut'} inside: already trimmed`,
      ],
    };
  }

  return {
    kind: 'raw',
    confidence: rate !== undefined && rate <= 0.8 ? 0.8 : 0.6,
    evidence:
      rate === undefined
        ? ['nothing measured suggests an edit']
        : [`${rate} cuts a minute, and half its shots run ${seconds(median ?? 0)} or longer`],
  };
}

function hasAudio(asset: MediaAsset): boolean {
  if (asset.kind === 'audio') return true;
  if (asset.audio_codec !== undefined) return true;
  return (asset.audio_streams?.length ?? 0) > 0;
}

function stem(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
