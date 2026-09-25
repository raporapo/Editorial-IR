import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AdapterCapabilities,
  operationsInOrder,
  type ApplyResult,
  type EditPlan,
  type MediaAsset,
} from '@editorial-ir/contracts';
import type { ApplyRequest, EditorAdapter } from './types.js';
import { negotiate, resolveAssetPath } from './types.js';
import {
  assetById,
  bedSpan,
  clipAudio,
  layOnGrid,
  pictureOf,
  streamOf,
  type ClipAudio,
  type FrameGrid,
} from './timeline.js';

/**
 * AviUtl2.
 *
 * This adapter exists to prove editor independence with an editor that is
 * nothing like Premiere: different platform, different community, different
 * file formats, and no interchange standard in common. The same EditPlan feeds
 * both, and the difference lives entirely here.
 *
 * It writes two things, for an honest reason. The JSON job is the supported
 * output: a small, versioned document that an AviUtl2 script or bridge reads to
 * build a timeline, and whose shape this project controls. The `.exo` file is
 * the ExEdit object format that AviUtl users already exchange by hand; it is
 * written on a best-effort basis so that the result can be dragged into an
 * existing workflow today.
 *
 * Claiming more than that would be dishonest: the ExEdit format is a community
 * convention rather than a specification, so the `.exo` is marked experimental
 * and the JSON job is what the bridge is built against.
 */
export const AVIUTL2_CAPABILITIES: AdapterCapabilities = AdapterCapabilities.parse({
  id: 'aviutl2',
  name: 'AviUtl2',
  mode: 'file',
  output_extensions: ['.aviutl2.json', '.exo'],
  text: true,
  captions: true,
  markers: true,
  basic_transition: true,
  transition_types: ['cross_dissolve', 'fade_in', 'fade_out'],
  keyframes: true,
  masking: false,
  nested_sequence: false,
  speed_change: true,
  still_images: true,
  color_adjustment: true,
  audio_tracks: 2,
  max_video_tracks: 2,
  reads_back_timeline: false,
  renders_preview: false,
  notes: [
    'The JSON job is the supported output; a bridge reads it to build the timeline.',
    'The .exo file follows the ExEdit object convention and is best effort: pictures, stills and sound, but no text, transitions or markers, which are in the job.',
    'Positions are frames at the sequence rate, and layers are 1-based as AviUtl counts them.',
    'A clip whose sound is a separate recorder’s names the recorder in the job (audio_source), and its .exo audio object plays the recorder.',
  ],
});

/**
 * 0.2.0 added what a clip is made of (`media`, `audio_stream_index`,
 * `audio_channels`), the external beds (`audio_beds`) and the chapters
 * (`markers`), and made `use_source_audio` mean "this clip's sound is used" —
 * false for a clip whose file has none, which 0.1.0 would have claimed.
 *
 * 0.3.0 added `audio_source`: a clip whose sound is read from a separate
 * recorder — its `file`, `source_offset_frame`, `audio_stream_index` and
 * `audio_channels` — in place of the clip-level stream fields, which describe a
 * stream of the clip's own `file`.
 *
 * A job is written as the lowest version that describes it: 0.3.0 only when a
 * clip's sound is a recorder's, and 0.2.0 otherwise. A bridge built against
 * 0.2.0 that checks the version still reads every job it could before, and
 * refuses the one it would misread — a clip that says its sound is used, next
 * to a `file` that is the camera — instead of playing the camera's microphone.
 */
export const AVIUTL2_JOB_VERSION = '0.3.0';
const AVIUTL2_JOB_VERSION_WITHOUT_RECORDERS = '0.2.0';

export class AviUtl2Adapter implements EditorAdapter {
  readonly capabilities = AVIUTL2_CAPABILITIES;

