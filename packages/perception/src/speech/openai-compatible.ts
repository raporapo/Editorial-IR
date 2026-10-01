import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { EditorialError, TranscribeResult } from '@editorial-ir/contracts';
import type { ModelIdentity, SpeechModel } from '../types.js';
import { computeHopStatistics, readWavHeader } from '../wav.js';

/**
 * Transcription from any server that speaks OpenAI's
 * `POST /v1/audio/transcriptions`.
 *
 * One client for several very different engines: Phonon-2 behind
 * `phonon serve` (an English model that runs at well over a hundred times
 * realtime on a laptop CPU), a faster-whisper server on the same machine, or a
 * hosted service. Which one is configuration (`OEA_TRANSCRIBE_*`), never code.
 *
 * What these servers return differs more than the shared shape suggests, and
 * each difference is handled where it is met rather than assumed away:
 *
 * - `verbose_json` carries a start and end per segment; some servers (Phonon-2)
 *   give no word timings at all, others give them only when asked with
 *   `timestamp_granularities[]=word`. Both are asked for; what comes back is used.
 * - A server that answers only `json` (text, no times) is asked that way once it
 *   has refused the verbose form, and the text is placed over the stretch it came
 *   from — coarse, and said so by its low confidence.
 * - Hosted endpoints cap an upload (25 MB at OpenAI, about thirteen minutes of
 *   the 16 kHz mono WAV prepare makes). A longer file is sent in pieces cut at
 *   the quietest moment near each limit, so a word is not split in two, and the
 *   pieces' times are put back on the file's clock.
 */
export interface OpenAiCompatibleSpeechOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /**
   * The languages this server can transcribe, as primary subtags (`en`). Empty
   * means any. Phonon-2 is English-only, and a Japanese file sent to it comes
   * back as confident English nonsense rather than an error.
   */
  languages?: string[];
  /** Largest upload, in bytes. Default 24 MB, under the common 25 MB cap. */
  maxBytes?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Overrides the locality inferred from the URL. */
  remote?: boolean;
}

const LOCAL_HOST = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/;

/** Models known to transcribe one language only, when none is configured. */
const KNOWN_LANGUAGES: [RegExp, string[]][] = [[/phonon/i, ['en']]];

/** The primary subtag of a BCP-47 tag: `ja-JP` → `ja`. */
export function primaryLanguage(tag: string | undefined): string | undefined {
  const primary = tag?.trim().toLowerCase().split(/[-_]/)[0];
  return primary ? primary : undefined;
}

/** The languages a model handles: configured, else known for its name, else any. */
export function languagesFor(model: string, configured?: string): string[] {
  const listed = (configured ?? '')
    .split(',')
    .map((tag) => primaryLanguage(tag))
    .filter((tag): tag is string => tag !== undefined);
  if (listed.length > 0) return listed;
  return KNOWN_LANGUAGES.find(([pattern]) => pattern.test(model))?.[1] ?? [];
}

interface VerboseSegment {
  start?: number;
  end?: number;
  text?: string;
  avg_logprob?: number;
  words?: VerboseWord[];
}
interface VerboseWord {
  word?: string;
  text?: string;
  start?: number;
  end?: number;
  probability?: number;
}
interface VerbosePayload {
  text?: string;
  language?: string;
  duration?: number;
  segments?: VerboseSegment[];
  words?: VerboseWord[];
}

type Utterance = TranscribeResult['utterances'][number];

export class OpenAiCompatibleSpeechModel implements SpeechModel {
  readonly identity: ModelIdentity;
  readonly languages: string[];
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch | undefined;
  /** Whether the server takes `verbose_json`. Learned once, then kept. */
  private verbose = true;
  /** Whether the server returns word times. Unknown until it has answered. */
  private wordTimings: boolean | undefined;

  constructor(options: OpenAiCompatibleSpeechOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.languages = options.languages ?? [];
    this.maxBytes = options.maxBytes ?? 24 * 1024 * 1024;
    this.timeoutMs = options.timeoutMs ?? 15 * 60_000;
    this.fetchImpl = options.fetchImpl;
    const remote = options.remote ?? !LOCAL_HOST.test(this.baseUrl);
    this.identity = {
      backend: 'openai-compatible-transcription',
      model: options.model,
      locality: remote ? 'remote_api' : 'local',
      // The audio itself is uploaded: on a remote server, media leaves.
      mediaLeavesDevice: remote,
      parameters: { base_url: this.baseUrl, model: options.model },
    };
  }

  /** Whether this server can transcribe a file in `language` (unset: unknown). */
  handles(language: string | undefined): boolean {
    if (this.languages.length === 0) return true;
    const primary = primaryLanguage(language);
    return primary !== undefined && this.languages.includes(primary);
  }

