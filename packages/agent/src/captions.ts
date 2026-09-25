import {
  compareText,
  hasAudioStream,
  operationTimelineDuration,
  seqId,
  type EditPlan,
  type EditorialIR,
  type ObservationTimeline,
  type TextOperation,
  type VideoOperation,
} from '@editorial-ir/contracts';

/**
 * Captions for a cut: what is said, where it is heard in the edit.
 *
 * The transcript is in source time, one recording at a time; a caption is in
 * timeline time, and only for sound the cut actually plays. So each clip that
 * carries its own sound takes the words spoken inside its source range, moves
 * them to where the clip sits, and breaks them into cues a person can read.
 * A caption never crosses from one clip into the next: across a cut the words
 * belong to a different moment, and a line that stays up after its sentence has
 * been cut away captions nothing. A jump cut (`continues_previous`) is the same
 * sentence with a pause taken out, and its captions follow the pieces — each
 * piece shows the words it plays, and the pause that was removed is not waited
 * for.
 *
 * This is planning, not formatting, which is why it is here and not in an
 * adapter: the SRT, the WebVTT, the FCPXML captions and the burned-in preview
 * all read the plan's caption operations, so all of them show the same words at
 * the same moments.
 */

/**
 * The readability rules, each with where it comes from.
 *
 * - 42 characters a line for text with spaces: the line length in Netflix's
 *   English timed-text guideline, and the widest a line can be and still be
 *   read in one glance at the bottom of a 16:9 frame.
 * - 13 characters a line for text without spaces (Japanese, Chinese): Netflix's
 *   Japanese guideline. A kanji carries roughly what a Latin word does, so the
 *   two limits hold about the same amount of meaning.
 * - Two lines at most: a third covers the picture the caption is about.
 * - 833 ms at least (five sixths of a second, the same guideline's minimum),
 *   extended into the silence after the words where there is one, because a
 *   one-word cue timed to the word flashes by faster than it can be read.
 * - 7 s at most: longer than that and a reader re-reads the line.
 * - A new cue after a pause of 1 s or more between words. The transcriber
 *   already splits an utterance at pauses over 2 s; inside one, the gaps the
 *   worked example's and the probe footage's word timings show between phrases
 *   run 0.4 to 1.5 s, and a cue that spans one shows its second phrase a second
 *   before it is said.
 */
export const CAPTION_RULES = {
  latinLineChars: 42,
  cjkLineChars: 13,
  maxLines: 2,
  minDisplayMs: 833,
  maxDisplayMs: 7000,
  pauseMs: 1000,
  /**
   * Shorter than this after every other rule, a cue is folded into its
   * neighbour: one frame of text is noise, not a caption.
   */
  minVisibleMs: 300,
} as const;

export interface CaptionOptions {
  /** Why a clip got no captions, in words a person can act on. */
  notes?: string[];
  /**
   * Caption clips whose picture already shows subtitles. Off by default: an
   * edited programme with burned-in subtitles would otherwise show every line
   * twice, one set on top of the other.
   */
  overBurnedSubtitles?: boolean;
}

/** A word, or a stretch of an utterance standing in for one, in source time. */
interface Token {
  text: string;
  start: number;
  end: number;
  utterance: string;
  /** Position in its utterance, from 0. */
  index: number;
  /** Timed by sharing the utterance's span by length, not by the transcriber. */
  estimated: boolean;
}

/** A cue before it becomes an operation: timeline times and the tokens in it. */
interface Cue {
  start: number;
  end: number;
  tokens: Token[];
  operation: VideoOperation;
}

/**
 * The captions for a plan, as `TextOperation`s of kind `caption`, in timeline
 * order, never overlapping.
 */