  async apply(request: ApplyRequest): Promise<ApplyResult> {
    const startedAt = Date.now();
    const { plan, downgrades } = negotiate(request.plan, this.capabilities, request.ir.assets);
    const warnings: string[] = [];

    const job = buildAviUtlJob(plan, request, warnings);
    const exo = buildExo(plan, request, warnings);

    const name = request.name ?? 'timeline';
    mkdirSync(request.outputDir, { recursive: true });
    const jobPath = join(request.outputDir, `${name}.aviutl2.json`);
    const exoPath = join(request.outputDir, `${name}.exo`);
    writeFileSync(jobPath, `${JSON.stringify(job, null, 2)}\n`);
    // Shift-JIS is what ExEdit expects; UTF-8 is written here because the paths
    // and titles in this project are routinely outside that encoding, and a
    // mangled path is worse than an encoding a bridge can convert.
    writeFileSync(exoPath, exo, 'utf8');

    warnings.push('The .exo output is best effort; the JSON job is the supported path.');

    return {
      adapter: this.capabilities.id,
      artifacts: [
        {
          path: jobPath,
          kind: 'project',
          description: 'A versioned job for the AviUtl2 bridge to build a timeline from.',
          byte_size: statSync(jobPath).size,
        },
        {
          path: exoPath,
          kind: 'interchange',
          description: 'ExEdit object file, best effort, for dropping into an existing workflow.',
          byte_size: statSync(exoPath).size,
        },
      ],
      downgrades,
      warnings: dedupe(warnings),
      elapsed_ms: Date.now() - startedAt,
    };
  }
}

/** What a job clip is: what the file shows, and whether its sound is used. */
function mediaOf(asset: MediaAsset | undefined): 'video' | 'image' | 'audio' {
  if (!asset) return 'video';
  const picture = pictureOf(asset);
  return picture === 'still' ? 'image' : picture === 'none' ? 'audio' : 'video';
}

/**
 * The job document.
 *
 * Deliberately a flat list of placements in frames rather than anything
 * resembling an AviUtl internal structure: whatever reads this should be able to
 * be a fifty-line script.
 */
export function buildAviUtlJob(
  plan: EditPlan,
  request: ApplyRequest,
  warnings: string[] = [],
): Record<string, unknown> {
  const { frame_rate_num: rateNum, frame_rate_den: rateDen } = plan.sequence;
  // The same grid every other writer uses. Each edge was rounded on its own
  // here, so a clip could end a frame after the next one began.
  const grid = layOnGrid(plan);
  const frames = grid.frames;
  const assets = request.ir.assets;
  const lookup = (id: string): MediaAsset | undefined => assetById(assets, id);
  let recorded = false;

  const clips = operationsInOrder(plan).map((operation) => {
    const span = grid.span(operation.operation_id);
    const path = resolveAssetPath(request, operation.source_asset_id);
    if (!path) {
      warnings.push(
        `${operation.operation_id} refers to ${operation.source_asset_id}, which has no file`,
      );
    }
    const asset = assetById(assets, operation.source_asset_id);
    const media = mediaOf(asset);
    const audio = clipAudio(span, lookup, grid.rate, warnings);
    const sound = audio && !audio.separate ? audio.sound : undefined;
    if (audio?.separate) recorded = true;
    const event = request.ir.events.find((e) => e.id === operation.event_id);

    return {
      id: operation.operation_id,
      file: path ?? '',
      media,
      // AviUtl counts frames from 1 and treats the end frame as inclusive.
      start_frame: span.start + 1,
      end_frame: span.end,
      // A still is the same at every instant; there is no offset into it.
      source_offset_frame: media === 'image' ? 0 : span.in,
      layer: operation.track + 1,
      speed_percent: Math.round(operation.speed * 100),
      use_source_audio: audio !== undefined,
      ...(sound ? { audio_stream_index: sound.stream, audio_channels: sound.channels } : {}),
      // The recorder that is this clip's sound, from its own frame. Frames here
      // are the recorder's at the sequence rate, as `source_offset_frame` is
      // the picture's.
      ...(audio?.separate
        ? {
            audio_source: {
              file: resolveAssetPath(request, audio.asset.id) ?? '',
              source_offset_frame: audio.in,
              audio_stream_index: audio.sound.stream,
              audio_channels: audio.sound.channels,
            },
          }
        : {}),
      ...(operation.transition_in && operation.transition_in.type !== 'hard_cut'
        ? {
            transition_in: {
              type: operation.transition_in.type,
              frames: frames(operation.transition_in.duration_ms),
            },
          }
        : {}),
      // The plan carries both sides and only one was written, so a skill asking
      // for the last shot to fade out got a hard cut to black.
      ...(operation.transition_out && operation.transition_out.type !== 'hard_cut'
        ? {
            transition_out: {
              type: operation.transition_out.type,
              frames: frames(operation.transition_out.duration_ms),
            },
          }
        : {}),
      ...(operation.continues_previous ? { continues_previous: true } : {}),
      role: operation.role ?? null,
      description: event?.description.value ?? null,
    };
  });

  const beds = plan.tracks.audio.flatMap((spec) => {
    if (spec.type !== 'external') return [];
    const asset = assetById(assets, spec.asset_id);
    const path = asset ? resolveAssetPath(request, asset.id) : undefined;
    const sound = asset ? streamOf(asset, undefined, spec.asset_id, warnings) : undefined;
    const bed = asset ? bedSpan(spec, asset, grid.length, frames) : undefined;
    if (!asset || !path || !sound || !bed) {
      warnings.push(`the bed on audio track ${spec.track} (${spec.asset_id}) was not written`);
      return [];
    }
    return [
      {
        file: path,
        start_frame: bed.start + 1,
        end_frame: bed.start + bed.length,
        source_offset_frame: bed.in,
        gain_db: spec.gain_db,
        duck_under_speech: spec.duck_under_speech,
        audio_stream_index: sound.stream,
      },
    ];
  });

  return {
    job_version: recorded ? AVIUTL2_JOB_VERSION : AVIUTL2_JOB_VERSION_WITHOUT_RECORDERS,
    generated_by: 'editorial-ir',
    sequence: {
      name: plan.sequence.name,
      width: plan.sequence.width,
      height: plan.sequence.height,
      frame_rate_num: rateNum,
      frame_rate_den: rateDen,
      sample_rate: plan.sequence.sample_rate,
      length_frames: grid.length,
    },
    clips,
    audio_beds: beds,
    text: plan.tracks.text.map((text) => ({
      id: text.operation_id,
      start_frame: frames(text.timeline_start_ms) + 1,
      end_frame: frames(text.timeline_end_ms),
      text: text.text,
      kind: text.kind,
      layer: 3,
    })),
    markers: plan.markers.map((marker) => ({
      frame: frames(marker.timeline_ms) + 1,
      name: marker.name,
      kind: marker.kind,
    })),
    source: {
      plan_id: plan.id,
      project_id: plan.project_id,
      ir_fingerprint: plan.ir_fingerprint,
      skill: plan.skill,
    },
  };
}

