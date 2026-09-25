import {
  compareText,
  type AudioCompanion,
  type AudioSync,
  type ObservationTimeline,
  type Utterance,
} from '@editorial-ir/contracts';

/**
 * Where two recordings of the same moment line up, from their sound.
 *
 * A camera and a separate audio recorder, or two cameras, running at once. Their
 * clocks cannot be trusted to agree — a camera on local time and a phone on UTC
 * differ by hours, and a recorder has no clock worth reading at all — but they
 * heard the same room. A door closing, a laugh, the first word of a sentence
 * arrive at both microphones within a few milliseconds of each other, whatever
 * each device thought the time was.
 *
 * ## What is compared
 *
 * Not the waveforms: two microphones a few metres apart record different
 * waveforms of the same sound (different distance, different response,
 * different room reflections), and a lavalier under a shirt sounds nothing like a
 * camera's built-in pair. What survives both is *when things start*: the onset
 * envelope, the rise in loudness from one 10 ms hop to the next. Both
 * recordings are reduced to that, normalised, and cross-correlated; the lag with
 * the strongest agreement is the offset, refined below one hop by fitting a
 * parabola through the peak.
 *
 * ## When not to believe it
 *
 * A correlation always has a maximum, including between two recordings of
 * different days. The confidence is how far the peak stands above everything
 * else the correlation found — its height over the best rival alignment — and a
 * pairing below {@link MIN_PEAK_RATIO} is reported as no match, never as a
 * guess. Silence carries no information, so a recording with
 * nothing in it is never matched either.
 *
 * Nothing here touches a file; it works on the loudness envelope the audio
 * analysis already produces for every recording, so a sync costs a fraction of a
 * second and needs no model.
 */

/** Hop of the envelopes compared, in milliseconds. */
export const SYNC_HOP_MS = 10;

/**
 * How much higher the best alignment must score than the best alignment
 * anywhere else (half a second or more away from it).
 *
 * A correlation always has a maximum, so the question is whether it stands
 * alone. Measured on pairs made with ffmpeg — the same speech as a "camera"
 * (pink noise) and a "recorder" started 3.217 s later (band-limited to
 * 300-3000 Hz, its own brown noise): found at 3215-3220 ms with the best peak
 * 2.4 times the runner-up; with the recorder's noise raised to about -10 dB,
 * 2.8; 8 s and 4 s excerpts, exact to the hop at 6.9 and 3.0. Unrelated
 * recordings — another speaker, the same synthetic voice reading similar
 * sentences, and synthetic scenes built to have the same statistics — gave
 * 1.04-1.13. The z-score of the peak was tried first and does not separate them:
 * unrelated synthetic scenes reached 9.8 standard deviations, above a real
 * match's 14 only by luck of the material.
 */
export const MIN_PEAK_RATIO = 1.5;

export interface SyncEstimate {
  /**
   * Where the second recording's time zero falls in the first recording's
   * time, in milliseconds. Negative when the second one started first.
   */
  offset_ms: number;
  /** The best peak divided by the best elsewhere: how alone it stands. */
  score: number;
  /** The score mapped into [0,1] for the contract: 0 below the threshold. */
  confidence: number;
}

/**
 * The onset strength of a loudness envelope: how much louder each hop is than
 * the one before, never negative.
 *
 * Decays and steady tones contribute nothing, which is the point — a hum both
 * microphones hear throughout would otherwise correlate at every lag.
 */
export function onsetEnvelope(rmsDb: readonly number[]): Float64Array {
  const out = new Float64Array(rmsDb.length);
  for (let i = 1; i < rmsDb.length; i++) {
    // Digital silence is -100 dB; the first hop of sound after it would be a
    // 60 dB "onset" that says nothing about when a sound started in the room.
    const previous = Math.max(rmsDb[i - 1]!, -70);
    const current = Math.max(rmsDb[i]!, -70);
    out[i] = Math.max(0, current - previous);
  }
  return out;
}

/**
 * The offset between two recordings from their loudness envelopes at the same
 * hop, searching lags up to `maxLagMs` either way.
 *
 * Returns undefined when either recording has nothing to match on, or when no
 * lag stands out: two recordings that do not share a moment.
 */