export function buildCaptions(
  plan: EditPlan,
  ir: EditorialIR,
  observations: ObservationTimeline | undefined,
  options: CaptionOptions = {},
): TextOperation[] {
  const notes = options.notes ?? [];
  if (!observations || observations.utterances.length === 0) {
    notes.push('there is no transcript to caption from');
    return [];
  }

  const tokensByUtterance = new Map<string, Token[]>();
  for (const utterance of observations.utterances) {
    tokensByUtterance.set(utterance.id, tokensOfUtterance(utterance));
  }
  const tokensByAsset = new Map<string, Token[]>();
  const tokensOf = (assetId: string): Token[] => {
    let tokens = tokensByAsset.get(assetId);
    if (!tokens) {
      tokens = observations.utterances
        .filter((utterance) => utterance.asset_id === assetId)
        .flatMap((utterance) => tokensByUtterance.get(utterance.id) ?? [])
        .sort((a, b) => a.start - b.start || a.end - b.end);
      tokensByAsset.set(assetId, tokens);
    }
    return tokens;
  };

  // Which words the cut plays at all, and in which clip. A word belongs to the
  // clip its middle falls in, so the pieces of a jump cut share a sentence
  // between them without either showing the other's words.
  const heard = [...plan.tracks.video].sort(
    (a, b) =>
      a.timeline_start_ms - b.timeline_start_ms ||
      a.track - b.track ||
      compareText(a.operation_id, b.operation_id),
  );
  const played = new Set<Token>();
  const playedBy = new Map<VideoOperation, Token[]>();
  let skippedForSubtitles = 0;
  const otherStream: string[] = [];
  const captioned: VideoOperation[] = [];
  for (const planned of heard) {
    // A clip heard through a separate recorder is captioned from what the
    // recorder heard, where the recorder plays it: the same clip, read in the
    // recorder's own time. Its camera may have no sound at all, and where it
    // has some, the transcript that chose the clip is the recorder's.
    const operation = planned.use_source_audio ? heardThrough(planned) : planned;
    const asset = ir.assets.find((a) => a.id === operation.source_asset_id);
    // Only sound the cut plays: a cutaway's own sound is not heard, and a clip
    // whose file has no sound has nothing to caption.
    if (!asset || !operation.use_source_audio || !hasAudioStream(asset)) continue;
    // The transcript is of one stream of the file — the one the analysis found
    // the speech on — and a clip may play another. Measured on the two-stream
    // probe: the speech is on stream 1 and the plan played stream 0, room tone
    // at -57 dB, while its captions showed the lavalier's two sentences.
    const transcribed =
      observations.audio_profiles.find((profile) => profile.asset_id === asset.id)?.stream_index ??
      0;
    const playing = operation.audio_stream_index ?? 0;
    if ((asset.audio_streams?.length ?? 0) > 1 && playing !== transcribed) {
      otherStream.push(
        `${operation.operation_id} (plays stream ${playing} of ${asset.file_name}; the transcript is of stream ${transcribed})`,
      );
      continue;
    }
    const within = tokensOf(asset.id).filter((token) => {
      const middle = (token.start + token.end) / 2;
      return middle >= operation.source_in_ms && middle < operation.source_out_ms;
    });
    for (const token of within) played.add(token);
    const event = ir.events.find((e) => e.id === operation.event_id);
    if (!options.overBurnedSubtitles && (event?.observed.subtitles?.length ?? 0) > 0) {
      skippedForSubtitles++;
      continue;
    }
    if (within.length === 0) continue;
    playedBy.set(operation, within);
    captioned.push(operation);
  }

  const cues: Cue[] = [];
  for (const operation of captioned) {
    const within = completeUtterances(playedBy.get(operation)!, tokensByUtterance, played);
    cues.push(...cuesForOperation(operation, within));
  }

  if (otherStream.length > 0) {
    notes.push(
      `${otherStream.length} clip(s) play a different audio stream from the one transcribed, ` +
        `so their captions would be words that are not heard: ${otherStream.join(', ')}`,
    );
  }
  if (skippedForSubtitles > 0) {
    notes.push(
      `${skippedForSubtitles} clip(s) already show subtitles in the picture and were not captioned again`,
    );
  }

  // Clips on two tracks can both be heard at once. The earlier cue gives way,
  // because two captions on screen at once cannot both be read.
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  const kept: Cue[] = [];
  for (const cue of cues) {
    const previous = kept.at(-1);
    if (previous && cue.start < previous.end) {
      previous.end = cue.start;
      if (previous.end - previous.start < CAPTION_RULES.minVisibleMs) kept.pop();
    }
    kept.push(cue);
  }

  return kept.map((cue, index) => ({
    operation_id: seqId('op_cap', index + 1),
    timeline_start_ms: cue.start,
    timeline_end_ms: cue.end,
    text: wrapCaption(joinTokens(cue.tokens)).join('\n'),
    kind: 'caption',
    ...(cue.operation.event_id ? { event_id: cue.operation.event_id } : {}),
    provenance: 'agent_derived',
  }));
}