/**
 * An ExEdit object file.
 *
 * The format is an INI-like list of numbered objects, each with numbered effect
 * blocks beneath it. A video clip is a 動画ファイル and its drawing, a still a
 * 画像ファイル, and sound a 音声ファイル with its playback block on a layer
 * below the pictures, grouped with the picture it belongs to so the two move
 * together.
 *
 * The file was silent: every clip, photographs and sound files included, was
 * written as a 動画ファイル, which plays no audio in ExEdit. A cut dragged in
 * from here arrived as pictures only, and an audio-only project as a stack of
 * video objects pointing at .m4a files.
 */
export function buildExo(plan: EditPlan, request: ApplyRequest, warnings: string[] = []): string {
  const { frame_rate_num: rateNum, frame_rate_den: rateDen } = plan.sequence;
  const grid: FrameGrid = layOnGrid(plan);
  const assets = request.ir.assets;
  const operations = operationsInOrder(plan);

  const lines: string[] = [
    '[exedit]',
    `width=${plan.sequence.width}`,
    `height=${plan.sequence.height}`,
    // ExEdit's rate and scale are the rational pair — fps is rate/scale — which
    // is why `scale` exists at all. Rounding 30000/1001 to 30 and writing
    // scale=1 declares a 30 fps project for frame numbers computed at 29.97:
    // everything plays a tenth of a percent fast, and audio drifts against
    // picture by about a fifth of a second every three minutes. The JSON job
    // beside this, built from the same numbers, carries the pair exactly.
    `rate=${rateNum}`,
    `scale=${rateDen}`,
    `length=${grid.length}`,
    `audio_rate=${plan.sequence.sample_rate}`,
    'audio_ch=2',
  ];

  // Pictures keep the layers the plan gave them; sound goes below all of them,
  // one layer per picture track, and beds below that.
  const pictureLayers = Math.max(1, ...operations.map((operation) => operation.track + 1));
  const seconds = (frameCount: number): string => ((frameCount * rateDen) / rateNum).toFixed(2);

  let index = 0;
  let group = 0;
  const object = (header: string[], blocks: string[][]): void => {
    lines.push(`[${index}]`, ...header);
    blocks.forEach((block, n) => lines.push(`[${index}.${n}]`, ...block));
    index++;
  };
  const soundBlocks = (path: string, offsetFrames: number, speed: number, gainDb: number) => [
    [
      '_name=音声ファイル',
      // Seconds, not frames: the audio object counts its own position in time.
      `再生位置=${seconds(offsetFrames)}`,
      `再生速度=${(speed * 100).toFixed(1)}`,
      'ループ再生=0',
      '動画ファイルと連携=0',
      `file=${path}`,
    ],
    ['_name=標準再生', `音量=${(100 * 10 ** (gainDb / 20)).toFixed(1)}`, '左右=0.0'],
  ];

  const lookup = (id: string): MediaAsset | undefined => assetById(assets, id);
  for (const operation of operations) {
    const span = grid.span(operation.operation_id);
    const asset = assetById(assets, operation.source_asset_id);
    const path = resolveAssetPath(request, operation.source_asset_id) ?? '';
    const picture = asset ? pictureOf(asset) : 'video';
    // The clip's sound, from the recorder that heard it where the plan names
    // one: the audio object plays that file from its own position, grouped
    // with the picture as the camera's own sound would be.
    const audio: ClipAudio | undefined = clipAudio(span, lookup, grid.rate, warnings);
    const start = span.start + 1;
    const end = Math.max(start, span.end);
    const grouped = picture !== 'none' && audio !== undefined;
    if (grouped) group++;
    const groupLine = grouped ? [`group=${group}`] : [];

    if (picture !== 'none') {
      const source =
        picture === 'still'
          ? ['_name=画像ファイル', `file=${path}`]
          : [
              '_name=動画ファイル',
              `再生位置=${span.in + 1}`,
              `再生速度=${(operation.speed * 100).toFixed(1)}`,
              'ループ再生=0',
              'アルファチャンネルを読み込む=0',
              `file=${path}`,
            ];
      object(
        [
          `start=${start}`,
          `end=${end}`,
          `layer=${operation.track + 1}`,
          ...groupLine,
          'overlay=1',
          'camera=0',
        ],
        [
          source,
          [
            '_name=標準描画',
            'X=0.0',
            'Y=0.0',
            'Z=0.0',
            '拡大率=100.00',
            'transparency=0.0',
            '回転=0.00',
            'blend=0',
          ],
        ],
      );
    }

    if (audio) {
      if (audio.sound.stream > 0) {
        warnings.push(
          `${operation.operation_id}'s sound is audio stream ${audio.sound.stream} of ${audio.asset.file_name}; ` +
            'ExEdit’s audio object plays the first, so choose the stream in the input plugin or use the JSON job',
        );
      }
      const gain = plan.tracks.audio.find((spec) => spec.type === 'source_audio')?.gain_db ?? 0;
      object(
        [
          `start=${start}`,
          `end=${end}`,
          `layer=${pictureLayers + operation.track + 1}`,
          ...groupLine,
          'overlay=1',
          'audio=1',
        ],
        soundBlocks(
          resolveAssetPath(request, audio.asset.id) ?? '',
          audio.in,
          operation.speed,
          gain,
        ),
      );
    }
  }

  let bedLayer = pictureLayers * 2;
  for (const spec of plan.tracks.audio) {
    if (spec.type !== 'external') continue;
    const asset = assetById(assets, spec.asset_id);
    const path = asset ? resolveAssetPath(request, asset.id) : undefined;
    const bed = asset ? bedSpan(spec, asset, grid.length, grid.frames) : undefined;
    if (!asset || !path || !bed) continue;
    bedLayer++;
    object(
      [
        `start=${bed.start + 1}`,
        `end=${bed.start + bed.length}`,
        `layer=${bedLayer}`,
        'overlay=1',
        'audio=1',
      ],
      soundBlocks(path, bed.in, 1, spec.gain_db),
    );
  }

  // CRLF, because this format is exchanged on Windows and a bare LF confuses
  // some of the tools that read it.
  return `${lines.join('\r\n')}\r\n`;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
