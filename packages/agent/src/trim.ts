/**
 * Choosing where a clip starts and stops inside an event.
 *
 * An event is a unit of meaning; a clip is what actually goes on the timeline,
 * and the difference between a rough cut a person can work with and one they
 * throw away is mostly here. The rules, in the order in which they outrank each
 * other — decided here once, because three of them move the same two numbers:
 *
 * 1. Do not start or stop in the middle of a word. A cut through speech sounds
 *    like a fault rather than a choice, to everyone, whatever the material.
 * 2. In edited material, cut where the edit already cut, and never leave a flash
 *    of the neighbouring shot. The programme's editor chose those frames; a cut
 *    three frames off one of them is visible as a mistake. When rule 1 has two
 *    ways out of a word, it takes the one that does not cross a picture cut, so
 *    the two rarely have to fight — and when they must, the word wins, because a
 *    flash is seen for a fraction of a second and a clipped word is heard.
 * 3. Land on a quiet moment when one is near. Editors do this by ear; the
 *    silence detector is how a machine does the same thing. Below rule 2, because
 *    a picture cut is the edit's own decision and a silence is a guess about one
 *    — and under a music bed there is rarely silence to find anyway.
 * 4. Keep the reaction. The two seconds after someone finishes speaking are
 *    frequently the reason the moment was worth keeping.
 *
 * The code applies them in reverse — silence, then cuts, then words — so that
 * whatever runs last is what holds.
 */
/** How much of what follows the last words is kept when a skill asks for it. */
const REACTION_MS = 1200;

/**
 * The least of a neighbouring shot a clip may carry at either edge.
 *
 * A remnant shorter than this cannot be a shot the programme's editor chose:
 * the shot detector reports nothing under 800 ms (`min_shot_ms`), so half of
 * that is well below any shot the source can be said to contain, and at 30 fps
 * it is twelve frames — a flicker, read as a mistake rather than as a picture.
 * Measured on the probe's edited programme before cut snapping existed, the
 * edges of a travel-vlog cut carried remnants of 200, 300 and 300 ms (all under
 * this, all flashes) and one of 800 ms, which is a short shot and is left alone.
 */
export const FLASH_FRAME_MS = 400;

export interface TrimWindow {
  start_ms: number;
  end_ms: number;
}

export interface TrimRequest {
  /** The event's whole extent in the source asset. */
  range: TrimWindow;
  /** Speech inside the asset, in asset time. */
  speech: readonly TrimWindow[];
  /**
   * Individual words inside the asset, in asset time, when the transcriber gave
   * them. Rule 1 above is unenforceable without these.
   */
  words?: readonly TrimWindow[];
  /** Silences inside the asset, in asset time. */
  silences: readonly TrimWindow[];
  /**
   * The source's own cut points, in asset time, when the clip should respect
   * them (rule 2). Absent or empty for raw footage, whose shot boundaries are
   * camera moves and whip pans rather than anybody's edit.
   */
  cuts?: readonly number[];
  /**
   * Skip the opening of a wordless clip while a handheld camera settles.
   * Absent means true. Only a camera settles: an edited programme, a clip the
   * user trimmed, a screen recording and a sound file start where they start.
   */
  settle?: boolean;
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
  reason: 'whole_event' | 'speech' | 'centre' | 'snapped' | 'cut';
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

    if (request.preserveReaction) {
      // The reaction belongs to the words this clip actually contains. Measured
      // from the last speech anywhere in the *event*, a take with a few words at
      // the start and a few more half a minute later swallowed everything in
      // between: a 29-second clip out of an 8-second ceiling, and a cut that ran
      // minutes past the target it was selected against.
      const spoken = inside.filter((s) => s.start_ms < end).at(-1) ?? inside[0]!;
      const wanted = spoken.end_ms + request.padOutMs + REACTION_MS;
      end = Math.max(end, Math.min(request.range.end_ms, start + request.maxMs, wanted));
    }

