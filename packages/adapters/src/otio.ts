import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AdapterCapabilities,
  operationTimelineDuration,
  operationsInOrder,
  type ApplyResult,
  type EditPlan,
  type VideoOperation,
} from '@editorial-ir/contracts';
import type { ApplyRequest, EditorAdapter } from './types.js';
import { negotiate, resolveAssetPath, toFileUrl } from './types.js';

/**
 * OpenTimelineIO.
 *
 * The adapter that proves the architecture. OTIO is an editor-independent
 * interchange format with real importers, so a plan written here opens in
 * Resolve, in Flame, in a Python script — without this project knowing anything
 * about any of them. It is also the one adapter whose output can be checked in
 * full by a test, which makes it the reference the others are read against.
 */
export const OTIO_CAPABILITIES: AdapterCapabilities = AdapterCapabilities.parse({
  id: 'otio',
  name: 'OpenTimelineIO',
  mode: 'file',
  output_extensions: ['.otio'],
  text: false,
  captions: false,
  basic_transition: true,
  transition_types: ['cross_dissolve', 'dip_to_black', 'dip_to_white', 'fade_in', 'fade_out'],
  keyframes: false,
  masking: false,
  nested_sequence: true,
  speed_change: false,
  still_images: true,
  color_adjustment: false,
  audio_tracks: 2,
  max_video_tracks: 4,
  reads_back_timeline: false,
  renders_preview: false,
  notes: [
    'Times are rational: frame counts at the sequence rate, so an NTSC rate survives exactly.',
    'Transitions are written as OTIO Transition objects between clips.',
  ],
});

export class OtioAdapter implements EditorAdapter {
  readonly capabilities = OTIO_CAPABILITIES;

  async apply(request: ApplyRequest): Promise<ApplyResult> {
    const startedAt = Date.now();
    const { plan, downgrades } = negotiate(request.plan, this.capabilities);
    const warnings: string[] = [];

    const document = buildOtioTimeline(plan, request, warnings);
    const name = request.name ?? 'timeline';
    mkdirSync(request.outputDir, { recursive: true });
    const path = join(request.outputDir, `${name}.otio`);
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);

    return {
      adapter: this.capabilities.id,
      artifacts: [
        {
          path,
          kind: 'interchange',
          description: 'An OpenTimelineIO timeline, readable by anything that speaks OTIO.',
          byte_size: statSync(path).size,
        },
      ],
      downgrades,
      warnings,
      elapsed_ms: Date.now() - startedAt,
    };
  }
}

