import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AdapterCapabilities,
  type ApplyResult,
  type EditPlan,
  type MediaAsset,
  type VideoOperation,
} from '@editorial-ir/contracts';
import type { ApplyRequest, EditorAdapter } from './types.js';
import { negotiate, resolveAssetPath, toFileUrl } from './types.js';
import {
  assetById,
  bedSpan,
  clipAudio,
  furthestReads,
  layOnGrid,
  mediaFramesOf,
  mediaLengthOf,
  pictureOf,
  streamOf,
  transitionsOf,
  type GridSpan,
  type PlacedTransition,
} from './timeline.js';

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
  markers: true,
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
    'Transitions are OTIO Transition objects between clips; a fade at either end of a track is one with nothing on its other side.',
    'Chapters are markers on the timeline’s stack. OTIO has no caption track: write captions with --editor srt.',
    'A clip whose sound is a separate recorder’s has an audio clip referencing the recorder, at the recorder’s own frames.',
  ],
});

export class OtioAdapter implements EditorAdapter {
  readonly capabilities = OTIO_CAPABILITIES;

  async apply(request: ApplyRequest): Promise<ApplyResult> {
    const startedAt = Date.now();
    const { plan, downgrades } = negotiate(request.plan, this.capabilities, request.ir.assets);
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
  // Where each clip sits on the frame grid, decided once for every track. A
  // track in OTIO is a run of durations, so an item's position comes from
  // accumulating them, and rounding each duration on its own let the picture
  // and its sound accumulate *different* error: on the worked example six of
  // the fifteen audio clips came out one frame after their picture.
  const grid = layOnGrid(plan);
  const frames = grid.frames;
  const assets = request.ir.assets;

  const at = (value: number): Record<string, unknown> => ({
    OTIO_SCHEMA: 'RationalTime.1',
    rate,
    value,
  });
  /** A range already measured on the frame grid, in frames. */
  const frameRange = (startFrames: number, lengthFrames: number): Record<string, unknown> => ({
    OTIO_SCHEMA: 'TimeRange.1',
    start_time: at(startFrames),
    duration: at(lengthFrames),
  });
  const gap = (length: number): Record<string, unknown> => ({
    OTIO_SCHEMA: 'Gap.1',
    name: 'gap',
    source_range: frameRange(0, length),
    metadata: {},
  });

  // A photograph has no length, so its media reference claimed a zero-frame
  // range while the clip read sixty frames into it. Each still is given three
  // times its longest use and every clip of it starts one use in, which leaves
  // a whole clip's worth of handle either side for any dissolve that touches it.
  const stillUse = new Map<string, number>();
  for (const spans of grid.tracks.values()) {
    for (const span of spans) {
      const asset = assetById(assets, span.operation.source_asset_id);
      if (asset && pictureOf(asset) === 'still') {
        stillUse.set(asset.id, Math.max(stillUse.get(asset.id) ?? 0, span.length));
      }
    }
  }

  // A file's range is at least what the cut reads of it: the grid rounds a clip
  // played to the end of its file up to a whole frame the file may not quite
  // have, and a clip outside its media's available range is one an importer
  // may refuse or shorten (`furthestReads`).
  const reach = furthestReads(plan, grid, assets);
  const reference = (asset: MediaAsset | undefined, path: string | undefined) => ({
    OTIO_SCHEMA: 'ExternalReference.1',
    target_url: path ? toFileUrl(path) : '',
    available_range: asset
      ? stillUse.has(asset.id)
        ? frameRange(0, stillUse.get(asset.id)! * 3)
        : frameRange(0, mediaLengthOf(asset, frames, reach))
      : null,
    metadata: {},
  });
  const sourceStart = (asset: MediaAsset | undefined, span: GridSpan): number =>
    asset && stillUse.has(asset.id) ? stillUse.get(asset.id)! : span.in;
  const lookup = (id: string): MediaAsset | undefined => assetById(assets, id);

  const mediaFrames = mediaFramesOf(assets, frames);

  const tracks = [...grid.tracks.entries()].map(([trackIndex, spans]) => {
    const children: Record<string, unknown>[] = [];
    let cursor = 0;

    // A sound-only file has no picture to put on a video track; it leaves the
    // track empty for its length, and its sound is on an audio track below.
    const pictured = spans.filter((span) => {
      const asset = assetById(assets, span.operation.source_asset_id);
      return !asset || pictureOf(asset) !== 'none';
    });
    const placed = transitionsOf(pictured, frames, mediaFrames, warnings);
    const leading = new Map<string, PlacedTransition>();
    const trailing = new Map<string, PlacedTransition>();
    for (const transition of placed) {
      if (transition.kind === 'tail')
        trailing.set(transition.outgoing!.operation.operation_id, transition);
      else leading.set(transition.incoming!.operation.operation_id, transition);
    }

    for (const span of pictured) {
      const operation = span.operation;

      // A gap keeps the timeline honest: a clip that starts late starts late,
      // rather than being silently slid earlier.
      if (span.start > cursor) {
        children.push(gap(span.start - cursor));
        cursor = span.start;
      }

      // A Transition sits between two items, so the outgoing clip's
      // `transition_out` and the incoming clip's `transition_in` name the same
      // object. At either end of a track the other side is nothing — black —
      // and all of the transition lies on the clip's side of it.
      const before = leading.get(operation.operation_id);
      if (before) children.push(transitionObject(before, at));

      const path = resolveAssetPath(request, operation.source_asset_id);
      if (!path) {
        warnings.push(
          `${operation.operation_id} refers to ${operation.source_asset_id}, which has no file`,
        );
      }
      const asset = assetById(assets, operation.source_asset_id);

      children.push({
        OTIO_SCHEMA: 'Clip.1',
        name: clipName(operation, request),
        source_range: frameRange(sourceStart(asset, span), span.length),
        media_reference: reference(asset, path),
        // Everything this project knows about the clip, namespaced so no other
        // tool mistakes it for its own.
        metadata: {
          'editorial-ir': {
            operation_id: operation.operation_id,
            event_id: operation.event_id ?? null,
            role: operation.role ?? null,
            use_source_audio: operation.use_source_audio,
            provenance: operation.provenance,
            ...(asset ? { media_kind: asset.kind } : {}),
          },
        },
        enabled: true,
      });
      cursor = span.end;

      const after = trailing.get(operation.operation_id);
      if (after) children.push(transitionObject(after, at));
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
  // A cut with no sound is not a rough cut. Source audio is one clip per clip
  // that has sound and wants it, at the same frames as its picture, on its own
  // track: an editor expects to see it under the picture and to be able to
  // unlink it. A clip with none leaves a gap rather than being dropped, so the
  // tracks stay aligned — and a clip whose file has no audio stream at all has
  // none, where it used to get a clip pointing at sound that is not there.
  //
  // Each video track's sound goes on its own audio track. One track for all of
  // them put a V2 cutaway's sound on top of the V1 clip it covers.
  const audioTracks: Record<string, unknown>[] = [];
  const nextName = (): string => `A${audioTracks.length + 1}`;
  for (const spec of plan.tracks.audio) {
    if (spec.type !== 'source_audio') continue;
    for (const spans of grid.tracks.values()) {
      const children: Record<string, unknown>[] = [];
      let cursor = 0;
      for (const span of spans) {
        const operation = span.operation;
        // The clip's sound, from the recorder that heard it where the plan
        // names one: the media reference is the recorder's file and the range
        // is in the recorder's own frames, so an importer needs nothing but
        // OTIO to line the two up.
        const audio = clipAudio(span, lookup, grid.rate, warnings);
        if (!audio) continue;
        if (span.start > cursor) children.push(gap(span.start - cursor));
        const path = resolveAssetPath(request, audio.asset.id);
        children.push({
          OTIO_SCHEMA: 'Clip.1',
          name: clipName(operation, request),
          source_range: frameRange(audio.in, span.length),
          media_reference: reference(audio.asset, path),
          metadata: {
            'editorial-ir': {
              operation_id: operation.operation_id,
              follows: operation.operation_id,
              gain_db: spec.gain_db,
              // OTIO has no way to name a stream inside a file; this is where
              // an importer that wants the lavalier and not the room finds it.
              audio_stream_index: audio.sound.stream,
              channels: audio.sound.channels,
              // Sound placed to the frame; the plan's own time is here for a
              // tool that can place it to the sample.
              ...(audio.separate
                ? { audio_source: { asset_id: audio.asset.id, source_in_ms: audio.sourceInMs } }
                : {}),
            },
          },
          enabled: true,
        });
        cursor = span.end;
      }
      if (children.length === 0) continue;
      audioTracks.push({
        OTIO_SCHEMA: 'Track.1',
        name: nextName(),
        kind: 'Audio',
        children,
        source_range: null,
        enabled: true,
        metadata: { 'editorial-ir': { gain_db: spec.gain_db } },
      });
    }
  }

  // An external bed — music, or a separate recorder — on a track of its own. It
  // was warned about and left out, so a plan that asked for music exported
  // without it.
  for (const spec of plan.tracks.audio) {
    if (spec.type !== 'external') continue;
    const asset = assetById(assets, spec.asset_id);
    const path = asset ? resolveAssetPath(request, asset.id) : undefined;
    const sound = asset ? streamOf(asset, undefined, spec.asset_id, warnings) : undefined;
    if (!asset || !path || !sound) {
      warnings.push(`the bed on audio track ${spec.track} (${spec.asset_id}) has no sound to lay`);
      continue;
    }
    const bed = bedSpan(spec, asset, grid.length, frames);
    if (!bed) {
      warnings.push(`the bed on audio track ${spec.track} starts after the cut ends; left out`);
      continue;
    }
    audioTracks.push({
      OTIO_SCHEMA: 'Track.1',
      name: nextName(),
      kind: 'Audio',
      children: [
        ...(bed.start > 0 ? [gap(bed.start)] : []),
        {
          OTIO_SCHEMA: 'Clip.1',
          name: asset.file_name,
          source_range: frameRange(bed.in, bed.length),
          media_reference: reference(asset, path),
          metadata: {
            'editorial-ir': {
              bed: true,
              gain_db: spec.gain_db,
              duck_under_speech: spec.duck_under_speech,
              audio_stream_index: sound.stream,
            },
          },
          enabled: true,
        },
      ],
      source_range: null,
      enabled: true,
      metadata: { 'editorial-ir': { gain_db: spec.gain_db, bed: true } },
    });
  }

  return {
    OTIO_SCHEMA: 'Timeline.1',
    name: plan.sequence.name,
    global_start_time: at(0),
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      children: [...tracks, ...audioTracks],
      source_range: null,
      enabled: true,
      // Chapters on the stack, in the timeline's own time: the one place every
      // track agrees on.
      //
      // `Marker.1` names its range `range`. Written as `marked_range` — the
      // `Marker.2` spelling under the `Marker.1` label — OpenTimelineIO 0.18
      // upgraded the object, found no `range`, and refused the whole timeline:
      // "expected type TimeRange under key 'marked_range': found type None".
      // Version 1 is the one every OTIO release reads, and newer ones upgrade it.
      markers: plan.markers.map((marker) => ({
        OTIO_SCHEMA: 'Marker.1',
        name: marker.name,
        range: frameRange(frames(marker.timeline_ms), 0),
        color: marker.kind === 'chapter' ? 'PURPLE' : 'YELLOW',
        metadata: { 'editorial-ir': { kind: marker.kind, event_id: marker.event_id ?? null } },
      })),
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

function transitionObject(
  placed: PlacedTransition,
  at: (value: number) => Record<string, unknown>,
): Record<string, unknown> {
  const [inOffset, outOffset] =
    placed.kind === 'between'
      ? [placed.frames, placed.frames]
      : placed.kind === 'head'
        ? [0, placed.frames]
        : [placed.frames, 0];
  return {
    OTIO_SCHEMA: 'Transition.1',
    name: placed.transition.type,
    transition_type: 'SMPTE_Dissolve',
    in_offset: at(inOffset),
    out_offset: at(outOffset),
    metadata: { 'editorial-ir': { type: placed.transition.type, at: placed.kind } },
  };
}

function clipName(operation: VideoOperation, request: ApplyRequest): string {
  const event = request.ir.events.find((e) => e.id === operation.event_id);
  const asset = request.ir.assets.find((a) => a.id === operation.source_asset_id);
  const description = event?.title?.value ?? event?.description.value;
  if (description) return description.slice(0, 60);
  return asset?.file_name ?? operation.operation_id;
}