export function estimateOffset(
  aRmsDb: readonly number[],
  bRmsDb: readonly number[],
  hopMs: number,
  maxLagMs: number,
): SyncEstimate | undefined {
  const a = normalise(onsetEnvelope(aRmsDb));
  const b = normalise(onsetEnvelope(bRmsDb));
  if (!a || !b) return undefined;

  const maxLag = Math.max(1, Math.round(maxLagMs / hopMs));
  // correlation[lag] = sum over t of a[t + lag] * b[t]: how well b, moved to
  // start `lag` hops into a, agrees with a.
  const correlation = crossCorrelation(a, b, maxLag);
  const lags = correlation.length;

  let best = 0;
  for (let i = 1; i < lags; i++) if (correlation[i]! > correlation[best]!) best = i;

  // The runner-up: the best alignment at least half a second from the winner.
  // Closer than that is the same alignment seen through the envelope's own
  // width, not a rival.
  const exclusion = Math.max(2, Math.round(500 / hopMs));
  let runnerUp = -Infinity;
  for (let i = 0; i < lags; i++) {
    if (Math.abs(i - best) > exclusion && correlation[i]! > runnerUp) runnerUp = correlation[i]!;
  }
  if (!(correlation[best]! > 0) || !(runnerUp > 0)) return undefined;
  const score = correlation[best]! / runnerUp;

  // A parabola through the peak and its neighbours puts the offset between
  // hops: a 10 ms hop alone would leave up to 5 ms of error, a sixth of a frame.
  let fraction = 0;
  if (best > 0 && best < lags - 1) {
    const left = correlation[best - 1]!;
    const centre = correlation[best]!;
    const right = correlation[best + 1]!;
    const denominator = left - 2 * centre + right;
    if (denominator < 0) fraction = (0.5 * (left - right)) / denominator;
  }

  const lagHops = best - maxLag + fraction;
  return {
    offset_ms: Math.round(lagHops * hopMs),
    score: Math.round(score * 100) / 100,
    // 1.5 is the threshold and a ratio of 4 is as sure as this measure gets.
    confidence:
      score < MIN_PEAK_RATIO
        ? 0
        : Math.round(Math.min(1, 0.5 + (score - MIN_PEAK_RATIO) / 5) * 1000) / 1000,
  };
}

/** Zero mean, unit variance; undefined for a signal with nothing in it. */
function normalise(signal: Float64Array): Float64Array | undefined {
  let sum = 0;
  for (const v of signal) sum += v;
  const mean = signal.length === 0 ? 0 : sum / signal.length;
  let variance = 0;
  for (const v of signal) variance += (v - mean) ** 2;
  if (signal.length === 0 || variance === 0) return undefined;
  const scale = 1 / Math.sqrt(variance);
  return signal.map((v) => (v - mean) * scale);
}

/**
 * Cross-correlation at every lag in [-maxLag, maxLag], by FFT.
 *
 * Index `i` is lag `i - maxLag`. Direct summation is O(n·lags), which for two
 * hours at 10 ms and a search of an hour either way is 2.6e11 multiplications;
 * the FFT does the same in well under a second.
 */
export function crossCorrelation(a: Float64Array, b: Float64Array, maxLag: number): Float64Array {
  const size = nextPowerOfTwo(a.length + b.length + 1);
  const ar = new Float64Array(size);
  const ai = new Float64Array(size);
  const br = new Float64Array(size);
  const bi = new Float64Array(size);
  ar.set(a);
  br.set(b);
  fft(ar, ai, false);
  fft(br, bi, false);
  // A · conj(B), whose inverse is sum over t of a[t + lag] * b[t].
  for (let k = 0; k < size; k++) {
    const re = ar[k]! * br[k]! + ai[k]! * bi[k]!;
    const im = ai[k]! * br[k]! - ar[k]! * bi[k]!;
    ar[k] = re;
    ai[k] = im;
  }
  fft(ar, ai, true);

  const out = new Float64Array(2 * maxLag + 1);
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const index = lag >= 0 ? lag : size + lag;
    out[lag + maxLag] = index >= 0 && index < size ? ar[index]! : 0;
  }
  return out;
}

function nextPowerOfTwo(n: number): number {
  let size = 1;
  while (size < n) size <<= 1;
  return size;
}

/** In-place iterative radix-2 FFT; `inverse` scales by 1/n. */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let length = 2; length <= n; length <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / length;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let start = 0; start < n; start += length) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < length / 2; k++) {
        const ur = re[start + k]!;
        const ui = im[start + k]!;
        const xr = re[start + k + length / 2]!;
        const xi = im[start + k + length / 2]!;
        const vr = xr * cr - xi * ci;
        const vi = xr * ci + xi * cr;
        re[start + k] = ur + vr;
        im[start + k] = ui + vi;
        re[start + k + length / 2] = ur - vr;
        im[start + k + length / 2] = ui - vi;
        const nextCr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nextCr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] = re[i]! / n;
      im[i] = im[i]! / n;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Which recordings to compare, and the result as an observation               */
/* -------------------------------------------------------------------------- */

/**
 * Part of every cache key and of the observations fingerprint. Change it when a
 * change here would find a different offset.
 */
export const SYNC_VERSION = '1';