/** Exported so the document can be checked without touching the filesystem. */
export function buildOtioTimeline(
  plan: EditPlan,
  request: ApplyRequest,
  warnings: string[] = [],
): Record<string, unknown> {
  const rate = plan.sequence.frame_rate_num / plan.sequence.frame_rate_den;
  const frames = (ms: number): number => Math.round((ms / 1000) * rate);
  const time = (ms: number): Record<string, unknown> => at(frames(ms));
  const at = (value: number): Record<string, unknown> => ({
    OTIO_SCHEMA: 'RationalTime.1',
    rate,
    value,
  });
  const range = (startMs: number, durationMs: number): Record<string, unknown> => ({
    OTIO_SCHEMA: 'TimeRange.1',
    start_time: time(startMs),
    duration: time(durationMs),
  });
  /** A range already measured on the frame grid, in frames. */
  const frameRange = (startFrames: number, lengthFrames: number): Record<string, unknown> => ({
    OTIO_SCHEMA: 'TimeRange.1',
    start_time: at(startFrames),
    duration: at(lengthFrames),
  });

  /**
   * Where each clip sits on the frame grid, decided once for both tracks.
   *
   * A track in OTIO is a run of durations, so its items' positions come from
   * accumulating them. Rounding each duration on its own therefore accumulates
   * error, and the picture and its sound accumulate *different* error, because
   * the audio track merges a run of silent clips into one gap and the video
   * track does not. On the worked example six of the fifteen audio clips came
   * out one frame after their picture. A frame of drift is a sync fault, and it
   * is the kind a person notices in the edit rather than in a diff.
   *
   * So each operation's start and end are placed on the grid from its absolute
   * timeline position, and every length either track writes is the difference
   * between two of those. Both tracks then land on exactly the same frames.
   */
  const span = new Map<string, { start: number; length: number }>();
  {
    const inOrder = operationsInOrder(plan);
    const byTrackForSpans = new Map<number, typeof inOrder>();
    for (const operation of inOrder) {
      const list = byTrackForSpans.get(operation.track) ?? [];
      list.push(operation);
      byTrackForSpans.set(operation.track, list);
    }
    for (const operations of byTrackForSpans.values()) {
      for (const [index, operation] of operations.entries()) {
        const start = frames(operation.timeline_start_ms);
        const next = operations[index + 1];
        const wanted = Math.max(1, frames(operationTimelineDuration(operation)));
        const nextStart = next ? frames(next.timeline_start_ms) : undefined;
        const length =
          nextStart !== undefined && nextStart > start
            ? Math.min(wanted, nextStart - start)
            : wanted;
        span.set(operation.operation_id, { start, length });
      }
    }
  }

  const byTrack = new Map<number, typeof plan.tracks.video>();
  for (const operation of operationsInOrder(plan)) {
    const list = byTrack.get(operation.track) ?? [];
    list.push(operation);
    byTrack.set(operation.track, list);
  }

  const tracks = [...byTrack.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([trackIndex, operations]) => {
      const children: Record<string, unknown>[] = [];
      let cursor = 0;

      for (const [position, operation] of operations.entries()) {
        const placed = span.get(operation.operation_id)!;

        // A gap keeps the timeline honest: a clip that starts late starts late,
        // rather than being silently slid earlier.
        if (placed.start > cursor) {
          children.push({
            OTIO_SCHEMA: 'Gap.1',
            name: 'gap',
            source_range: frameRange(0, placed.start - cursor),
            metadata: {},
          });
          cursor = placed.start;
        }

        // A Transition sits between two clips, so the outgoing clip's
        // `transition_out` and the incoming clip's `transition_in` name the same
        // object. Reading only one of them dropped a skill's request to fade out
        // of a shot, silently, with no downgrade recorded.
        const transition = operation.transition_in ?? operations[position - 1]?.transition_out;
        if (transition && transition.type !== 'hard_cut' && transition.duration_ms > 0) {
          children.push({
            OTIO_SCHEMA: 'Transition.1',
            name: transition.type,
            transition_type: 'SMPTE_Dissolve',
            in_offset: time(Math.round(transition.duration_ms / 2)),
            out_offset: time(Math.round(transition.duration_ms / 2)),
            metadata: { 'editorial-ir': { type: transition.type } },
          });
        }

        const path = resolveAssetPath(request, operation.source_asset_id);
        if (!path) {
          warnings.push(
            `${operation.operation_id} refers to ${operation.source_asset_id}, which has no file`,
          );
        }
        const asset = request.ir.assets.find((a) => a.id === operation.source_asset_id);

        children.push({
          OTIO_SCHEMA: 'Clip.1',
          name: clipName(operation, request),
          source_range: frameRange(frames(operation.source_in_ms), placed.length),
          media_reference: {
            OTIO_SCHEMA: 'ExternalReference.1',
            target_url: path ? toFileUrl(path) : '',
            available_range: asset ? range(0, asset.duration_ms) : null,
            metadata: {},
          },
          // Everything this project knows about the clip, namespaced so no
          // other tool mistakes it for its own.
          metadata: {
            'editorial-ir': {
              operation_id: operation.operation_id,
              event_id: operation.event_id ?? null,
              role: operation.role ?? null,
              use_source_audio: operation.use_source_audio,
              provenance: operation.provenance,
            },
          },
          enabled: true,
        });

        cursor = placed.start + placed.length;
      }

      return {
        OTIO_SCHEMA: 'Track.1',
        name: `V${trackIndex + 1}`,
        kind: 'Video',
        children,
        source_range: null,
        enabled: true,
        metadata: {},
      };
    });

  // ---- audio ---------------------------------------------------------------
  // A cut with no sound is not a rough cut. The plan says which clips carry
  // their own audio and declares the tracks to lay it on, and until this existed
  // both were read and neither was written: every export arrived silent, with
  // the capabilities still advertising two audio tracks.
  //
  // Source audio is one clip per video clip that wants it, on its own track, at
  // the same times — an editor expects to see it under the picture and to be
  // able to unlink it. A clip that does not want its own sound leaves a gap
  // rather than being dropped, so the two tracks stay aligned.
  const audioTracks = plan.tracks.audio
    .filter((spec) => spec.type === 'source_audio')
    .map((spec) => {
      const children: Record<string, unknown>[] = [];
      let cursor = 0;

      for (const operation of operationsInOrder(plan)) {
        if (!operation.use_source_audio) continue;
        // The same frames the picture got, so the sound cannot drift from it.
        const placed = span.get(operation.operation_id)!;
        if (placed.start > cursor) {
          children.push({
            OTIO_SCHEMA: 'Gap.1',
            name: 'gap',
            source_range: frameRange(0, placed.start - cursor),
            metadata: {},
          });
        }
        const path = resolveAssetPath(request, operation.source_asset_id);
        const asset = request.ir.assets.find((a) => a.id === operation.source_asset_id);
        children.push({
          OTIO_SCHEMA: 'Clip.1',
          name: clipName(operation, request),
          source_range: frameRange(frames(operation.source_in_ms), placed.length),
          media_reference: {
            OTIO_SCHEMA: 'ExternalReference.1',
            target_url: path ? toFileUrl(path) : '',
            available_range: asset ? range(0, asset.duration_ms) : null,
            metadata: {},
          },
          metadata: {
            'editorial-ir': {
              operation_id: operation.operation_id,
              follows: operation.operation_id,
              gain_db: spec.gain_db,
            },
          },
          enabled: true,
        });
        cursor = placed.start + placed.length;
      }

      return {
        OTIO_SCHEMA: 'Track.1',
        name: `A${spec.track + 1}`,
        kind: 'Audio',
        children,
        source_range: null,
        enabled: true,
        metadata: { 'editorial-ir': { gain_db: spec.gain_db } },
      };
    })
    .filter((track) => track.children.length > 0);

  if (plan.tracks.audio.some((spec) => spec.type === 'external')) {
    // Writing one would need the bed's own media resolved and its duration
    // decided, and a silently missing bed is worse than a named one.
    warnings.push('an external audio bed was asked for; this adapter writes source audio only');
  }

  return {
    OTIO_SCHEMA: 'Timeline.1',
    name: plan.sequence.name,
    global_start_time: time(0),
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      children: [...tracks, ...audioTracks],
      source_range: null,
      enabled: true,
      metadata: {},
    },
    metadata: {
      'editorial-ir': {
        edit_plan_version: plan.edit_plan_version,
        plan_id: plan.id,
        project_id: plan.project_id,
        ir_fingerprint: plan.ir_fingerprint,
        skill: plan.skill,
        intent: plan.intent,
        target_duration_ms: plan.sequence.target_duration_ms,
      },
    },
  };
}

function clipName(operation: VideoOperation, request: ApplyRequest): string {
  const event = request.ir.events.find((e) => e.id === operation.event_id);
  const asset = request.ir.assets.find((a) => a.id === operation.source_asset_id);
  const description = event?.title?.value ?? event?.description.value;
  if (description) return description.slice(0, 60);
  return asset?.file_name ?? operation.operation_id;
}
