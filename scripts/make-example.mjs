/**
 * Generates the worked example that `oea demo` and the end-to-end tests use.
 *
 * The example is a replay fixture, not real footage. The files under `footage/`
 * are stand-ins whose only job is to have a stable content hash; every
 * observation the pipeline would have produced from real media — the transcript,
 * the shots, the silences — is written out in `perception.fixture.json`.
 *
 * That makes the whole pipeline runnable, and reproducible, on a machine with no
 * ffmpeg, no GPU and no network. It is also how the compiler is regression
 * tested: freeze the perception and a change to segmentation, scoring or
 * planning shows up as a difference in the result rather than as noise from a
 * model that answers slightly differently each time.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../examples/anniversary-trip/', import.meta.url).pathname;
mkdirSync(join(root, 'footage'), { recursive: true });

/** A day in Osaka, in three recordings. */
const SCRIPT = [
  {
    file: 'IMG_1001.MOV',
    created: '2026-05-16T08:12:04.000Z',
    durationMs: 9 * 60_000,
    beats: [
      {
        at: 0,
        len: 22_000,
        labels: ['hotel_room', 'suitcase'],
        speech: ['そろそろ出発しよう'],
        type: 'departure',
      },
      {
        at: 24_000,
        len: 31_000,
        labels: ['hotel_lobby', 'two_people'],
        speech: ['今日はUSJだね', '楽しみすぎる'],
      },
      { at: 58_000, len: 46_000, labels: ['street', 'morning_light'], speech: [] },
      {
        at: 108_000,
        len: 58_000,
        labels: ['train_platform', 'crowd'],
        speech: ['電車混んでるね'],
        audio: ['crowd'],
      },
      {
        at: 170_000,
        len: 74_000,
        labels: ['train_interior', 'window'],
        speech: ['あと10分くらい'],
        audio: ['crowd'],
      },
      { at: 248_000, len: 38_000, labels: ['train_window', 'city'], speech: [] },
      {
        at: 290_000,
        len: 52_000,
        labels: ['station_exit', 'signage'],
        speech: ['こっちだって'],
        ocr: ['ユニバーサルシティ駅'],
      },
      {
        at: 346_000,
        len: 64_000,
        labels: ['walkway', 'two_people'],
        speech: ['もう見えてきた'],
        audio: ['crowd'],
      },
      {
        at: 414_000,
        len: 66_000,
        labels: ['theme_park_gate', 'two_people', 'smiling'],
        speech: ['やっと着いた！', 'ここまで長かったね'],
        audio: ['crowd', 'laughter'],
        ocr: ['UNIVERSAL STUDIOS JAPAN'],
        type: 'arrival',
      },
      { at: 484_000, len: 56_000, labels: ['entrance', 'ticket_gate'], speech: ['チケット出して'] },
    ],
  },
  {
    file: 'IMG_1002.MOV',
    created: '2026-05-16T11:41:22.000Z',
    durationMs: 11 * 60_000,
    beats: [
      {
        at: 0,
        len: 44_000,
        labels: ['ride_queue', 'crowd'],
        speech: ['待ち時間90分だって'],
        audio: ['crowd'],
      },
      {
        at: 48_000,
        len: 62_000,
        labels: ['ride', 'two_people'],
        speech: ['うわ、すごい！'],
        audio: ['cheering'],
        type: 'reaction',
      },
      {
        at: 114_000,
        len: 38_000,
        labels: ['ride_exit', 'smiling'],
        speech: ['もう一回乗りたい'],
        audio: ['laughter'],
      },
      {
        at: 156_000,
        len: 71_000,
        labels: ['food_stall', 'street_food'],
        speech: ['お腹すいた', 'これ食べよう'],
        type: 'meal',
      },
      {
        at: 231_000,
        len: 83_000,
        labels: ['restaurant', 'ramen', 'table'],
        speech: ['このラーメン美味しい', '大阪に来た感じするね'],
        type: 'meal',
      },
      { at: 318_000, len: 40_000, labels: ['restaurant', 'ramen'], speech: [], type: 'meal' },
      {
        at: 362_000,
        len: 57_000,
        labels: ['park_street', 'shops'],
        speech: ['お土産見ていこう'],
        audio: ['crowd'],
      },
      {
        at: 423_000,
        len: 49_000,
        labels: ['souvenir_shop', 'shelves'],
        speech: ['これかわいい'],
        ocr: ['SHOP'],
      },
      {
        at: 476_000,
        len: 68_000,
        labels: ['show_stage', 'crowd'],
        speech: [],
        audio: ['music', 'applause'],
      },
      {
        at: 548_000,
        len: 45_000,
        labels: ['show_stage', 'two_people', 'smiling'],
        speech: ['最高だった'],
        audio: ['applause', 'laughter'],
        type: 'reaction',
      },
      {
        at: 597_000,
        len: 63_000,
        labels: ['park_street', 'evening_light'],
        speech: ['そろそろ暗くなってきたね'],
      },
    ],
  },
  {
    file: 'IMG_1003.MOV',
    created: '2026-05-16T18:52:10.000Z',
    durationMs: 7 * 60_000,
    beats: [
      {
        at: 0,
        len: 52_000,
        labels: ['observation_deck', 'night_view', 'city_lights'],
        speech: [],
        type: 'b_roll',
      },
      {
        at: 56_000,
        len: 74_000,
        labels: ['night_view', 'two_people'],
        speech: ['きれいだね', '来てよかった'],
        audio: ['wind'],
      },
      { at: 134_000, len: 46_000, labels: ['night_view', 'city_lights'], speech: [] },
      {
        at: 184_000,
        len: 88_000,
        labels: ['two_people', 'night_view', 'smiling'],
        speech: ['一年、早かったね', 'また来ようね'],
        audio: ['laughter'],
        type: 'farewell',
      },
      {
        at: 276_000,
        len: 51_000,
        labels: ['night_view', 'city_lights'],
        speech: [],
        type: 'b_roll',
      },
      { at: 331_000, len: 42_000, labels: ['station', 'night'], speech: ['帰ろうか'] },
      { at: 377_000, len: 43_000, labels: ['train_interior', 'night'], speech: [], type: 'b_roll' },
    ],
  },
];