    // Prefer to stop between sentences rather than inside one.
    const boundary = sentenceBoundaryNear(inside, end, request.padOutMs, request.snapWindowMs);
    if (boundary !== undefined && boundary <= request.range.end_ms) end = boundary;
  } else {
    reason = 'centre';
    // Skip the opening of a wordless shot: a handheld take usually starts while
    // the camera is still settling.
    //
    // A camera, and nothing else. Applied to everything, it took the first 1.2
    // seconds off every shot of an edited programme — the probe's cut opened
    // 300 ms into its title card's neighbour and 800 ms before one of its own
    // edits — and would take the same off a clip the user already trimmed on
    // their phone and the first click of a screen recording.
    const skip = request.settle === false ? 0 : Math.min(available * 0.15, 1200);
    start = request.range.start_ms + skip;
    end = start + desired;
  }

  if (end > request.range.end_ms) {
    end = request.range.end_ms;
    start = Math.max(request.range.start_ms, end - desired);
  }

  const beforeSnapping = { start, end };
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

  // Rule 2, over rule 3: an edge with one of the edit's own cuts in reach goes
  // there, measured from where it was before the silence snap moved it.
  const cuts = cutsInside(request);
  if (cuts.length > 0) {
    const onCuts = snapToCuts(beforeSnapping, { start, end }, cuts, request);
    const guarded = guardFlashes(onCuts, cuts, request);
    if (guarded.start !== start || guarded.end !== end) {
      start = guarded.start;
      end = guarded.end;
      reason = 'cut';
    }
  }

  // Rule 1, last, because it outranks the others.
  //
  // It had no implementation at all. `Utterance.words` has said "enables cutting
  // on word boundaries" since the contract was written, `observe` asks
  // faster-whisper for word timestamps and pays for them on every run, and
  // nothing ever read them: `end = start + desired` put the out point wherever
  // the duration budget landed, and the only thing that ever pulled it back was
  // a whole-utterance boundary that happened to fall within the snap window.
  // With no utterance ending nearby — which is most of a long take — the cut
  // went through whatever syllable was there.
  //
  // Applied after the silence snap on purpose. A silence boundary is not
  // normally inside a word, so this is usually a no-op; when it is not, the
  // detector has put the cut mid-word and the more important rule wins.
  if (request.words && request.words.length > 0) {
    const aligned = avoidWordSplit(start, end, request);
    start = aligned.start;
    end = aligned.end;
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

/** The source's cuts that a trim inside this range can use, ascending and unique. */
function cutsInside(request: Pick<TrimRequest, 'cuts' | 'range'>): number[] {
  if (!request.cuts || request.cuts.length === 0) return [];
  const inRange = request.cuts.filter(
    (cut) => cut >= request.range.start_ms && cut <= request.range.end_ms,
  );
  return [...new Set(inRange)].sort((a, b) => a - b);
}

/** The cut nearest a moment within the window; the earlier of two equally near. */
function nearestCut(at: number, cuts: readonly number[], windowMs: number): number | undefined {
  let best: number | undefined;
  let bestDistance = windowMs + 1;
  for (const cut of cuts) {
    const distance = Math.abs(cut - at);
    if (distance <= windowMs && distance < bestDistance) {
      bestDistance = distance;
      best = cut;
    }
  }
  return best;
}

/**
 * Moves each edge onto the edit's own cut when one is within the snap window.
 *
 * Both edges if the clip stays inside its bounds, otherwise whichever one alone
 * does, otherwise neither. An edge with no cut in reach keeps whatever the
 * silence snap chose for it.
 */
function snapToCuts(
  original: { start: number; end: number },
  current: { start: number; end: number },
  cuts: readonly number[],
  request: Pick<TrimRequest, 'minMs' | 'maxMs' | 'snapWindowMs'>,
): { start: number; end: number } {
  const inCut = nearestCut(original.start, cuts, request.snapWindowMs);
  const outCut = nearestCut(original.end, cuts, request.snapWindowMs);
  const fits = (start: number, end: number): boolean =>
    end - start >= request.minMs && end - start <= request.maxMs;

  const both = { start: inCut ?? current.start, end: outCut ?? current.end };
  if (fits(both.start, both.end)) return both;
  if (inCut !== undefined && fits(inCut, current.end)) return { start: inCut, end: current.end };
  if (outCut !== undefined && fits(current.start, outCut))
    return { start: current.start, end: outCut };
  return current;
}

/** The length of neighbouring shot a clip opens on, if it opens on a remnant of one. */
function headRemnant(start: number, end: number, cuts: readonly number[]): number | undefined {
  const first = cuts.find((cut) => cut > start && cut < end);
  return first === undefined ? undefined : first - start;
}

/** The length of neighbouring shot a clip closes on, if it closes on a remnant of one. */
function tailRemnant(start: number, end: number, cuts: readonly number[]): number | undefined {
  const last = cuts.findLast((cut) => cut > start && cut < end);
  return last === undefined ? undefined : end - last;
}

/**
 * Takes a flash of the neighbouring shot off either edge.
 *
 * Measured on the probe's edited programme: the in and out points of a
 * travel-vlog cut, placed with no knowledge of its edits, left 200 to 800 ms of
 * the next or previous shot at three of four inner edges. An edge with a
 * remnant under {@link FLASH_FRAME_MS} moves in to the cut, dropping the
 * remnant; if that makes the clip too short, it moves out to the cut before,
 * taking the whole shot instead; if neither fits, it stays.
 */
function guardFlashes(
  clip: { start: number; end: number },
  cuts: readonly number[],
  request: Pick<TrimRequest, 'minMs' | 'maxMs' | 'range'>,
): { start: number; end: number } {
  let { start, end } = clip;

  const head = headRemnant(start, end, cuts);
  if (head !== undefined && head < FLASH_FRAME_MS) {
    const inward = start + head;
    const outward = cuts.findLast((cut) => cut <= start && cut >= request.range.start_ms);
    if (end - inward >= request.minMs) start = inward;
    else if (outward !== undefined && end - outward <= request.maxMs) start = outward;
  }

  const tail = tailRemnant(start, end, cuts);
  if (tail !== undefined && tail < FLASH_FRAME_MS) {
    const inward = end - tail;
    const outward = cuts.find((cut) => cut >= end && cut <= request.range.end_ms);
    if (inward - start >= request.minMs) end = inward;
    else if (outward !== undefined && outward - start <= request.maxMs) end = outward;
  }

  return { start, end };
}

/** The word a moment falls strictly inside, if any. */
function wordAt(at: number, words: readonly TrimWindow[]): TrimWindow | undefined {
  return words.find((word) => at > word.start_ms && at < word.end_ms);
}

/**
 * Moves a cut out of the middle of a word.
 *
 * Each edge has two ways out and they are not equivalent. At the in point,
 * retreating to the word's start keeps the word whole and lengthens the clip;
 * advancing to its end drops the word and shortens it. At the out point it is
 * the mirror. Both silence the fault, so the choice is made on length: take the
 * one that keeps the clip inside its window, and prefer the one that keeps the
 * speech when both do.
 *
 * In edited material, a word runs across a picture cut as often as not — the
 * sound of the next shot starts under the last frames of this one — and keeping
 * the word there means carrying a flash of the shot it belongs to. When the
 * source's cuts are given, the way out that leaves no flash is preferred over
 * the one that keeps the word; both are still out of the word.
 *
 * Exported because it is the rule this file says matters most, and a rule worth
 * stating is worth testing directly.
 */
export function avoidWordSplit(
  start: number,
  end: number,
  request: Pick<TrimRequest, 'words' | 'range' | 'minMs' | 'maxMs' | 'cuts'>,
): { start: number; end: number } {
  const words = request.words ?? [];
  const cuts = cutsInside(request);
  const fits = (from: number, to: number): boolean => {
    const length = to - from;
    return length >= request.minMs && length <= request.maxMs;
  };
  const choose = (
    options: readonly number[],
    fitsWith: (at: number) => boolean,
    flashes: (at: number) => boolean,
  ): number =>
    options.find((at) => fitsWith(at) && !flashes(at)) ??
    options.find((at) => fitsWith(at)) ??
    options[0]!;

  let movedStart = start;
  const startWord = wordAt(start, words);
  if (startWord) {
    // Keeping the word is the first choice; dropping it is the fallback.
    const keep = Math.max(request.range.start_ms, startWord.start_ms);
    const drop = Math.min(request.range.end_ms, startWord.end_ms);
    movedStart = choose(
      [keep, drop],
      (at) => fits(at, end),
      (at) => (headRemnant(at, end, cuts) ?? Infinity) < FLASH_FRAME_MS,
    );
  }

  let movedEnd = end;
  const endWord = wordAt(end, words);
  if (endWord) {
    const keep = Math.min(request.range.end_ms, endWord.end_ms);
    const drop = Math.max(request.range.start_ms, endWord.start_ms);
    movedEnd = choose(
      [keep, drop],
      (at) => fits(movedStart, at),
      (at) => (tailRemnant(movedStart, at, cuts) ?? Infinity) < FLASH_FRAME_MS,
    );
  }

  return { start: movedStart, end: movedEnd };
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

/* -------------------------------------------------------------------------- */
/* Taking pauses out                                                           */
/* -------------------------------------------------------------------------- */

export interface PauseRequest {
  /** The clip, as the trim chose it, in asset time. */
  window: TrimWindow;
  /** Silent stretches of the asset, by the one definition (`silentSpans`). */
  silences: readonly TrimWindow[];
  /** Timed words in the asset, when the transcriber gave them. */
  words?: readonly TrimWindow[];
  /**
   * Where the sound is known to be music. A gap between two words over a music
   * bed is not a pause in the sound, and taking it out chops the music.
   */
  music?: readonly TrimWindow[];
  /** Shortest pause worth taking out. */
  minPauseMs: number;
  /** Left on each side of a removed pause: a word's tail, a breath. */
  handleMs: number;
}

/**
 * The stretches to take out of one clip so that its speech runs without pauses.
 *
 * A pause is a level-checked silence or, where the transcriber timed its words,
 * a gap between two words; either way it never reaches into a word. Each is
 * taken out less a handle at each end, so that the tail of the last word and the
 * breath before the next survive the cut. A pause at the start or the end of the
 * clip is taken out to the edge, keeping only the handle beside the words: a
 * clip that opens on three seconds of an unchanged screen before the voice-over
 * starts is the same dead air as a pause in the middle, and the screen-recording
 * probe's six ten-second slides each opened on two seconds of it and closed on
 * five. A clip is never taken out entirely.
 *
 * Changes durations, by design: that is what it is for. It is also the opposite
 * contract to the activity mask, which must never change a time value, and the
 * two share nothing but the definition of silence.
 */
export function pausesToRemove(request: PauseRequest): TrimWindow[] {
  const { window } = request;
  const words = [...(request.words ?? [])]
    .filter((w) => w.end_ms > window.start_ms && w.start_ms < window.end_ms)
    .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);

  const candidates: TrimWindow[] = request.silences.map((s) => ({
    start_ms: Math.max(s.start_ms, window.start_ms),
    end_ms: Math.min(s.end_ms, window.end_ms),
  }));
  for (let i = 1; i < words.length; i++) {
    const gap = { start_ms: words[i - 1]!.end_ms, end_ms: words[i]!.start_ms };
    const overMusic = (request.music ?? []).some(
      (m) => m.start_ms < gap.end_ms && m.end_ms > gap.start_ms,
    );
    if (gap.end_ms > gap.start_ms && !overMusic) candidates.push(gap);
  }

  const pauses = subtractSpans(
    mergeSpans(candidates.filter((c) => c.end_ms > c.start_ms)),
    words,
  ).filter((pause) => pause.end_ms - pause.start_ms >= request.minPauseMs);

  // The handle goes on the side the words are. At the clip's own edge there is
  // nothing on the far side to keep a handle for.
  const removed = pauses
    .map((pause) => ({
      start_ms:
        pause.start_ms <= window.start_ms ? window.start_ms : pause.start_ms + request.handleMs,
      end_ms: pause.end_ms >= window.end_ms ? window.end_ms : pause.end_ms - request.handleMs,
    }))
    .filter((pause) => pause.end_ms > pause.start_ms);

  // With word timings, a piece left between two removed pauses that holds no
  // word at all is a cough or a click between two silences, not speech, and a
  // clip of it is a flash of noise. It goes with the pauses around it.
  const merged: TrimWindow[] = [];
  for (const pause of removed) {
    const last = merged.at(-1);
    const between = last && { start_ms: last.end_ms, end_ms: pause.start_ms };
    const spoken =
      words.length === 0 ||
      (between !== undefined &&
        words.some((w) => w.start_ms < between.end_ms && w.end_ms > between.start_ms));
    if (last && between && !spoken) last.end_ms = pause.end_ms;
    else merged.push({ ...pause });
  }

  // Nothing left would not be a tighter clip; it would be no clip.
  const kept =
    window.end_ms - window.start_ms - merged.reduce((s, p) => s + p.end_ms - p.start_ms, 0);
  return kept > 0 ? merged : [];
}

/** What is left of a window once some stretches are taken out of it, in order. */
export function piecesAfterRemoving(
  window: TrimWindow,
  removed: readonly TrimWindow[],
): TrimWindow[] {
  return subtractSpans([window], removed).filter((piece) => piece.end_ms > piece.start_ms);
}

function mergeSpans(spans: readonly TrimWindow[]): TrimWindow[] {
  const sorted = [...spans].sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
  const out: TrimWindow[] = [];
  for (const span of sorted) {
    const last = out.at(-1);
    if (last && span.start_ms <= last.end_ms) last.end_ms = Math.max(last.end_ms, span.end_ms);
    else out.push({ ...span });
  }
  return out;
}

function subtractSpans(from: readonly TrimWindow[], remove: readonly TrimWindow[]): TrimWindow[] {
  let pieces = from.map((span) => ({ ...span }));
  for (const cut of remove) {
    const next: TrimWindow[] = [];
    for (const piece of pieces) {
      if (cut.end_ms <= piece.start_ms || cut.start_ms >= piece.end_ms) {
        next.push(piece);
        continue;
      }
      if (cut.start_ms > piece.start_ms)
        next.push({ start_ms: piece.start_ms, end_ms: cut.start_ms });
      if (cut.end_ms < piece.end_ms) next.push({ start_ms: cut.end_ms, end_ms: piece.end_ms });
    }
    pieces = next;
  }
  return pieces.sort((a, b) => a.start_ms - b.start_ms);
}
