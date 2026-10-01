import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  LanguageRoutedSpeechModel,
  OpenAiCompatibleSpeechModel,
  joinWords,
  languagesFor,
  type SpeechModel,
} from '../src/index.js';

/**
 * Transcription from a server speaking OpenAI's /audio/transcriptions: Phonon-2
 * behind `phonon serve`, a Whisper server, a hosted API.
 *
 * The servers are stand-ins answering the way the real ones were measured to:
 * Phonon-2 with one segment per request and no word times, a Whisper server
 * with word times, a server that answers only text.
 */

const dir = mkdtempSync(join(tmpdir(), 'oea-speech-'));
const RATE = 16_000;

/** A 16 kHz mono WAV: a tone over each [startMs, endMs), digital silence elsewhere. */
function wav(name: string, totalMs: number, voiced: [number, number][]): string {
  const samples = Math.round((totalMs * RATE) / 1000);
  const data = Buffer.alloc(samples * 2);
  for (const [from, to] of voiced) {
    for (let i = Math.round((from * RATE) / 1000); i < Math.round((to * RATE) / 1000); i++) {
      data.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / RATE)), i * 2);
    }
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  const path = join(dir, name);
  writeFileSync(path, Buffer.concat([header, data]));
  return path;
}

/** The length of the audio a request uploaded, from its WAV header. */
async function uploadedMs(body: FormData): Promise<number> {
  const file = body.get('file') as Blob;
  const bytes = Buffer.from(await file.arrayBuffer());
  return (bytes.readUInt32LE(40) / (RATE * 2)) * 1000;
}

const params = (audio_path: string, language?: string) => ({
  audio_path,
  ...(language ? { language } : {}),
  vocabulary: [],
  word_timestamps: true,
  diarize: false,
});

function server(answer: (body: FormData, call: number) => Promise<Response> | Response) {
  let call = 0;
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
    answer(init!.body as FormData, call++),
  );
}

