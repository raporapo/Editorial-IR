/**
 * Choosing where a clip starts and stops inside an event.
 *
 * An event is a unit of meaning; a clip is what actually goes on the timeline,
 * and the difference between a rough cut a person can work with and one they
 * throw away is mostly here. Three rules, in order of how much they matter:
 *
 * 1. Do not start or stop in the middle of a word. A cut through speech sounds
 *    like a fault rather than a choice.
 * 2. Land on a quiet moment when one is near. Editors do this by ear; the
 *    silence detector is how a machine does the same thing.
 * 3. Keep the reaction. The two seconds after someone finishes speaking are
 *    frequently the reason the moment was worth keeping.
 */
export interface TrimWindow {
  start_ms: number;
  end_ms: number;
}

export interface TrimRequest {
  /** The event's whole extent in the source asset. */
  range: TrimWindow;
  /** Speech inside the asset, in asset time. */
  speech: readonly TrimWindow[];
  /** Silences inside the asset, in asset time. */
  silences: readonly TrimWindow[];
  desiredMs: number;
  minMs: number;
  maxMs: number;
  padInMs: number;
  padOutMs: number;
  snapToSilence: boolean;
  snapWindowMs: number;
  /** Extend past the end of speech to keep what follows it. */
  preserveReaction: boolean;
}

export interface TrimResult {
  in_ms: number;
  out_ms: number;
  /** How the in point was chosen, for the plan's rationale. */
  reason: 'whole_event' | 'speech' | 'centre' | 'snapped';
}

export function chooseTrim(request: TrimRequest): TrimResult {
  const available = request.range.end_ms - request.range.start_ms;
  const desired = Math.min(
    Math.max(request.desiredMs, request.minMs),
    Math.min(request.maxMs, available),
  );

  // Short enough to keep whole: nothing to choose.
  if (desired >= available) {
    return { in_ms: request.range.start_ms, out_ms: request.range.end_ms, reason: 'whole_event' };
  }

  const inside = request.speech
    .filter((s) => s.end_ms > request.range.start_ms && s.start_ms < request.range.end_ms)
    .sort((a, b) => a.start_ms - b.start_ms);

  let start: number;
  let end: number;
  let reason: TrimResult['reason'];

  if (inside.length > 0) {
    reason = 'speech';
    // Start a little before the first words, so the clip does not open on a
    // syllable already in progress.
    start = Math.max(request.range.start_ms, inside[0]!.start_ms - request.padInMs);
    end = start + desired;

    const lastSpeechEnd = inside.at(-1)!.end_ms;
    if (request.preserveReaction) {
      end = Math.max(end, Math.min(request.range.end_ms, lastSpeechEnd + request.padOutMs + 1200));
    }

    // Prefer to stop between sentences rather than inside one.
    const boundary = sentenceBoundaryNear(inside, end, request.padOutMs, request.snapWindowMs);
    if (boundary !== undefined && boundary <= request.range.end_ms) end = boundary;
  } else {
    reason = 'centre';
    // Skip the opening of a wordless shot: a handheld take usually starts while
    // the camera is still settling.
    const skip = Math.min(available * 0.15, 1200);
    start = request.range.start_ms + skip;
    end = start + desired;
  }

  if (end > request.range.end_ms) {
    end = request.range.end_ms;
    start = Math.max(request.range.start_ms, end - desired);
  }

  if (request.snapToSilence) {
    const snappedStart = snapTo(start, request.silences, request.snapWindowMs, 'end');
    const snappedEnd = snapTo(end, request.silences, request.snapWindowMs, 'start');
    if (snappedStart !== start || snappedEnd !== end) {
      const candidateStart = Math.max(request.range.start_ms, snappedStart);
      const candidateEnd = Math.min(request.range.end_ms, snappedEnd);
      // Only take the snap if it does not push the clip outside its bounds.
      const length = candidateEnd - candidateStart;
      if (length >= request.minMs && length <= request.maxMs) {
        start = candidateStart;
        end = candidateEnd;
        reason = 'snapped';
      }
    }
  }

  const clampedStart = Math.max(request.range.start_ms, Math.round(start));
  const clampedEnd = Math.min(request.range.end_ms, Math.round(end));

  // A clip shorter than its floor is worse than one slightly outside its window.
  if (clampedEnd - clampedStart < request.minMs) {
    const growTo = Math.min(request.range.end_ms, clampedStart + request.minMs);
    return {
      in_ms: Math.max(request.range.start_ms, growTo - request.minMs),
      out_ms: growTo,
      reason,
    };
  }

  return { in_ms: clampedStart, out_ms: clampedEnd, reason };
}

/**
 * The nearest silence edge within the window.
 *
 * `end` finds a silence to start *after*, `start` finds one to stop *before*.
 */
export function snapTo(
  at: number,
  silences: readonly TrimWindow[],
  windowMs: number,
  edge: 'start' | 'end',
): number {
  let best = at;
  // Inclusive: a boundary exactly at the edge of the window is inside it.
  let bestDistance = windowMs + 1;
  for (const silence of silences) {
    const candidate = edge === 'end' ? silence.end_ms : silence.start_ms;
    const distance = Math.abs(candidate - at);
    if (distance <= windowMs && distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/** The end of whichever utterance finishes nearest the proposed out point. */
function sentenceBoundaryNear(
  speech: readonly TrimWindow[],
  at: number,
  padOutMs: number,
  windowMs: number,
): number | undefined {
  let best: number | undefined;
  let bestDistance = windowMs + 1;
  for (const utterance of speech) {
    const candidate = utterance.end_ms + padOutMs;
    const distance = Math.abs(candidate - at);
    if (distance <= windowMs && distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}
