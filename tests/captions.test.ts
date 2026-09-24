import { describe, expect, it } from 'vitest';
import { CAPTION_RULES, buildCaptions, wrapCaption } from '@editorial-ir/agent';
import {
  ObservationTimeline,
  operationTimelineEnd,
  type EditorialIR,
  type TextOperation,
  type Utterance,
} from '@editorial-ir/contracts';
import { makeAsset, makeIR } from './support/ir.js';
import { makePlan, type OperationSpec } from './support/plan.js';

/**
 * Captions: what is said, where it is heard in the cut.
 *
 * The transcript is in source time and a caption is in timeline time, so every
 * test here is about the mapping between the two — and about the places it is
 * easy to get wrong: a sentence that runs across a cut, a jump cut that took a
 * pause out of the middle of one, a cutaway whose sound is not heard, a line
 * too long to read.
 */

const CAMERA = makeAsset({
  id: 'asset_001',
  path: '/media/C0001.MP4',
  file_name: 'C0001.MP4',
  duration_ms: 120_000,
  audio_codec: 'aac',
  audio_channels: 2,
  audio_streams: [{ index: 0, codec: 'aac', channels: 2, sample_rate: 48_000 }],
});

const DRONE = makeAsset({
  id: 'asset_002',
  path: '/media/DJI_0042.MP4',
  file_name: 'DJI_0042.MP4',
  duration_ms: 120_000,
  audio_streams: [],
});

function irWith(extra: { subtitledEvent?: string } = {}): EditorialIR {
  const ir = makeIR({
    events: [
      { id: 'evt_0001', start_ms: 0, duration_ms: 60_000 },
      { id: 'evt_0002', start_ms: 60_000, duration_ms: 60_000 },
    ],
    assets: [CAMERA, DRONE],
  });
  if (!extra.subtitledEvent) return ir;
  return {
    ...ir,
    events: ir.events.map((event) =>
      event.id === extra.subtitledEvent
        ? { ...event, observed: { ...event.observed, subtitles: ['burned in'] } }
        : event,
    ),
  };
}

let nextUtterance = 1;
function utterance(
  start: number,
  end: number,
  text: string,
  words?: [number, number, string][],
  asset = 'asset_001',
): Utterance {
  return {
    id: `utt_${String(nextUtterance++).padStart(5, '0')}`,
    asset_id: asset,
    start_ms: start,
    end_ms: end,
    text,
    confidence: 0.9,
    ...(words ? { words: words.map(([s, e, t]) => ({ start_ms: s, end_ms: e, text: t })) } : {}),
  };
}

function observations(utterances: Utterance[]): ObservationTimeline {
  return ObservationTimeline.parse({
    project_id: 'prj_test',
    pipeline_version: 'test',
    generated_at: '2026-09-24T00:00:00.000Z',
    utterances,
  });
}

function captionsFor(
  operations: OperationSpec[],
  utterances: Utterance[],
  ir: EditorialIR = irWith(),
  notes: string[] = [],
): TextOperation[] {
  return buildCaptions(makePlan(operations), ir, observations(utterances), { notes });
}