/**
 * Most pairs compared in one project.
 *
 * Every audio-only file against every video is quadratic, and a folder of two
 * hundred phone clips with one recorder is two hundred comparisons, each well
 * under a second; a project with forty recorders is not a shoot this is for.
 * What was not compared is reported, never dropped silently.
 */
export const MAX_SYNC_PAIRS = 400;

export interface SyncCandidate {
  asset_id: string;
  kind: 'video' | 'audio' | 'image';
  duration_ms: number;
  creation_time?: string;
  hasAudio: boolean;
}

/**
 * The pairs worth comparing, as [asset, reference].
 *
 * - Every audio-only recording against every video with sound: a recorder has
 *   no clock worth reading, and its whole purpose is to be the sound of some
 *   picture.
 * - Two videos only when their capture times overlap (with a minute of slack
 *   for clocks that disagree): two cameras of one moment. Without both times
 *   there is no reason to think they overlap, and comparing every pair of a
 *   hundred-clip folder would find nothing at great length.
 *
 * Ordered by id so the result, and what a cap leaves out, are the same on
 * every run.
 */
export function syncPairs(
  assets: readonly SyncCandidate[],
  cap = MAX_SYNC_PAIRS,
): { pairs: [string, string][]; skipped: number } {
  const sorted = [...assets]
    .filter((a) => a.hasAudio)
    .sort((a, b) => compareText(a.asset_id, b.asset_id));
  const videos = sorted.filter((a) => a.kind === 'video');
  const recorders = sorted.filter((a) => a.kind === 'audio');
  const all: [string, string][] = [];
  for (const recorder of recorders) {
    for (const video of videos) all.push([recorder.asset_id, video.asset_id]);
  }
  for (let i = 0; i < videos.length; i++) {
    for (let j = i + 1; j < videos.length; j++) {
      if (captureOverlaps(videos[i]!, videos[j]!))
        all.push([videos[j]!.asset_id, videos[i]!.asset_id]);
    }
  }
  return { pairs: all.slice(0, cap), skipped: Math.max(0, all.length - cap) };
}

function captureOverlaps(a: SyncCandidate, b: SyncCandidate): boolean {
  if (!a.creation_time || !b.creation_time) return false;
  const slack = 60_000;
  const aStart = Date.parse(a.creation_time);
  const bStart = Date.parse(b.creation_time);
  if (!Number.isFinite(aStart) || !Number.isFinite(bStart)) return false;
  return aStart - slack < bStart + b.duration_ms && bStart - slack < aStart + a.duration_ms;
}

/**
 * The offset of `asset` in `reference`'s time, if the two heard the same
 * moment, from their loudness envelopes at {@link SYNC_HOP_MS}.
 *
 * The search covers every lag at which the two could overlap at all, so an
 * hour-long recorder finds a two-minute clip wherever in it the clip fell.
 */
export function measureSync(
  assetRmsDb: readonly number[],
  referenceRmsDb: readonly number[],
): { offset_ms: number; score: number; confidence: number } | undefined {
  const maxLagMs = (assetRmsDb.length + referenceRmsDb.length) * SYNC_HOP_MS;
  const estimate = estimateOffset(referenceRmsDb, assetRmsDb, SYNC_HOP_MS, maxLagMs);
  if (!estimate || estimate.confidence === 0) return undefined;
  // Where the two do not overlap by at least a second, the alignment is an
  // artefact of the search reaching past both ends.
  const assetMs = assetRmsDb.length * SYNC_HOP_MS;
  const referenceMs = referenceRmsDb.length * SYNC_HOP_MS;
  const overlap =
    Math.min(referenceMs, estimate.offset_ms + assetMs) - Math.max(0, estimate.offset_ms);
  if (overlap < 1000) return undefined;
  return estimate;
}

/* -------------------------------------------------------------------------- */
/* A recorder as the sound of a video                                          */
/* -------------------------------------------------------------------------- */

/**
 * Share of a video the recorder must cover to be its sound.
 *
 * Below half, most of the clip would still play the camera's own microphone,
 * and a cut that switches between the two mid-take sounds like a fault.
 */
export const MIN_COMPANION_COVER = 0.5;

interface Placeable {
  id: string;
  kind: string;
  duration_ms: number;
}

/**
 * Which recorder, if any, is the sound of each video.
 *
 * A match from an audio-only file to a video that covers at least half of it.
 * Where several recorders cover one video the best-matched wins, ties broken
 * by id. One recorder may be the sound of many videos — a field recorder left
 * running while the camera starts and stops is the common case.
 */