const fixture = { assets: {}, describe: {} };

for (const asset of SCRIPT) {
  // A stand-in file. Its only job is to hash to something stable.
  writeFileSync(
    join(root, 'footage', asset.file),
    `placeholder for ${asset.file}\nThis example replays recorded perception; see README.md.\n`,
  );

  const shots = [];
  const utterances = [];
  const audioEvents = [];
  const ocr = [];
  const frames = [];

  /**
   * A stand-in for a vision embedding.
   *
   * Derived from the labels by hashing, so two shots of the night view land near
   * each other and a shot of ramen does not. It is not a real vision model and
   * does not pretend to be; what it does is exercise the visual path — frame
   * similarity in segmentation, the visual aspect of the index — with something
   * that behaves plausibly and identically on every machine.
   */
  const labelVector = (labels) => {
    const vector = new Array(64).fill(0);
    for (const label of labels) {
      let hash = 2166136261;
      for (let i = 0; i < label.length; i++) {
        hash = Math.imul(hash ^ label.charCodeAt(i), 16777619) >>> 0;
      }
      vector[hash % 64] += 1;
      vector[(hash >>> 8) % 64] += 0.5;
    }
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vector.map((v) => Math.round((v / norm) * 10000) / 10000);
  };

  for (const [beatIndex, beat] of asset.beats.entries()) {
    // Real shot detection covers the whole file, so the material between beats
    // is a shot too: handheld walking, a pan, the bits nobody planned. Leaving
    // gaps would quietly hand segmentation an easier problem than it has.
    const previous = asset.beats[beatIndex - 1];
    const gapStart = previous ? previous.at + previous.len : 0;
    if (beat.at > gapStart) {
      const midpoint = gapStart + Math.floor((beat.at - gapStart) / 2);
      const gapLabels = [...new Set([...(previous?.labels ?? []).slice(0, 1), 'walking'])];
      shots.push({
        start_ms: gapStart,
        end_ms: beat.at,
        representative_frame_ms: midpoint,
        change_score: 0.44,
      });
      frames.push({
        timestamp_ms: midpoint,
        vector: labelVector(gapLabels),
        labels: gapLabels,
        sharpness: 0.55,
        exposure: 0.6,
        motion: 0.65,
      });
    }

    // Two to four camera shots inside each beat, so segmentation has something
    // to merge rather than a one-to-one mapping that would make it look easy.
    const shotCount = 2 + (beat.at % 3);
    const shotLength = Math.floor(beat.len / shotCount);
    for (let i = 0; i < shotCount; i++) {
      const start = beat.at + i * shotLength;
      const end = i === shotCount - 1 ? beat.at + beat.len : start + shotLength;
      shots.push({
        start_ms: start,
        end_ms: end,
        representative_frame_ms: start + Math.floor((end - start) / 3),
        change_score: i === 0 ? 0.72 : 0.28,
      });
    }

    for (const [i, text] of (beat.speech ?? []).entries()) {
      const start = beat.at + 2000 + i * 6000;
      utterances.push({
        start_ms: start,
        end_ms: start + Math.min(5200, 900 + text.length * 260),
        text,
        speaker_id: i % 2 === 0 ? 'speaker_01' : 'speaker_02',
        confidence: 0.93,
      });
    }

    for (const type of beat.audio ?? []) {
      audioEvents.push({
        start_ms: beat.at + 1500,
        end_ms: beat.at + beat.len - 1500,
        event_type: type === 'wind' ? 'nature' : type,
        confidence: 0.76,
      });
    }

    for (const text of beat.ocr ?? []) {
      ocr.push({
        start_ms: beat.at + 3000,
        end_ms: beat.at + Math.min(beat.len, 9000),
        text,
        confidence: 0.88,
      });
    }

    for (const shot of shots.filter(
      (s) => s.start_ms >= beat.at && s.start_ms < beat.at + beat.len,
    )) {
      frames.push({
        timestamp_ms: shot.representative_frame_ms,
        vector: labelVector(beat.labels ?? []),
        labels: beat.labels ?? [],
        sharpness: 0.72,
        exposure: 0.68,
        motion: (beat.labels ?? []).includes('train_window') ? 0.6 : 0.2,
      });
    }

    // The gap between beats is quiet: that is where a cut can land.
    audioEvents.push({
      start_ms: beat.at + beat.len - 900,
      end_ms: beat.at + beat.len + 600,
      event_type: 'silence',
      confidence: 0.82,
    });
    if ((beat.speech ?? []).length > 0) {
      audioEvents.push({
        start_ms: beat.at + 1200,
        end_ms: beat.at + beat.len - 2000,
        event_type: 'speech',
        confidence: 0.7,
      });
    }
  }

  // And the tail of the recording after the last beat.
  const lastBeat = asset.beats.at(-1);
  if (lastBeat && lastBeat.at + lastBeat.len < asset.durationMs) {
    const start = lastBeat.at + lastBeat.len;
    shots.push({
      start_ms: start,
      end_ms: asset.durationMs,
      representative_frame_ms: start + Math.floor((asset.durationMs - start) / 2),
      change_score: 0.4,
    });
  }

  fixture.assets[asset.file] = {
    probe: {
      duration_ms: asset.durationMs,
      width: 3840,
      height: 2160,
      fps_num: 30000,
      fps_den: 1001,
      video_codec: 'hevc',
      audio_codec: 'aac',
      audio_channels: 2,
      audio_sample_rate: 48_000,
      container: 'mov,mp4,m4a',
      creation_time: asset.created,
      metadata: {},
    },
    detect_shots: { model: 'example-fixture', shots },
    embed_frames: {
      model: 'example-fixture',
      dim: 64,
      frames: frames.sort((a, b) => a.timestamp_ms - b.timestamp_ms),
    },
    transcribe: { language: 'ja', model: 'example-fixture', utterances },
    analyze_audio: {
      model: 'example-fixture',
      hop_ms: 100,
      rms_db: [],
      events: audioEvents.sort((a, b) => a.start_ms - b.start_ms),
    },
    ocr: { model: 'example-fixture', observations: ocr },
  };
}

writeFileSync(join(root, 'perception.fixture.json'), `${JSON.stringify(fixture, null, 2)}\n`);

const totalMs = SCRIPT.reduce((sum, a) => sum + a.durationMs, 0);
console.log(
  `wrote ${SCRIPT.length} stand-in files and a fixture covering ${Math.round(totalMs / 60_000)} minutes`,
);