/**
 * A clip as its sound plays it: from its recorder, in the recorder's own time,
 * when it has one. The stream is the recorder's, never the camera's.
 */
function heardThrough(operation: VideoOperation): VideoOperation {
  const source = operation.audio_source;
  if (!source) return operation;
  const { audio_stream_index: _camera, ...rest } = operation;
  return {
    ...rest,
    source_asset_id: source.asset_id,
    source_in_ms: source.source_in_ms,
    source_out_ms: source.source_in_ms + (operation.source_out_ms - operation.source_in_ms),
    ...(source.audio_stream_index === undefined
      ? {}
      : { audio_stream_index: source.audio_stream_index }),
  };
}

/**
 * An utterance's words, or stand-ins for them.
 *
 * With word timings, the words. Without them — the local transcriber gives
 * none, and the worked example's recorded transcript has none — the text is
 * split into units (words where there are spaces, characters where there are
 * none) and the utterance's time is shared among them by length. It is an
 * estimate, and it is what lets a clip that cuts an utterance in half caption
 * the half it plays instead of the whole sentence.
 */
function tokensOfUtterance(utterance: ObservationTimeline['utterances'][number]): Token[] {
  const words = (utterance.words ?? [])
    .map((word) => ({ ...word, text: word.text.trim() }))
    .filter((word) => word.text.length > 0 && word.end_ms >= word.start_ms);
  if (words.length > 0) {
    return words.map((word, index) => ({
      text: word.text,
      start: word.start_ms,
      end: word.end_ms,
      utterance: utterance.id,
      index,
      estimated: false,
    }));
  }

  const units = unitsOf(utterance.text);
  const total = units.reduce((sum, unit) => sum + displayLength(unit), 0);
  if (units.length === 0 || total === 0) return [];
  const span = Math.max(0, utterance.end_ms - utterance.start_ms);
  let consumed = 0;
  return units.map((unit, index) => {
    const start = utterance.start_ms + Math.round((span * consumed) / total);
    consumed += displayLength(unit);
    const end = utterance.start_ms + Math.round((span * consumed) / total);
    return { text: unit, start, end, utterance: utterance.id, index, estimated: true };
  });
}

/**
 * A clip's words, with the ends of its sentences settled.
 *
 * A clip that cuts into a sentence plays part of it, and what the caption does
 * with the rest depends on how well the cut point is known. With word timings
 * the words past the cut are really not heard, and they stay out. Without them
 * the split is an estimate — the utterance's time shared by length — and cutting
 * the text at an estimate stopped four of the worked example's twenty captions
 * short of their sentence, two of them mid-word: "そろそろ出発しよう" became
 * "そろそろ出発し" and "来てよかった" became "来てよかっ". So where a clip plays at least
 * half of a sentence and nothing else in the cut plays the rest, the caption
 * shows the whole sentence over the part that is heard.
 *
 * Where the rest is not heard anywhere and cannot be shown — a word-timed cut,
 * or less than half of the sentence in the clip — an ellipsis marks the side
 * that was cut away, which is how a subtitle says a sentence was interrupted.
 * The side another clip plays (the next piece of a jump cut) gets none: that
 * sentence goes on, in the next caption.
 */
function completeUtterances(
  within: Token[],
  tokensByUtterance: Map<string, Token[]>,
  played: Set<Token>,
): Token[] {
  const result: Token[] = [];
  let at = 0;
  while (at < within.length) {
    const utterance = within[at]!.utterance;
    let stop = at;
    while (stop < within.length && within[stop]!.utterance === utterance) stop++;
    const group = within.slice(at, stop);
    at = stop;

    const all = tokensByUtterance.get(utterance) ?? group;
    const first = group[0]!.index;
    const last = group.at(-1)!.index;
    let headFrom = first;
    while (headFrom > 0 && !played.has(all[headFrom - 1]!)) headFrom--;
    let tailTo = last;
    while (tailTo + 1 < all.length && !played.has(all[tailTo + 1]!)) tailTo++;
    const head = all.slice(headFrom, first);
    const tail = all.slice(last + 1, tailTo + 1);

    const length = (tokens: Token[]): number =>
      tokens.reduce((sum, token) => sum + displayLength(token.text), 0);
    const mostlyHeard = length(group) * 2 >= length(all);
    if (group[0]!.estimated && mostlyHeard) {
      result.push(...head, ...group, ...tail);
      continue;
    }
    const marked = [...group];
    if (head.length > 0) marked[0] = { ...marked[0]!, text: `…${marked[0]!.text}` };
    if (tail.length > 0) {
      const end = marked.length - 1;
      marked[end] = { ...marked[end]!, text: `${marked[end]!.text}…` };
    }
    result.push(...marked);
  }
  return result;
}