describe('captions, from source time to the cut', () => {
  it('moves each word to where its clip sits on the timeline', () => {
    // Said at 10.5 s in the file; the clip starting at 10 s sits at 4 s in the cut.
    const captions = captionsFor(
      [
        {
          source_asset_id: 'asset_001',
          source_in_ms: 10_000,
          source_out_ms: 14_000,
          timeline_start_ms: 4000,
        },
      ],
      [
        utterance(10_500, 12_000, 'We made it to the harbour', [
          [10_500, 10_700, 'We'],
          [10_700, 11_000, 'made'],
          [11_000, 11_200, 'it'],
          [11_200, 11_400, 'to'],
          [11_400, 11_600, 'the'],
          [11_600, 12_000, 'harbour'],
        ]),
      ],
    );
    expect(captions).toHaveLength(1);
    expect(captions[0]).toMatchObject({
      kind: 'caption',
      timeline_start_ms: 4500,
      text: 'We made it to the harbour',
      provenance: 'agent_derived',
    });
    expect(captions[0]!.timeline_end_ms).toBe(6000);
  });

  it('never lets a caption run across a cut into the next clip', () => {
    // One sentence from 10 s to 13 s, and the cut takes 10–11.5 s and then
    // jumps to a different part of the file. The second clip is another
    // moment; the sentence's second half is not in the cut at all.
    const captions = captionsFor(
      [
        {
          source_asset_id: 'asset_001',
          source_in_ms: 10_000,
          source_out_ms: 11_500,
          timeline_start_ms: 0,
        },
        {
          source_asset_id: 'asset_001',
          source_in_ms: 40_000,
          source_out_ms: 42_000,
          timeline_start_ms: 1500,
        },
      ],
      [
        utterance(10_000, 13_000, 'this is the longest pier in the country', [
          [10_000, 10_300, 'this'],
          [10_300, 10_500, 'is'],
          [10_500, 10_700, 'the'],
          [10_700, 11_200, 'longest'],
          [11_200, 11_450, 'pier'],
          [11_600, 11_800, 'in'],
          [11_800, 12_000, 'the'],
          [12_000, 13_000, 'country'],
        ]),
        utterance(40_200, 41_500, 'look at that', [
          [40_200, 40_500, 'look'],
          [40_500, 40_800, 'at'],
          [40_800, 41_500, 'that'],
        ]),
      ],
    );
    expect(captions.map((c) => c.text)).toEqual(['this is the longest pier…', 'look at that']);
    expect(captions[0]!.timeline_end_ms).toBeLessThanOrEqual(1500);
    expect(captions[1]!.timeline_start_ms).toBeGreaterThanOrEqual(1500);
  });

  it('follows the pieces of a jump cut, without waiting for the pause that was taken out', () => {
    // "we walked all morning … and then it rained", with a 3 s pause between
    // the two halves removed: the second piece starts right after the first.
    const words: [number, number, string][] = [
      [20_000, 20_300, 'we'],
      [20_300, 20_700, 'walked'],
      [20_700, 20_900, 'all'],
      [20_900, 21_500, 'morning'],
      [24_500, 24_700, 'and'],
      [24_700, 24_900, 'then'],
      [24_900, 25_000, 'it'],
      [25_000, 25_600, 'rained'],
    ];
    const captions = captionsFor(
      [
        {
          source_asset_id: 'asset_001',
          source_in_ms: 20_000,
          source_out_ms: 21_600,
          timeline_start_ms: 0,
        },
        {
          source_asset_id: 'asset_001',
          source_in_ms: 24_400,
          source_out_ms: 25_800,
          timeline_start_ms: 1600,
          continues_previous: true,
        },
      ],
      [utterance(20_000, 25_600, 'we walked all morning and then it rained', words)],
    );
    // Each piece shows what it plays; neither carries an ellipsis, because the
    // sentence is not cut off, it goes on in the next caption.
    expect(captions.map((c) => c.text)).toEqual(['we walked all morning', 'and then it rained']);
    // "and" is said 100 ms into the second piece: at 1.7 s in the cut, not at
    // the 4.5 s it would be if the removed pause were still being waited for.
    expect(captions[1]!.timeline_start_ms).toBe(1700);
    expect(captions[0]!.timeline_end_ms).toBeLessThanOrEqual(captions[1]!.timeline_start_ms);
  });

  it('captions only sound the cut plays', () => {
    const say = utterance(10_000, 11_000, 'hello there');
    const cutaway = captionsFor(
      [
        {
          source_asset_id: 'asset_001',
          source_in_ms: 9000,
          source_out_ms: 12_000,
          timeline_start_ms: 0,
          use_source_audio: false,
        },
      ],
      [say],
    );
    expect(cutaway).toHaveLength(0);

    // A drone clip has no sound at all, whatever the transcript of another
    // file sharing its times says.
    const drone = captionsFor(
      [
        {
          source_asset_id: 'asset_002',
          source_in_ms: 9000,
          source_out_ms: 12_000,
          timeline_start_ms: 0,
        },
      ],
      [utterance(10_000, 11_000, 'hello there', undefined, 'asset_002')],
    );
    expect(drone).toHaveLength(0);
  });

  it('captions a clip only when it plays the stream the transcript was made from', () => {
    // A camera with room tone on stream 0 and a lavalier on stream 1: the
    // speech was transcribed from stream 1.
    const LAV = makeAsset({
      id: 'asset_003',
      path: '/media/C0007.MP4',
      file_name: 'C0007.MP4',
      duration_ms: 60_000,
      audio_streams: [
        { index: 0, codec: 'aac', channels: 2, sample_rate: 48_000 },
        { index: 1, codec: 'aac', channels: 1, sample_rate: 48_000 },
      ],
    });
    const ir = makeIR({ events: [], assets: [LAV] });
    const timeline = ObservationTimeline.parse({
      project_id: 'prj_test',
      pipeline_version: 'test',
      generated_at: '2026-09-24T00:00:00.000Z',
      utterances: [utterance(1000, 2500, 'testing the lavalier', undefined, 'asset_003')],
      audio_profiles: [{ asset_id: 'asset_003', hop_ms: 100, rms_db: [-20, -20], stream_index: 1 }],
    });
    const on = (stream: number | undefined) =>
      makePlan([
        {
          source_asset_id: 'asset_003',
          source_in_ms: 0,
          source_out_ms: 4000,
          timeline_start_ms: 0,
          ...(stream === undefined ? {} : { audio_stream_index: stream }),
        },
      ]);

    expect(buildCaptions(on(1), ir, timeline).map((c) => c.text)).toEqual(['testing the lavalier']);
    // Playing the room tone, the words are not heard, and a caption would say
    // they were.
    const notes: string[] = [];
    expect(buildCaptions(on(undefined), ir, timeline, { notes })).toEqual([]);
    expect(notes.join(' ')).toMatch(/plays stream 0 of C0007\.MP4; the transcript is of stream 1/);
  });

  it('leaves a clip with subtitles already in the picture alone, and says so', () => {
    const notes: string[] = [];
    const captions = captionsFor(
      [
        {
          source_asset_id: 'asset_001',
          event_id: 'evt_0001',
          source_in_ms: 9000,
          source_out_ms: 12_000,
          timeline_start_ms: 0,
        },
      ],
      [utterance(10_000, 11_000, 'hello there')],
      irWith({ subtitledEvent: 'evt_0001' }),
      notes,
    );
    expect(captions).toHaveLength(0);
    expect(notes.join(' ')).toMatch(/already show subtitles/);
  });

  it('says why there are none when there is no transcript', () => {
    const notes: string[] = [];
    const captions = buildCaptions(
      makePlan([
        {
          source_asset_id: 'asset_001',
          source_in_ms: 0,
          source_out_ms: 4000,
          timeline_start_ms: 0,
        },
      ]),
      irWith(),
      undefined,
      { notes },
    );
    expect(captions).toEqual([]);
    expect(notes).toEqual(['there is no transcript to caption from']);
  });
});