describe('a server that gives segment times and no word times (Phonon-2)', () => {
  it('sends the speech a stretch at a time, so a pause ends an utterance', async () => {
    // 3.5 s of speech, 4 s of silence, 6 s of speech: measured, Phonon-2 gave
    // this back as one utterance from 0 to 13.7 s around the silence.
    const path = wav('pause.wav', 13_500, [
      [0, 3_500],
      [7_500, 13_500],
    ]);
    const uploads: number[] = [];
    const fetchImpl = server(async (body) => {
      const ms = await uploadedMs(body);
      uploads.push(Math.round(ms));
      const seconds = ms / 1000;
      return Response.json({
        text: `heard ${Math.round(ms)}`,
        segments: [{ id: 0, start: 0, end: seconds, text: `heard ${Math.round(ms)}` }],
      });
    });
    const model = new OpenAiCompatibleSpeechModel({
      baseUrl: 'http://localhost:8010/v1',
      model: 'phonon-2',
      fetchImpl,
    });
    const result = await model.transcribe(params(path, 'en'));

    // Once whole, to learn it gives no word times; then once per stretch.
    expect(uploads).toEqual([13_500, 3_750, 6_250]);
    expect(result.utterances.map((u) => [u.start_ms, u.end_ms])).toEqual([
      [0, 3_750],
      [7_250, 13_500],
    ]);

    // The next file goes straight to stretches: nothing is sent twice again.
    uploads.length = 0;
    await model.transcribe(params(path, 'en'));
    expect(uploads).toEqual([3_750, 6_250]);
  });

  it('sends nothing for a file with no sound in it', async () => {
    const path = wav('silent.wav', 5_000, []);
    const fetchImpl = server(() =>
      Response.json({ text: 'hello', segments: [{ start: 0, end: 1, text: 'hello' }] }),
    );
    const model = new OpenAiCompatibleSpeechModel({
      baseUrl: 'http://localhost:8010/v1',
      model: 'phonon-2',
      fetchImpl,
    });
    // Learn the server first.
    await model.transcribe(params(wav('voice.wav', 2_000, [[0, 2_000]]), 'en'));
    fetchImpl.mockClear();
    expect((await model.transcribe(params(path, 'en'))).utterances).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('a server that gives word times (a Whisper server)', () => {
  it('splits a segment where its own words pause, and keeps the words', async () => {
    const path = wav('words.wav', 8_000, [[0, 8_000]]);
    const fetchImpl = server(() =>
      Response.json({
        text: 'Good morning. Let us go.',
        segments: [{ start: 0, end: 7.5, text: 'Good morning. Let us go.', avg_logprob: -0.2 }],
        words: [
          { word: 'Good', start: 0.1, end: 0.4 },
          { word: 'morning.', start: 0.5, end: 1.0 },
          { word: 'Let', start: 5.0, end: 5.2 },
          { word: 'us', start: 5.3, end: 5.4 },
          { word: 'go.', start: 5.5, end: 5.9 },
        ],
      }),
    );
    const model = new OpenAiCompatibleSpeechModel({
      baseUrl: 'https://api.example.com/v1',
      model: 'whisper-1',
      fetchImpl,
    });
    const result = await model.transcribe(params(path, 'en-US'));
    expect(result.utterances.map((u) => [u.start_ms, u.end_ms, u.text])).toEqual([
      [100, 1_000, 'Good morning.'],
      [5_000, 5_900, 'Let us go.'],
    ]);
    expect(result.utterances[0]!.confidence).toBeCloseTo(0.8);
    // One request: word times say where the pauses are.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const sent = fetchImpl.mock.calls[0]![1]!.body as FormData;
    expect(sent.get('language')).toBe('en');
    expect(sent.getAll('timestamp_granularities[]')).toEqual(['segment', 'word']);
    // And it is media leaving the machine, said so.
    expect(model.identity.mediaLeavesDevice).toBe(true);
  });
});

describe('a server that answers only text', () => {
  it('is asked its way after refusing the verbose form, and the text covers its stretch', async () => {
    const path = wav('text.wav', 4_000, [[0, 4_000]]);
    const fetchImpl = server((body) =>
      body.get('response_format') === 'verbose_json'
        ? new Response('{"error":{"message":"response_format verbose_json is not supported"}}', {
            status: 400,
          })
        : Response.json({ text: 'hello there' }),
    );
    const model = new OpenAiCompatibleSpeechModel({
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-transcribe',
      fetchImpl,
    });
    const result = await model.transcribe(params(path, 'en'));
    expect(result.utterances).toEqual([
      { start_ms: 0, end_ms: 4_000, text: 'hello there', confidence: 0.3 },
    ]);
  });
});

describe('a file larger than the server takes', () => {
  it('is cut at the quietest moment near each limit, and put back on the file’s clock', async () => {
    // 10 s with a half-second gap at 8.5 s; the limit allows about 9.3 s.
    const path = wav('long.wav', 10_000, [
      [0, 8_500],
      [9_000, 10_000],
    ]);
    const starts: number[] = [];
    const fetchImpl = server(async (body) => {
      const ms = await uploadedMs(body);
      starts.push(Math.round(ms));
      return Response.json({
        text: 'x',
        segments: [{ start: 0, end: ms / 1000, text: 'x' }],
        words: [{ word: 'x', start: 0, end: ms / 1000 }],
      });
    });
    const model = new OpenAiCompatibleSpeechModel({
      baseUrl: 'https://api.example.com/v1',
      model: 'whisper-1',
      maxBytes: 300_000,
      fetchImpl,
    });
    const result = await model.transcribe(params(path, 'en'));
    expect(starts).toEqual([8_500, 1_500]);
    expect(result.utterances.map((u) => u.start_ms)).toEqual([0, 8_500]);
  });
});

describe('routing by language', () => {
  const phonon = new OpenAiCompatibleSpeechModel({
    baseUrl: 'http://localhost:8010/v1',
    model: 'phonon-2',
    languages: languagesFor('phonon-2'),
    fetchImpl: server(() => Response.json({ text: 'english', segments: [] })),
  });
  const whisperTranscribe = vi.fn(async () => ({ model: 'base', utterances: [] }));
  const whisper: SpeechModel = {
    identity: {
      backend: 'worker',
      model: 'base/int8',
      locality: 'local',
      mediaLeavesDevice: false,
    },
    transcribe: whisperTranscribe,
  };

  it('knows Phonon-2 is English-only, and reads a configured list', () => {
    expect(languagesFor('phonon-2')).toEqual(['en']);
    expect(languagesFor('whisper-1')).toEqual([]);
    expect(languagesFor('anything', 'en-US, ja')).toEqual(['en', 'ja']);
  });

  it('sends English to the server and everything else to the fallback', async () => {
    const routed = new LanguageRoutedSpeechModel(phonon, whisper);
    const path = wav('route.wav', 1_000, [[0, 1_000]]);
    await routed.transcribe(params(path, 'ja'));
    expect(whisperTranscribe).toHaveBeenCalledTimes(1);
    // An unknown language is not guessed to be English.
    await routed.transcribe(params(path));
    expect(whisperTranscribe).toHaveBeenCalledTimes(2);
    // The identity names both, so a cached transcript is never served across them.
    expect(routed.identity.model).toBe('phonon-2 (en) / base/int8');
  });

  it('says how to use it when there is no fallback', async () => {
    const routed = new LanguageRoutedSpeechModel(phonon);
    const path = wav('route2.wav', 1_000, [[0, 1_000]]);
    await expect(routed.transcribe(params(path, 'ja'))).rejects.toThrow(
      /phonon-2 transcribes en only, and this project is in ja/,
    );
    await expect(routed.transcribe(params(path))).rejects.toThrow(/editing_goal\.language/);
  });
});

describe('joinWords', () => {
  it('puts spaces between English words and none between Japanese ones', () => {
    expect(joinWords(['Good', 'morning.', 'Let', 'us', 'go.'])).toBe('Good morning. Let us go.');
    expect(joinWords(['そろそろ', '出発', 'しよう'])).toBe('そろそろ出発しよう');
  });
});