  async transcribe(params: Parameters<SpeechModel['transcribe']>[0]): Promise<TranscribeResult> {
    const audio = new WavAudio(params.audio_path);
    if (this.wordTimings !== false) {
      const whole = await this.transcribePieces(
        params,
        audio,
        audio.pieces([[0, audio.totalMs]], this.maxBytes),
      );
      // Learned from the first answer with something in it. A server that gives
      // segment times but no word times cannot say where inside a segment a
      // pause fell — Phonon-2 returned "Good morning everyone. … the lighthouse."
      // as one utterance from 0 to 13.7 s around four seconds of silence — so
      // from then on the audio is sent a stretch of speech at a time, and this
      // file again.
      if (this.wordTimings === undefined && whole.sawText) this.wordTimings = whole.sawWords;
      if (this.wordTimings !== false) return whole.result;
    }
    return (await this.transcribePieces(params, audio, audio.pieces(audio.voiced(), this.maxBytes)))
      .result;
  }

  private async transcribePieces(
    params: Parameters<SpeechModel['transcribe']>[0],
    audio: WavAudio,
    pieces: AudioPiece[],
  ): Promise<{ result: TranscribeResult; sawText: boolean; sawWords: boolean }> {
    const utterances: Utterance[] = [];
    let language: string | undefined;
    let sawText = false;
    let sawWords = false;
    for (const piece of pieces) {
      const payload = await this.request(audio.wav(piece), params.language, params.vocabulary);
      language ??= payload.language;
      sawText ||=
        Boolean(payload.text?.trim()) || (payload.segments ?? []).some((s) => s.text?.trim());
      sawWords ||=
        (payload.words?.length ?? 0) > 0 ||
        (payload.segments ?? []).some((s) => (s.words?.length ?? 0) > 0);
      utterances.push(...toUtterances(payload, piece.startMs, piece.endMs, this.verbose));
    }
    return {
      result: TranscribeResult.parse({
        ...(params.language ? { language: params.language } : language ? { language } : {}),
        model: this.model,
        utterances,
      }),
      sawText,
      sawWords,
    };
  }