describe('captions a person can read', () => {
  it('keeps a short word up long enough to read, but never past the next caption or the cut', () => {
    const captions = captionsFor(
      [
        {
          source_asset_id: 'asset_001',
          source_in_ms: 0,
          source_out_ms: 3000,
          timeline_start_ms: 0,
        },
      ],
      [
        utterance(500, 700, 'Yes.', [[500, 700, 'Yes.']]),
        utterance(1800, 2000, 'No.', [[1800, 2000, 'No.']]),
        utterance(2600, 2750, 'Go!', [[2600, 2750, 'Go!']]),
      ],
    );
    expect(captions.map((c) => c.text)).toEqual(['Yes.', 'No.', 'Go!']);
    // 200 ms of speech shown for the minimum, into the silence after it.
    expect(captions[0]!.timeline_end_ms - captions[0]!.timeline_start_ms).toBe(
      CAPTION_RULES.minDisplayMs,
    );
    // Held until the next caption begins, and no further.
    expect(captions[1]!.timeline_end_ms).toBe(2600);
    // The last is cut off by the end of its clip rather than running into
    // whatever follows it.
    expect(captions[2]!.timeline_end_ms).toBe(3000);
  });

  it('joins a word to the caption before it only when there is no room to show it alone', () => {
    // "Go!" is said 50 ms before the clip ends: on its own it would be up for
    // a sixth of a second, which is a flicker, not a caption.
    const captions = captionsFor(
      [
        {
          source_asset_id: 'asset_001',
          source_in_ms: 0,
          source_out_ms: 3000,
          timeline_start_ms: 0,
        },
      ],
      [
        utterance(1800, 2000, 'No.', [[1800, 2000, 'No.']]),
        utterance(2850, 2950, 'Go!', [[2850, 2950, 'Go!']]),
      ],
    );
    expect(captions.map((c) => c.text)).toEqual(['No. Go!']);
    expect(captions[0]!.timeline_end_ms).toBe(3000);
  });

  it('never shows two captions at once', () => {
    const say = (start: number, text: string): Utterance =>
      utterance(start, start + 1500, text, [[start, start + 1500, text]]);
    const captions = captionsFor(
      [
        {
          source_asset_id: 'asset_001',
          source_in_ms: 0,
          source_out_ms: 10_000,
          timeline_start_ms: 0,
        },
        // A second clip on V2 whose own sound is heard over the first.
        {
          source_asset_id: 'asset_001',
          source_in_ms: 30_000,
          source_out_ms: 33_000,
          timeline_start_ms: 2000,
          track: 1,
        },
      ],
      [say(1000, 'first'), say(2500, 'second'), say(30_000, 'third')],
    );
    const sorted = [...captions].sort((a, b) => a.timeline_start_ms - b.timeline_start_ms);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.timeline_start_ms).toBeGreaterThanOrEqual(sorted[i - 1]!.timeline_end_ms);
    }
  });

  it('starts a new caption at a pause and at the end of a sentence', () => {
    const captions = captionsFor(
      [
        {
          source_asset_id: 'asset_001',
          source_in_ms: 0,
          source_out_ms: 10_000,
          timeline_start_ms: 0,
        },
      ],
      [
        utterance(1000, 6000, 'It was cold. We stayed anyway because the light', [
          [1000, 1200, 'It'],
          [1200, 1400, 'was'],
          [1400, 1800, 'cold.'],
          [1900, 2100, 'We'],
          [2100, 2500, 'stayed'],
          [2500, 2900, 'anyway'],
          // 1.5 s of nothing: the next phrase is its own caption.
          [4400, 4800, 'because'],
          [4800, 5000, 'the'],
          [5000, 5400, 'light'],
        ]),
      ],
    );
    expect(captions.map((c) => c.text)).toEqual([
      'It was cold.',
      'We stayed anyway',
      'because the light',
    ]);
  });

  it('holds Latin text to two lines of 42 characters, broken between words and balanced', () => {
    const lines = wrapCaption('We finally reached the lighthouse just before the sun went down');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(CAPTION_RULES.latinLineChars);
    // Balanced, not filled: the eye does not travel across the frame for two words.
    expect(Math.abs(lines[0]!.length - lines[1]!.length)).toBeLessThanOrEqual(10);
    expect(lines.join(' ')).toBe('We finally reached the lighthouse just before the sun went down');
  });

  it('holds Japanese to lines of 13 characters, breaking after punctuation and never before a closing mark', () => {
    const lines = wrapCaption('今日はすごく楽しかった、また一緒に来ようね。');
    expect(lines).toHaveLength(2);
    for (const line of lines)
      expect(Array.from(line).length).toBeLessThanOrEqual(CAPTION_RULES.cjkLineChars);
    // After the comma, where a reader expects the pause.
    expect(lines[0]).toBe('今日はすごく楽しかった、');
    for (const line of lines) expect(line).not.toMatch(/^[、。」）ッっゃゅょ]/u);
  });

  it('splits a caption that would need a third line into another caption', () => {
    const words =
      'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen'
        .split(' ')
        .map((text, i): [number, number, string] => [1000 + i * 300, 1000 + i * 300 + 250, text]);
    const captions = captionsFor(
      [
        {
          source_asset_id: 'asset_001',
          source_in_ms: 0,
          source_out_ms: 10_000,
          timeline_start_ms: 0,
        },
      ],
      [utterance(1000, 6200, words.map((w) => w[2]).join(' '), words)],
    );
    expect(captions.length).toBeGreaterThan(1);
    for (const caption of captions) {
      const lines = caption.text.split('\n');
      expect(lines.length).toBeLessThanOrEqual(CAPTION_RULES.maxLines);
      for (const line of lines)
        expect(line.length).toBeLessThanOrEqual(CAPTION_RULES.latinLineChars);
    }
    expect(captions.map((c) => c.text.replace(/\n/g, ' ')).join(' ')).toBe(
      words.map((w) => w[2]).join(' '),
    );
  });
});