export function audioCompanions(
  syncs: readonly AudioSync[],
  assets: readonly Placeable[],
): AudioCompanion[] {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const best = new Map<string, { companion: AudioCompanion; score: number }>();
  for (const sync of syncs) {
    const recorder = byId.get(sync.asset_id);
    const video = byId.get(sync.reference_asset_id);
    if (!recorder || !video || recorder.kind !== 'audio' || video.kind !== 'video') continue;
    if (sync.confidence <= 0 || video.duration_ms <= 0) continue;
    const covered =
      Math.min(video.duration_ms, sync.offset_ms + recorder.duration_ms) -
      Math.max(0, sync.offset_ms);
    if (covered < MIN_COMPANION_COVER * video.duration_ms) continue;
    const current = best.get(video.id);
    const better =
      !current ||
      sync.score > current.score ||
      (sync.score === current.score &&
        compareText(recorder.id, current.companion.audio_asset_id) < 0);
    if (better) {
      best.set(video.id, {
        score: sync.score,
        companion: {
          asset_id: video.id,
          audio_asset_id: recorder.id,
          offset_ms: sync.offset_ms,
          confidence: sync.confidence,
        },
      });
    }
  }
  return [...best.values()]
    .map((entry) => entry.companion)
    .sort((a, b) => compareText(a.asset_id, b.asset_id));
}

/**
 * Recorders that are mostly the sound of some video, and so have no events of
 * their own: what they heard is already in the videos' events, and a second
 * event for the same moment would be the same moment twice.
 */
export function recordersCovered(
  companions: readonly AudioCompanion[],
  assets: readonly Placeable[],
): Set<string> {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const spans = new Map<string, { start: number; end: number }[]>();
  for (const companion of companions) {
    const recorder = byId.get(companion.audio_asset_id);
    const video = byId.get(companion.asset_id);
    if (!recorder || !video) continue;
    // The video's extent in the recorder's own time.
    const start = Math.max(0, -companion.offset_ms);
    const end = Math.min(recorder.duration_ms, video.duration_ms - companion.offset_ms);
    if (end > start) spans.set(recorder.id, [...(spans.get(recorder.id) ?? []), { start, end }]);
  }
  const covered = new Set<string>();
  for (const [id, list] of spans) {
    const recorder = byId.get(id)!;
    const merged = [...list].sort((a, b) => a.start - b.start);
    let total = 0;
    let reach = -Infinity;
    for (const span of merged) {
      const from = Math.max(span.start, reach);
      if (span.end > from) total += span.end - from;
      reach = Math.max(reach, span.end);
    }
    if (recorder.duration_ms > 0 && total >= MIN_COMPANION_COVER * recorder.duration_ms) {
      covered.add(id);
    }
  }
  return covered;
}

/**
 * The observations with each video's speech taken from its recorder.
 *
 * A camera's microphone is a metre or more from the speaker; the recorder was
 * at their collar. Where a recorder covers a video, the recorder's utterances
 * — moved into the video's time, words included — replace the camera's own for
 * that stretch. The stored observations are not changed: this is a reading of
 * them, made again on every compile.
 */
export function withCompanionSpeech(
  observations: ObservationTimeline,
  companions: readonly AudioCompanion[],
  assets: readonly Placeable[],
): ObservationTimeline {
  if (companions.length === 0) return observations;
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const covered = new Map<string, { start: number; end: number; companion: AudioCompanion }>();
  for (const companion of companions) {
    const video = byId.get(companion.asset_id);
    const recorder = byId.get(companion.audio_asset_id);
    if (!video || !recorder) continue;
    covered.set(video.id, {
      start: Math.max(0, companion.offset_ms),
      end: Math.min(video.duration_ms, companion.offset_ms + recorder.duration_ms),
      companion,
    });
  }

  const kept = observations.utterances.filter((u) => {
    const range = covered.get(u.asset_id);
    return !range || u.end_ms <= range.start || u.start_ms >= range.end;
  });
  const moved: Utterance[] = [];
  for (const [videoId, range] of covered) {
    const offset = range.companion.offset_ms;
    for (const u of observations.utterances) {
      if (u.asset_id !== range.companion.audio_asset_id) continue;
      const start = u.start_ms + offset;
      const end = u.end_ms + offset;
      if (end <= range.start || start >= range.end) continue;
      moved.push({
        ...u,
        id: `${u.id}-on-${videoId}`,
        asset_id: videoId,
        start_ms: Math.max(range.start, start),
        end_ms: Math.min(range.end, end),
        ...(u.words
          ? {
              words: u.words
                .map((w) => ({ ...w, start_ms: w.start_ms + offset, end_ms: w.end_ms + offset }))
                .filter((w) => w.start_ms >= range.start && w.end_ms <= range.end),
            }
          : {}),
      });
    }
  }
  const utterances = [...kept, ...moved].sort(
    (a, b) =>
      compareText(a.asset_id, b.asset_id) || a.start_ms - b.start_ms || compareText(a.id, b.id),
  );
  return { ...observations, utterances };
}