/** Words where there are spaces; characters, with their punctuation, where there are none. */
function unitsOf(text: string): string[] {
  const units: string[] = [];
  for (const piece of text.trim().split(/\s+/)) {
    if (piece.length === 0) continue;
    if (!isCjk(piece)) {
      units.push(piece);
      continue;
    }
    // Letters and digits inside Japanese stay together: "USJ" and "90" are one
    // unit each, or they come back as "U S J" and "9 0".
    let run = '';
    const flush = (): void => {
      if (run.length > 0) units.push(run);
      run = '';
    };
    for (const character of Array.from(piece)) {
      if (!isCjk(character) && !CLOSING.test(character)) {
        run += character;
        continue;
      }
      flush();
      if (units.length > 0 && CLOSING.test(character)) {
        units[units.length - 1] += character;
      } else {
        units.push(character);
      }
    }
    flush();
  }
  return units;
}

/** Characters written without spaces between words: kana, kanji, hangul, full-width forms. */
const CJK = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/u;
/** Characters a line may not start with (kinsoku): closing punctuation and small kana. */
const CLOSING =
  /^[、。，．・：；？！ー」』）】〕〉》”’ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ!?,.)\]]$/u;
const SENTENCE_END = /[.!?。！？…]["'”’」』)]?$/u;

function isCjk(text: string): boolean {
  return CJK.test(text);
}

/** Characters a reader sees: code points, not UTF-16 units. */
function displayLength(text: string): number {
  return Array.from(text).length;
}

/** Whether a cue's text is mostly written without spaces. */
function isCjkText(text: string): boolean {
  const characters = Array.from(text.replace(/\s/g, ''));
  if (characters.length === 0) return false;
  return characters.filter((c) => CJK.test(c)).length * 2 >= characters.length;
}

function lineLimit(text: string): number {
  return isCjkText(text) ? CAPTION_RULES.cjkLineChars : CAPTION_RULES.latinLineChars;
}

/** Tokens back into text: a space between words, none beside a character written without them. */
function joinTokens(tokens: Token[]): string {
  let text = '';
  for (const token of tokens) {
    if (text.length === 0) {
      text = token.text;
      continue;
    }
    const tight =
      isCjk(text.slice(-1)) || isCjk(token.text.slice(0, 1)) || CLOSING.test(token.text[0]!);
    text += tight ? token.text : ` ${token.text}`;
  }
  return text;
}

/**
 * One clip's words, grouped into cues and moved onto the timeline.
 *
 * A cue ends at the end of a sentence, at a pause, at the end of an utterance,
 * when it would need a third line, or when it would stay up longer than a
 * reader needs it.
 */
function cuesForOperation(operation: VideoOperation, tokens: Token[]): Cue[] {
  const clipStart = operation.timeline_start_ms;
  const clipEnd = clipStart + operationTimelineDuration(operation);
  const toTimeline = (ms: number): number => {
    const clamped = Math.min(Math.max(ms, operation.source_in_ms), operation.source_out_ms);
    return Math.min(
      clipEnd,
      clipStart + Math.round((clamped - operation.source_in_ms) / operation.speed),
    );
  };

  const groups: Token[][] = [];
  let current: Token[] = [];
  for (const token of tokens) {
    const last = current.at(-1);
    if (last) {
      const text = joinTokens([...current, token]);
      const split =
        token.utterance !== last.utterance ||
        token.start - last.end >= CAPTION_RULES.pauseMs ||
        SENTENCE_END.test(last.text) ||
        // Whether it still wraps to two lines, not whether it has two lines'
        // worth of characters: words do not pack a line exactly. The probe's
        // voice memo, 84 characters that are two lines of 42 on paper, broke
        // into lines of 39, 33 and 9 and went up as a three-line caption.
        wrapCaption(text).length > CAPTION_RULES.maxLines ||
        token.end - current[0]!.start > CAPTION_RULES.maxDisplayMs;
      if (split) {
        groups.push(current);
        current = [];
      }
    }
    current.push(token);
  }
  if (current.length > 0) groups.push(current);

  let cues: Cue[] = groups.map((group) => ({
    start: toTimeline(group[0]!.start),
    end: toTimeline(group.at(-1)!.end),
    tokens: group,
    operation,
  }));

  // Long enough to read, where the silence after the words allows it, and
  // never past the next cue or the end of the clip.
  for (const [index, cue] of cues.entries()) {
    const limit = Math.min(cues[index + 1]?.start ?? clipEnd, clipEnd);
    cue.end = Math.max(cue.end, Math.min(cue.start + CAPTION_RULES.minDisplayMs, limit));
  }

  // A cue that still cannot be shown for long enough to see — the next one
  // follows too closely — joins its neighbour. Folding before extending joined
  // three one-word answers a second apart into one caption: each was 200 ms of
  // speech, under the limit, although the silence after each had room for it.
  const folded: Cue[] = [];
  for (const cue of cues) {
    const previous = folded.at(-1);
    if (previous && cue.end - cue.start < CAPTION_RULES.minVisibleMs) {
      previous.end = cue.end;
      previous.tokens = [...previous.tokens, ...cue.tokens];
      continue;
    }
    if (previous && previous.end - previous.start < CAPTION_RULES.minVisibleMs) {
      previous.end = cue.end;
      previous.tokens = [...previous.tokens, ...cue.tokens];
      continue;
    }
    folded.push(cue);
  }
  cues = folded.filter((cue) => cue.end > cue.start);
  return cues;
}

/**
 * A caption's text as lines.
 *
 * Two lines are balanced rather than filled: a long first line over a short
 * second one sends the eye back across the frame for two words. Text with
 * spaces breaks between words; text without them breaks after punctuation
 * where there is some within reach, and never so that a line starts with a
 * closing mark or a small kana. Text longer than two lines (a single unbroken
 * run can be) is broken as often as it must be.
 */
export function wrapCaption(text: string): string[] {
  const limit = lineLimit(text);
  const characters = Array.from(text);
  if (characters.length <= limit) return [text];

  if (!isCjkText(text)) {
    const words = text.split(' ');
    if (characters.length > limit * CAPTION_RULES.maxLines || words.length < 2) {
      return greedyWords(words, limit);
    }
    let best: { at: number; score: number } | undefined;
    for (let at = 1; at < words.length; at++) {
      const first = words.slice(0, at).join(' ').length;
      const second = words.slice(at).join(' ').length;
      if (first > limit || second > limit) continue;
      const score = Math.abs(first - second) + (first > second ? 0.5 : 0);
      if (!best || score < best.score) best = { at, score };
    }
    if (!best) return greedyWords(words, limit);
    return [words.slice(0, best.at).join(' '), words.slice(best.at).join(' ')];
  }

  if (characters.length > limit * CAPTION_RULES.maxLines) {
    const lines: string[] = [];
    let rest = characters;
    while (rest.length > limit) {
      let at = limit;
      while (at > 1 && CLOSING.test(rest[at]!)) at--;
      lines.push(rest.slice(0, at).join('').trim());
      rest = rest.slice(at);
    }
    if (rest.length > 0) lines.push(rest.join('').trim());
    return lines;
  }

  let best: { at: number; score: number } | undefined;
  for (let at = 1; at < characters.length; at++) {
    const first = at;
    const second = characters.length - at;
    if (first > limit || second > limit) continue;
    if (CLOSING.test(characters[at]!)) continue;
    const afterPunctuation = /[、。，．！？!?,]/u.test(characters[at - 1]!);
    const score =
      Math.abs(first - second) - (afterPunctuation ? limit : 0) + (first > second ? 0.5 : 0);
    if (!best || score < best.score) best = { at, score };
  }
  const at = best?.at ?? limit;
  return [characters.slice(0, at).join('').trim(), characters.slice(at).join('').trim()].filter(
    (line) => line.length > 0,
  );
}

function greedyWords(words: string[], limit: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line.length === 0) line = word;
    else if (line.length + 1 + word.length <= limit) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}