  private async request(
    wav: Buffer,
    language: string | undefined,
    vocabulary: readonly string[],
  ): Promise<VerbosePayload> {
    const doFetch = this.fetchImpl ?? globalThis.fetch;
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', this.model);
    form.append('response_format', this.verbose ? 'verbose_json' : 'json');
    if (this.verbose) {
      form.append('timestamp_granularities[]', 'segment');
      form.append('timestamp_granularities[]', 'word');
    }
    const primary = primaryLanguage(language);
    if (primary) form.append('language', primary);
    // The way this family of models is biased toward names: the words the user
    // told us, as a prompt. A server that does not implement it ignores it.
    if (vocabulary.length > 0) form.append('prompt', vocabulary.slice(0, 40).join(', '));

    const response = await doFetch(`${this.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {},
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 500);
      // A server that answers only text, asked for times. Ask it its way, once.
      if (
        this.verbose &&
        response.status >= 400 &&
        response.status < 500 &&
        /response_format|verbose_json/i.test(body)
      ) {
        this.verbose = false;
        return this.request(wav, language, vocabulary);
      }
      throw new EditorialError(
        'perception_failed',
        `the transcription server returned ${response.status}`,
        { status: response.status, body },
      );
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as VerbosePayload;
    } catch {
      // `text` format, or a server that ignored the format asked for.
      return { text };
    }
  }
}

/**
 * Utterances from one piece's answer, on the file's clock. With segment times,
 * one utterance per segment and the words that fall inside it; without, the
 * text over the whole piece, at a confidence that says how little is known
 * about where in it each word was said.
 */
export function toUtterances(
  payload: VerbosePayload,
  pieceStartMs: number,
  pieceEndMs: number,
  timed = true,
): Utterance[] {
  const at = (seconds: number | undefined): number | undefined =>
    seconds === undefined || !Number.isFinite(seconds)
      ? undefined
      : Math.round(pieceStartMs + seconds * 1000);
  const words = (payload.words ?? []).filter(
    (w) => w.start !== undefined && w.end !== undefined && (w.word ?? w.text ?? '').trim(),
  );
  const out: Utterance[] = [];
  const segments = timed ? (payload.segments ?? []) : [];
  for (const segment of segments) {
    const text = (segment.text ?? '').trim();
    const start = at(segment.start);
    const end = at(segment.end);
    if (!text || start === undefined || end === undefined || end <= start) continue;
    const inside = (segment.words?.length ? segment.words : words)
      .filter((w) => {
        const middle = ((w.start ?? 0) + (w.end ?? 0)) / 2;
        return middle >= (segment.start ?? 0) && middle < (segment.end ?? 0);
      })
      .map((w) => ({
        start_ms: at(w.start)!,
        end_ms: at(w.end)!,
        text: (w.word ?? w.text ?? '').trim(),
        ...(w.probability === undefined ? {} : { confidence: w.probability }),
      }));
    const confidence =
      segment.avg_logprob === undefined ? 0.5 : Math.max(0, Math.min(1, 1 + segment.avg_logprob));
    // A segment whose own words put a long pause inside it is several
    // utterances, as on the Whisper path: a voice-activity filter can hand back
    // one segment spanning the silence it removed.
    const groups = splitOnPauses(inside);
    if (groups.length > 1) {
      for (const group of groups) {
        out.push({
          start_ms: group[0]!.start_ms,
          end_ms: group.at(-1)!.end_ms,
          text: joinWords(group.map((w) => w.text)),
          confidence,
          words: group,
        });
      }
      continue;
    }
    out.push({
      start_ms: start,
      end_ms: Math.min(end, Math.round(pieceEndMs)),
      text,
      confidence,
      ...(inside.length > 0 ? { words: inside } : {}),
    });
  }
  if (out.length === 0 && (payload.text ?? '').trim() && pieceEndMs > pieceStartMs) {
    out.push({
      start_ms: Math.round(pieceStartMs),
      end_ms: Math.round(pieceEndMs),
      text: payload.text!.trim(),
      confidence: 0.3,
    });
  }
  return out;
}

function splitOnPauses<T extends { start_ms: number; end_ms: number }>(words: T[]): T[][] {
  const groups: T[][] = [];
  for (const word of words) {
    const last = groups.at(-1)?.at(-1);
    if (!last || word.start_ms - last.end_ms > SPLIT_PAUSE_MS) groups.push([word]);
    else groups.at(-1)!.push(word);
  }
  return groups;
}

/**
 * Words as text: a space between two that are both written with spaces
 * (English), none where either is not (Japanese). A server returns words
 * without the spacing the segment's text had.
 */
export function joinWords(words: readonly string[]): string {
  let text = '';
  for (const word of words) {
    if (!word) continue;
    const spaced = /[A-Za-z0-9.,!?;:'")\]]$/.test(text) && /^[A-Za-z0-9("'[]/.test(word);
    text += (spaced ? ' ' : '') + word;
  }
  return text;
}

/** A pause at least this long ends an utterance; the Whisper path splits the same way. */
export const SPLIT_PAUSE_MS = 2_000;
/** Speech kept either side of a stretch, so its first and last sounds are whole. */
const PIECE_PADDING_MS = 250;
const HOP_MS = 100;

interface AudioPiece {
  startMs: number;
  endMs: number;
}

/**
 * The prepared WAV, read for cutting: its format, its loudness every 100 ms,
 * and any stretch of it as a WAV of its own.
 */
export class WavAudio {
  readonly totalMs: number;
  private readonly header: ReturnType<typeof readWavHeader>;
  private readonly bytesPerMs: number;
  private readonly frameBytes: number;
  private levels: number[] | undefined;

  constructor(private readonly path: string) {
    this.header = readWavHeader(path);
    this.frameBytes = (this.header.channels * this.header.bitsPerSample) / 8;
    this.bytesPerMs = (this.header.sampleRate * this.frameBytes) / 1000;
    this.totalMs = this.header.dataLength / this.bytesPerMs;
  }

  private rms(): number[] {
    this.levels ??= computeHopStatistics(this.path, HOP_MS).rmsDb;
    return this.levels;
  }

  /**
   * The stretches with sound in them, split wherever the sound stops for
   * {@link SPLIT_PAUSE_MS} or more.
   *
   * Quiet is relative to the recording: within 10 dB of its own floor (its
   * tenth-quietest percent), and never louder than -30 dBFS. A room's hiss is
   * quiet on any microphone; a voice is not. A file that is quiet throughout
   * gives nothing, and nothing is sent.
   */
  voiced(): [number, number][] {
    const rms = this.rms();
    const finite = rms.filter((level) => Number.isFinite(level)).sort((a, b) => a - b);
    const floor = finite.length > 0 ? finite[Math.floor(finite.length * 0.1)]! : -120;
    const threshold = Math.min(-30, floor + 10);
    const loud = rms.map((level) => Number.isFinite(level) && level >= threshold);
    const minPause = SPLIT_PAUSE_MS / HOP_MS;
    const stretches: [number, number][] = [];
    let start: number | undefined;
    let quietRun = 0;
    for (let i = 0; i <= loud.length; i++) {
      if (i < loud.length && loud[i]) {
        start ??= i;
        quietRun = 0;
        continue;
      }
      if (start === undefined) continue;
      quietRun++;
      if (quietRun >= minPause || i === loud.length) {
        stretches.push([start * HOP_MS, (i - quietRun + 1) * HOP_MS]);
        start = undefined;
        quietRun = 0;
      }
    }
    return stretches.map(([from, to]) => [
      Math.max(0, from - PIECE_PADDING_MS),
      Math.min(this.totalMs, to + PIECE_PADDING_MS),
    ]);
  }

  /**
   * The stretches as uploads no larger than `maxBytes`: a stretch too long for
   * one is cut at the quietest 100 ms in the last tenth of each allowance — a
   * pause between words rather than the middle of one.
   */
  pieces(stretches: readonly [number, number][], maxBytes: number): AudioPiece[] {
    const limitMs = Math.floor((maxBytes - 64) / this.bytesPerMs);
    const out: AudioPiece[] = [];
    for (const [from, to] of stretches) {
      let at = from;
      while (to - at > limitMs) {
        if (this.header.audioFormat !== 1) {
          throw new EditorialError(
            'perception_failed',
            `${this.path} is larger than the transcription server takes, and not PCM, so it cannot be split`,
          );
        }
        const rms = this.rms();
        let best = at + limitMs;
        let quietest = Infinity;
        for (
          let t = Math.ceil((at + limitMs * 0.9) / HOP_MS) * HOP_MS;
          t + HOP_MS <= at + limitMs;
          t += HOP_MS
        ) {
          const level = rms[t / HOP_MS] ?? Infinity;
          if (level < quietest) {
            quietest = level;
            best = t;
          }
        }
        out.push({ startMs: at, endMs: best });
        at = best;
      }
      if (to > at) out.push({ startMs: at, endMs: to });
    }
    return out;
  }

  /** One piece as a WAV file of its own, in the same format. */
  wav(piece: AudioPiece): Buffer {
    const align = (ms: number) =>
      Math.min(
        this.header.dataLength,
        Math.round((ms * this.bytesPerMs) / this.frameBytes) * this.frameBytes,
      );
    const startByte = align(piece.startMs);
    const endByte = align(piece.endMs);
    if (startByte === 0 && endByte === this.header.dataLength) {
      return readFileSync(this.path);
    }
    const data = Buffer.alloc(Math.max(0, endByte - startByte));
    const fd = openSync(this.path, 'r');
    try {
      readSync(fd, data, 0, data.length, this.header.dataOffset + startByte);
    } finally {
      closeSync(fd);
    }
    return Buffer.concat([wavHeader(this.header, data.length), data]);
  }
}

/** A 44-byte PCM WAV header for `dataBytes` of the given format. */
function wavHeader(
  format: { channels: number; sampleRate: number; bitsPerSample: number },
  dataBytes: number,
): Buffer {
  const header = Buffer.alloc(44);
  const blockAlign = (format.channels * format.bitsPerSample) / 8;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(format.sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(format.bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/**
 * A transcription server for the languages it handles, and another model for
 * the rest.
 *
 * Phonon-2 is English-only; the footage this project was first built for is
 * Japanese. Routed by the project's language (`editing_goal.language` in
 * context.yaml), which is what every transcription request carries: English to
 * the server, everything else to the fallback (the Python worker's Whisper).
 * An unset language is not guessed to be English — a wrong-language transcript
 * is worse than none, because judgement reads it as what was said.
 */
export class LanguageRoutedSpeechModel implements SpeechModel {
  readonly identity: ModelIdentity;

  constructor(
    private readonly primary: OpenAiCompatibleSpeechModel,
    private readonly fallback?: SpeechModel,
  ) {
    const languages = primary.languages.join(',');
    this.identity = {
      backend: 'language-routed',
      model: `${primary.identity.model} (${languages}) / ${fallback?.identity.model ?? 'none'}`,
      locality:
        primary.identity.locality === 'remote_api' || fallback?.identity.locality === 'remote_api'
          ? 'remote_api'
          : 'local',
      mediaLeavesDevice:
        primary.identity.mediaLeavesDevice || fallback?.identity.mediaLeavesDevice === true,
      parameters: {
        primary: primary.identity.parameters ?? {},
        languages,
        fallback: fallback?.identity.backend ?? 'none',
      },
    };
  }

  async transcribe(params: Parameters<SpeechModel['transcribe']>[0]): Promise<TranscribeResult> {
    if (this.primary.handles(params.language)) return this.primary.transcribe(params);
    if (this.fallback) return this.fallback.transcribe(params);
    const languages = this.primary.languages.join(', ');
    throw new EditorialError(
      'perception_failed',
      params.language
        ? `${this.primary.identity.model} transcribes ${languages} only, and this project is in ${params.language}`
        : `${this.primary.identity.model} transcribes ${languages} only; set editing_goal.language in context.yaml (for example "en") to use it`,
    );
  }
}
