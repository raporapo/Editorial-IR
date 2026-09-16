import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AdapterCapabilities,
  operationTimelineDuration,
  operationsInOrder,
  type ApplyResult,
  type EditPlan,
} from '@editorial-ir/contracts';
import type { ApplyRequest, EditorAdapter } from './types.js';
import { msToFrames, negotiate, resolveAssetPath } from './types.js';

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
  captions: false,
  basic_transition: true,
  transition_types: ['cross_dissolve', 'fade_in', 'fade_out'],
  keyframes: true,
  masking: false,
  nested_sequence: false,
  speed_change: true,
  still_images: true,
  color_adjustment: true,
  audio_tracks: 1,
  max_video_tracks: 2,
  reads_back_timeline: false,
  renders_preview: false,
  notes: [
    'The JSON job is the supported output; a bridge reads it to build the timeline.',
    'The .exo file follows the ExEdit object convention and is best effort.',
    'Positions are frames at the sequence rate, and layers are 1-based as AviUtl counts them.',
  ],
});

export const AVIUTL2_JOB_VERSION = '0.1.0';

export class AviUtl2Adapter implements EditorAdapter {
  readonly capabilities = AVIUTL2_CAPABILITIES;

  async apply(request: ApplyRequest): Promise<ApplyResult> {
    const startedAt = Date.now();
    const { plan, downgrades } = negotiate(request.plan, this.capabilities);
    const warnings: string[] = [];

    const job = buildAviUtlJob(plan, request, warnings);
    const exo = buildExo(plan, request);

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
      warnings,
      elapsed_ms: Date.now() - startedAt,
    };
  }
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
  const frames = (ms: number): number => msToFrames(ms, rateNum, rateDen);

  const clips = operationsInOrder(plan).map((operation) => {
    const path = resolveAssetPath(request, operation.source_asset_id);
    if (!path) {
      warnings.push(
        `${operation.operation_id} refers to ${operation.source_asset_id}, which has no file`,
      );
    }
    const event = request.ir.events.find((e) => e.id === operation.event_id);

    return {
      id: operation.operation_id,
      file: path ?? '',
      // AviUtl counts frames from 1 and treats the end frame as inclusive.
      start_frame: frames(operation.timeline_start_ms) + 1,
      end_frame: frames(operation.timeline_start_ms + operationTimelineDuration(operation)),
      source_offset_frame: frames(operation.source_in_ms),
      layer: operation.track + 1,
      speed_percent: Math.round(operation.speed * 100),
      use_source_audio: operation.use_source_audio,
      ...(operation.transition_in && operation.transition_in.type !== 'hard_cut'
        ? {
            transition_in: {
              type: operation.transition_in.type,
              frames: frames(operation.transition_in.duration_ms),
            },
          }
        : {}),
      role: operation.role ?? null,
      description: event?.description.value ?? null,
    };
  });

  return {
    job_version: AVIUTL2_JOB_VERSION,
    generated_by: 'editorial-ir',
    sequence: {
      name: plan.sequence.name,
      width: plan.sequence.width,
      height: plan.sequence.height,
      frame_rate_num: rateNum,
      frame_rate_den: rateDen,
      sample_rate: plan.sequence.sample_rate,
      length_frames: frames(
        plan.tracks.video.reduce(
          (end, o) => Math.max(end, o.timeline_start_ms + operationTimelineDuration(o)),
          0,
        ),
      ),
    },
    clips,
    text: plan.tracks.text.map((text) => ({
      id: text.operation_id,
      start_frame: frames(text.timeline_start_ms) + 1,
      end_frame: frames(text.timeline_end_ms),
      text: text.text,
      kind: text.kind,
      layer: 3,
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
 * blocks beneath it. This writes the two blocks every video clip needs: the
 * media itself and standard drawing.
 */
export function buildExo(plan: EditPlan, request: ApplyRequest): string {
  const { frame_rate_num: rateNum, frame_rate_den: rateDen } = plan.sequence;
  const frames = (ms: number): number => msToFrames(ms, rateNum, rateDen);
  const operations = operationsInOrder(plan);

  const lengthFrames = frames(
    operations.reduce(
      (end, o) => Math.max(end, o.timeline_start_ms + operationTimelineDuration(o)),
      0,
    ),
  );

  const lines: string[] = [
    '[exedit]',
    `width=${plan.sequence.width}`,
    `height=${plan.sequence.height}`,
    `rate=${Math.round(rateNum / rateDen)}`,
    'scale=1',
    `length=${lengthFrames}`,
    `audio_rate=${plan.sequence.sample_rate}`,
    'audio_ch=2',
  ];

  for (const [index, operation] of operations.entries()) {
    const path = resolveAssetPath(request, operation.source_asset_id) ?? '';
    const start = frames(operation.timeline_start_ms) + 1;
    const end = frames(operation.timeline_start_ms + operationTimelineDuration(operation));

    lines.push(
      `[${index}]`,
      `start=${start}`,
      `end=${Math.max(start, end)}`,
      `layer=${operation.track + 1}`,
      'overlay=1',
      'camera=0',
      `[${index}.0]`,
      '_name=動画ファイル',
      `再生位置=${frames(operation.source_in_ms) + 1}`,
      `再生速度=${(operation.speed * 100).toFixed(1)}`,
      'ループ再生=0',
      'アルファチャンネルを読み込む=0',
      `file=${path}`,
      `[${index}.1]`,
      '_name=標準描画',
      'X=0.0',
      'Y=0.0',
      'Z=0.0',
      '拡大率=100.00',
      'transparency=0.0',
      '回転=0.00',
      'blend=0',
    );
  }

  // CRLF, because this format is exchanged on Windows and a bare LF confuses
  // some of the tools that read it.
  return `${lines.join('\r\n')}\r\n`;
}