describe('captions without word timings', () => {
  it('shows the whole sentence when a clip plays most of it, rather than breaking a word', () => {
    // The worked example: "来てよかった" said from 64.0 to 66.46 s and a clip
    // ending at 66.008 s. The characters' times are an estimate, and cutting
    // the text at the estimate wrote "来てよかっ".
    const captions = captionsFor(
      [
        {
          source_asset_id: 'asset_001',
          source_in_ms: 57_850,
          source_out_ms: 66_008,
          timeline_start_ms: 0,
        },
      ],
      [utterance(64_000, 66_460, '来てよかった')],
    );
    expect(captions.map((c) => c.text)).toEqual(['来てよかった']);
    // Shown over what is heard, and not past the end of the clip.
    expect(captions[0]!.timeline_start_ms).toBe(64_000 - 57_850);
    expect(captions[0]!.timeline_end_ms).toBe(66_008 - 57_850);
  });

  it('marks a sentence the cut mostly leaves out, instead of passing a fragment off as a sentence', () => {
    // Only the first quarter of the sentence is in the clip.
    const captions = captionsFor(
      [
        {
          source_asset_id: 'asset_001',
          source_in_ms: 0,
          source_out_ms: 11_000,
          timeline_start_ms: 0,
        },
      ],
      [utterance(10_000, 14_000, 'we should come back here next year')],
    );
    expect(captions).toHaveLength(1);
    expect(captions[0]!.text.endsWith('…')).toBe(true);
    expect(captions[0]!.text).not.toContain('year');
  });

  it('shares a sentence between the two pieces of a jump cut without repeating it', () => {
    const captions = captionsFor(
      [
        {
          source_asset_id: 'asset_001',
          source_in_ms: 10_000,
          source_out_ms: 12_000,
          timeline_start_ms: 0,
        },
        {
          source_asset_id: 'asset_001',
          source_in_ms: 12_000,
          source_out_ms: 14_000,
          timeline_start_ms: 2000,
          continues_previous: true,
        },
      ],
      [utterance(10_000, 14_000, 'one two three four five six seven eight')],
    );
    const words = captions.flatMap((c) => c.text.replace(/\n/g, ' ').split(' '));
    expect(words).toEqual(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']);
  });
});

describe('captions are deterministic', () => {
  it('writes the same captions every time', () => {
    const operations: OperationSpec[] = [
      { source_asset_id: 'asset_001', source_in_ms: 0, source_out_ms: 8000, timeline_start_ms: 0 },
      {
        source_asset_id: 'asset_001',
        source_in_ms: 20_000,
        source_out_ms: 26_000,
        timeline_start_ms: 8000,
      },
    ];
    const utterances = [
      utterance(1000, 3000, 'first thing'),
      utterance(21_000, 25_000, 'そろそろ出発しよう、みんな'),
    ];
    const a = captionsFor(operations, utterances);
    const b = captionsFor(operations, utterances);
    expect(a).toEqual(b);
    for (const caption of a) {
      const operation = makePlan(operations).tracks.video.find(
        (o) =>
          o.timeline_start_ms <= caption.timeline_start_ms &&
          caption.timeline_start_ms < operationTimelineEnd(o),
      )!;
      expect(caption.timeline_end_ms).toBeLessThanOrEqual(operationTimelineEnd(operation));
    }
  });
});
