import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AdapterCapabilities,
  type ApplyResult,
  type EditPlan,
  type MediaAsset,
} from '@editorial-ir/contracts';
import type { ApplyRequest, EditorAdapter } from './types.js';
import { negotiate, resolveAssetPath, toFileUrl } from './types.js';
import {
  assetById,
  bedSpan,
  countedRate,
  layOnGrid,
  mediaFramesOf,
  pictureOf,
  soundOf,
  streamOf,
  transitionsOf,
  type ClipSound,
  type FrameRate,
  type GridSpan,
  type PlacedTransition,
} from './timeline.js';
import { dbToGain, escapeXml } from './xml.js';

/**
 * Premiere Pro, through Final Cut Pro 7 XML.
 *
 * The obvious design is to drive Premiere live through a plugin or an automation
 * bridge, and the obvious design is wrong as a default: it requires Premiere to
 * be running, a plugin to be installed, and a version of both to match. An
 * interchange file requires none of that. Premiere has imported FCP7 XML for
 * years, the file can be produced on a machine with no Adobe software at all,
 * and it can be diffed, reviewed and tested — which a sequence of API calls
 * cannot.
 *
 * A live transport belongs beside this, not instead of it. When one exists it
 * becomes a second adapter with `mode: 'live'`, and this one keeps working.
 */
export const PREMIERE_CAPABILITIES: AdapterCapabilities = AdapterCapabilities.parse({
  id: 'premiere',
  name: 'Premiere Pro',
  mode: 'file',
  output_extensions: ['.xml'],
  text: false,
  captions: false,
  markers: true,
  basic_transition: true,
  transition_types: ['cross_dissolve', 'dip_to_black', 'dip_to_white', 'fade_in', 'fade_out'],
  keyframes: false,
  masking: false,
  nested_sequence: false,
  speed_change: false,
  still_images: true,
  color_adjustment: false,
  audio_tracks: 2,
  max_video_tracks: 3,
  reads_back_timeline: false,
  renders_preview: false,
  notes: [
    'Final Cut Pro 7 XML (xmeml v4), which Premiere imports as a sequence.',
    'Everything is measured in frames at the sequence rate; NTSC rates are written as timebase plus an ntsc flag.',
    'Stills are still-frame clipitems; sound-only files are audio clipitems with no picture.',
    'Chapters are sequence markers. Text and captions are not written: write captions with --editor srt.',
  ],
});

export class PremiereAdapter implements EditorAdapter {
  readonly capabilities = PREMIERE_CAPABILITIES;

  async apply(request: ApplyRequest): Promise<ApplyResult> {
    const startedAt = Date.now();
    const { plan, downgrades } = negotiate(request.plan, this.capabilities, request.ir.assets);
    const warnings: string[] = [];

    const xml = buildFcpXml(plan, request, warnings);
    const name = request.name ?? 'timeline';
    mkdirSync(request.outputDir, { recursive: true });
    const path = join(request.outputDir, `${name}.xml`);
    writeFileSync(path, xml);

    return {
      adapter: this.capabilities.id,
      artifacts: [
        {
          path,
          kind: 'interchange',
          description: 'Import into Premiere Pro with File > Import.',
          byte_size: statSync(path).size,
        },
      ],
      downgrades,
      warnings,
      elapsed_ms: Date.now() - startedAt,
    };
  }
}

/**
 * The rate an xmeml can say: a whole timebase, slowed by 1000/1001 when the
 * NTSC flag is set, and nothing else. See `countedRate`.
 */
export function xmemlRate(
  num: number,
  den: number,
  warnings: string[] = [],
): { timebase: number; ntsc: boolean; rate: FrameRate } {
  return countedRate(num, den, 'FCP7 XML', warnings);
}

/** Exported so the XML can be checked without touching the filesystem. */
export function buildFcpXml(
  plan: EditPlan,
  request: ApplyRequest,
  warnings: string[] = [],
): string {
  const { timebase, ntsc, rate } = xmemlRate(
    plan.sequence.frame_rate_num,
    plan.sequence.frame_rate_den,
    warnings,
  );
  const grid = layOnGrid(plan, rate);
  const frames = grid.frames;
  const assets = request.ir.assets;
  const rateXml = (indent: number): string => rateElement(timebase, ntsc, indent);

  /**
   * How long each still's media is, and where its clips start in it.
   *
   * A photograph has no length, and a file declared zero frames long refused
   * every dissolve that touched it as "not enough footage". Each still is given
   * three times its longest use, and every clip of it starts one use-length in,
   * so there is always a whole clip's worth of handle on both sides — more than
   * any dissolve can take, since a dissolve never runs past the far end of the
   * clip.
   */
  const stillUse = new Map<string, number>();
  for (const spans of grid.tracks.values()) {
    for (const span of spans) {
      const asset = assetById(assets, span.operation.source_asset_id);
      if (asset && pictureOf(asset) === 'still') {
        stillUse.set(asset.id, Math.max(stillUse.get(asset.id) ?? 0, span.length));
      }
    }
  }
  const sourceRange = (asset: MediaAsset, span: GridSpan): { in: number; out: number } => {
    const use = stillUse.get(asset.id);
    return use === undefined ? { in: span.in, out: span.out } : { in: use, out: use + span.length };
  };
  const mediaLength = (asset: MediaAsset): number => {
    const use = stillUse.get(asset.id);
    return use === undefined ? frames(asset.duration_ms) : use * 3;
  };

  // One <file> definition per asset, at its first appearance in the document;
  // every later clip references it by id. That is what stops a fifty-clip
  // sequence from declaring the same media fifty times and importing it as fifty
  // master clips — and a sound file used only as sound is defined where it is
  // first used, in the audio tracks, rather than never.
  const fileIds = new Map<string, string>();
  const fileElement = (asset: MediaAsset, path: string, indent: number): string[] => {
    const pad = ' '.repeat(indent);
    const existing = fileIds.get(asset.id);
    if (existing) return [`${pad}<file id="${existing}"/>`];
    const fileId = `file-${fileIds.size + 1}`;
    fileIds.set(asset.id, fileId);
    const out = [
      `${pad}<file id="${fileId}">`,
      `${pad}  <name>${escapeXml(asset.file_name)}</name>`,
      `${pad}  <pathurl>${escapeXml(toFileUrl(path))}</pathurl>`,
      rateXml(indent + 2),
      `${pad}  <duration>${mediaLength(asset)}</duration>`,
      `${pad}  <media>`,
    ];
    const picture = pictureOf(asset);
    if (picture !== 'none') {
      out.push(`${pad}    <video>`);
      if (picture === 'still') out.push(`${pad}      <stillframe>TRUE</stillframe>`);
      out.push(
        `${pad}      <samplecharacteristics>`,
        `${pad}        <width>${asset.width ?? plan.sequence.width}</width>`,
        `${pad}        <height>${asset.height ?? plan.sequence.height}</height>`,
        `${pad}      </samplecharacteristics>`,
        `${pad}    </video>`,
      );
    }
    // One <audio> per stream of the file, in order, each with its own channel
    // count: a sourcetrack's trackindex counts channels across them.
    for (const stream of audioStreamsOf(asset)) {
      out.push(`${pad}    <audio>`);
      if (stream.sampleRate) {
        out.push(
          `${pad}      <samplecharacteristics>`,
          `${pad}        <samplerate>${stream.sampleRate}</samplerate>`,
          `${pad}      </samplecharacteristics>`,
        );
      }
      out.push(`${pad}      <channelcount>${stream.channels}</channelcount>`, `${pad}    </audio>`);
    }
    out.push(`${pad}  </media>`, `${pad}</file>`);
    return out;
  };

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<!DOCTYPE xmeml>');
  lines.push('<xmeml version="4">');
  lines.push('  <sequence id="sequence-1">');
  lines.push(`    <name>${escapeXml(plan.sequence.name)}</name>`);
  lines.push(`    <duration>${grid.length}</duration>`);
  lines.push(rateXml(4));

  // Chapters, where an editor looks for them: on the sequence's own ruler.
  for (const marker of plan.markers) {
    lines.push('    <marker>');
    lines.push(`      <name>${escapeXml(marker.name)}</name>`);
    lines.push(`      <comment>${marker.kind}</comment>`);
    lines.push(`      <in>${frames(marker.timeline_ms)}</in>`);
    lines.push('      <out>-1</out>');
    lines.push('    </marker>');
  }

  lines.push('    <media>');
  lines.push('      <video>');
  lines.push('        <format>');
  lines.push('          <samplecharacteristics>');
  lines.push(rateXml(12));
  lines.push(`            <width>${plan.sequence.width}</width>`);
  lines.push(`            <height>${plan.sequence.height}</height>`);
  lines.push('            <pixelaspectratio>square</pixelaspectratio>');
  lines.push('          </samplecharacteristics>');
  lines.push('        </format>');

  // ---- who links to whom -----------------------------------------------------
  // FCP7 XML links picture and sound by `linkclipref`: every member of a linked
  // clip names every member, and the editor sees them as one clip that can
  // still be unlinked. The ids are decided before anything is written, because
  // the picture is written before the sound it names.
  //
  // They are numbered within their own track. Numbering the sound's partner by
  // its position among *all* clips pointed a V2 clip's sound at a V1 clip id
  // that did not exist — measured on the worked example's 38-clip cut with one
  // cutaway added on V2: both its audio clipitems linked `clipitem-1-39`.
  const pictureIdOf = new Map<string, string>();
  const soundIdsOf = new Map<string, string[]>();
  const sounds = new Map<string, ClipSound>();
  const sourceSpecs = plan.tracks.audio.filter((spec) => spec.type === 'source_audio');
  const soundTrackCount = new Map<string, number>();
  for (const [track, spans] of grid.tracks) {
    for (const [index, span] of spans.entries()) {
      const asset = assetById(assets, span.operation.source_asset_id);
      if (!asset || !resolveAssetPath(request, asset.id)) continue;
      if (pictureOf(asset) !== 'none') {
        pictureIdOf.set(span.operation.operation_id, `clipitem-${track + 1}-${index + 1}`);
      }
      const sound = soundOf(asset, span.operation, warnings);
      if (!sound) {
        if (pictureOf(asset) === 'none') {
          warnings.push(
            `${span.operation.operation_id} is sound only and does not use its sound; nothing of it was written`,
          );
        }
        continue;
      }
      sounds.set(span.operation.operation_id, sound);
      const ids: string[] = [];
      for (const spec of sourceSpecs) {
        const key = `${spec.track}:${track}`;
        soundTrackCount.set(key, Math.max(soundTrackCount.get(key) ?? 0, sound.channels));
        for (let channel = 0; channel < sound.channels; channel++) {
          ids.push(audioClipId(spec.track, track, channel, index));
        }
      }
      soundIdsOf.set(span.operation.operation_id, ids);
    }
  }
  const linksOf = (operationId: string): string[] => {
    const picture = pictureIdOf.get(operationId);
    return [...(picture ? [picture] : []), ...(soundIdsOf.get(operationId) ?? [])];
  };

  const mediaFrames = mediaFramesOf(assets, frames);

  for (const spans of grid.tracks.values()) {
    const pictured = spans.filter((span) => pictureIdOf.has(span.operation.operation_id));
    const placed = transitionsOf(pictured, frames, mediaFrames, warnings);
    const before = new Map<string, PlacedTransition>();
    const after = new Map<string, PlacedTransition[]>();
    for (const transition of placed) {
      if (transition.kind === 'head')
        before.set(transition.incoming!.operation.operation_id, transition);
      else {
        const key = transition.outgoing!.operation.operation_id;
        after.set(key, [...(after.get(key) ?? []), transition]);
      }
    }

    lines.push('        <track>');
    for (const span of spans) {
      const operation = span.operation;
      const asset = assetById(assets, operation.source_asset_id);
      const path = resolveAssetPath(request, operation.source_asset_id);
      if (!asset || !path) {
        warnings.push(
          `${operation.operation_id} refers to ${operation.source_asset_id}, which has no file`,
        );
        continue;
      }
      const clipId = pictureIdOf.get(operation.operation_id);
      if (!clipId) continue;
      const still = pictureOf(asset) === 'still';
      const range = sourceRange(asset, span);

      const head = before.get(operation.operation_id);
      if (head) lines.push(...transitionItem(head, rateXml));

      lines.push(`          <clipitem id="${clipId}">`);
      lines.push(`            <name>${escapeXml(asset.file_name)}</name>`);
      lines.push(`            <duration>${mediaLength(asset)}</duration>`);
      lines.push(rateXml(12));
      lines.push(`            <start>${span.start}</start>`);
      lines.push(`            <end>${span.end}</end>`);
      lines.push(`            <in>${range.in}</in>`);
      lines.push(`            <out>${range.out}</out>`);
      lines.push('            <enabled>TRUE</enabled>');
      if (still) lines.push('            <stillframe>TRUE</stillframe>');
      lines.push(...fileElement(asset, path, 12));

      // Why this clip is here, carried into the project so a human opening the
      // sequence sees the reasoning rather than a wall of unexplained cuts.
      const rationale = plan.rationale.find((r) => r.operation_id === operation.operation_id);
      if (rationale) {
        lines.push('            <comments>');
        lines.push(`              <mastercomment1>${escapeXml(rationale.reason)}</mastercomment1>`);
        lines.push(
          `              <mastercomment2>${escapeXml(operation.role ?? '')}</mastercomment2>`,
        );
        lines.push('            </comments>');
      }
      if (soundIdsOf.has(operation.operation_id)) {
        for (const ref of linksOf(operation.operation_id)) {
          lines.push('            <link>');
          lines.push(`              <linkclipref>${ref}</linkclipref>`);
          lines.push('            </link>');
        }
      }
      lines.push('          </clipitem>');

      // The transition into the next clip, written between the two clipitems
      // it joins, which is where this format expects it; a fade out of the
      // last clip follows it.
      for (const transition of after.get(operation.operation_id) ?? []) {
        lines.push(...transitionItem(transition, rateXml));
      }
    }
    lines.push('        </track>');
  }

  lines.push('      </video>');

  // ---- audio ---------------------------------------------------------------
  // A cut with no sound is not a rough cut. The plan names which clips carry
  // their own audio and declares the tracks to lay it on.
  //
  // One track per channel of the sound actually used: two for a stereo camera,
  // one for a mono lavalier. Two were written for everything, so a mono file
  // imported as a clip whose second channel pointed at nothing.
  lines.push('      <audio>');
  lines.push('        <numOutputChannels>2</numOutputChannels>');

  for (const spec of sourceSpecs) {
    for (const [track, spans] of grid.tracks) {
      const channels = soundTrackCount.get(`${spec.track}:${track}`) ?? 0;
      for (let channel = 0; channel < channels; channel++) {
        const written: string[] = [];
        for (const [index, span] of spans.entries()) {
          const operation = span.operation;
          const sound = sounds.get(operation.operation_id);
          if (!sound || channel >= sound.channels) continue;
          const asset = assetById(assets, operation.source_asset_id)!;
          const path = resolveAssetPath(request, asset.id)!;
          const range = sourceRange(asset, span);
          written.push(
            ...audioClipitem({
              id: audioClipId(spec.track, track, channel, index),
              asset,
              file: fileElement(asset, path, 12),
              start: span.start,
              end: span.end,
              in: range.in,
              out: range.out,
              duration: mediaLength(asset),
              trackIndex: sound.channelOffset + channel + 1,
              gainDb: spec.gain_db,
              links: linksOf(operation.operation_id),
              rateXml,
            }),
          );
        }
        if (written.length === 0) continue;
        lines.push('        <track>');
        lines.push(...written);
        lines.push('        </track>');
      }
    }
  }

  // An external bed — music, or a separate recorder — laid once across the
  // sequence at its own level. It was warned about and left out, so a plan
  // that asked for music exported without it.
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
    const ids = Array.from(
      { length: sound.channels },
      (_, c) => `clipitem-b${spec.track + 1}-${c + 1}`,
    );
    for (let channel = 0; channel < sound.channels; channel++) {
      lines.push('        <track>');
      lines.push(
        ...audioClipitem({
          id: ids[channel]!,
          asset,
          file: fileElement(asset, path, 12),
          start: bed.start,
          end: bed.start + bed.length,
          in: bed.in,
          out: bed.in + bed.length,
          duration: frames(asset.duration_ms),
          trackIndex: sound.channelOffset + channel + 1,
          gainDb: spec.gain_db,
          links: ids,
          rateXml,
        }),
      );
      lines.push('        </track>');
    }
  }

  lines.push('      </audio>');
  lines.push('    </media>');
  lines.push('  </sequence>');
  lines.push('</xmeml>');

  return `${lines.join('\n')}\n`;
}

function audioClipId(
  specTrack: number,
  videoTrack: number,
  channel: number,
  index: number,
): string {
  return `clipitem-a${specTrack + 1}-${videoTrack + 1}-${channel + 1}-${index + 1}`;
}

function audioClipitem(clip: {
  id: string;
  asset: MediaAsset;
  file: string[];
  start: number;
  end: number;
  in: number;
  out: number;
  duration: number;
  trackIndex: number;
  gainDb: number;
  links: string[];
  rateXml: (indent: number) => string;
}): string[] {
  const out = [
    `          <clipitem id="${clip.id}">`,
    `            <name>${escapeXml(clip.asset.file_name)}</name>`,
    `            <duration>${clip.duration}</duration>`,
    clip.rateXml(12),
    `            <start>${clip.start}</start>`,
    `            <end>${clip.end}</end>`,
    `            <in>${clip.in}</in>`,
    `            <out>${clip.out}</out>`,
    '            <enabled>TRUE</enabled>',
    ...clip.file,
    '            <sourcetrack>',
    '              <mediatype>audio</mediatype>',
    `              <trackindex>${clip.trackIndex}</trackindex>`,
    '            </sourcetrack>',
  ];
  if (clip.gainDb !== 0) {
    // FCP7 XML writes a level as a linear gain; 1 is unity.
    out.push(
      '            <filter>',
      '              <effect>',
      '                <name>Audio Levels</name>',
      '                <effectid>audiolevels</effectid>',
      '                <effectcategory>audiolevels</effectcategory>',
      '                <effecttype>audiolevels</effecttype>',
      '                <mediatype>audio</mediatype>',
      '                <parameter>',
      '                  <parameterid>level</parameterid>',
      '                  <name>Level</name>',
      '                  <valuemin>0</valuemin>',
      '                  <valuemax>3.98109</valuemax>',
      `                  <value>${dbToGain(clip.gainDb)}</value>`,
      '                </parameter>',
      '              </effect>',
      '            </filter>',
    );
  }
  for (const ref of clip.links) {
    out.push(
      '            <link>',
      `              <linkclipref>${ref}</linkclipref>`,
      '            </link>',
    );
  }
  out.push('          </clipitem>');
  return out;
}

/** Each audio stream of a file, in order, with what a file definition says of it. */
function audioStreamsOf(asset: MediaAsset): { channels: number; sampleRate?: number }[] {
  const streams = [...(asset.audio_streams ?? [])].sort((a, b) => a.index - b.index);
  if (streams.length > 0) {
    return streams.map((stream) => ({
      channels: stream.channels && stream.channels > 0 ? stream.channels : 2,
      ...(stream.sample_rate ? { sampleRate: stream.sample_rate } : {}),
    }));
  }
  const first = streamOf(asset, undefined, asset.id);
  if (!first) return [];
  return [
    {
      channels: first.channels,
      ...(asset.audio_sample_rate ? { sampleRate: asset.audio_sample_rate } : {}),
    },
  ];
}

/** What each transition type is called inside an FCP7 XML. */
const TRANSITION_EFFECTS: Record<string, { name: string; category: string }> = {
  cross_dissolve: { name: 'Cross Dissolve', category: 'Dissolve' },
  dip_to_black: { name: 'Dip to Black Dissolve', category: 'Dissolve' },
  dip_to_white: { name: 'Dip to White Dissolve', category: 'Dissolve' },
  fade_in: { name: 'Cross Dissolve', category: 'Dissolve' },
  fade_out: { name: 'Cross Dissolve', category: 'Dissolve' },
};

/**
 * One transition, where the track holds it.
 *
 * A join is centred on the cut and made of the handles `transitionsOf` found. A
 * fade at the head of a track is aligned `start-black`, and one out of the last
 * clip `end-black`: the clip's own frames going from or to black, which needs no
 * footage either side and which the format has always been able to say.
 */
function transitionItem(placed: PlacedTransition, rateXml: (indent: number) => string): string[] {
  const effect =
    placed.kind === 'between'
      ? (TRANSITION_EFFECTS[placed.transition.type] ?? TRANSITION_EFFECTS.cross_dissolve!)
      : placed.transition.type === 'dip_to_white'
        ? TRANSITION_EFFECTS.dip_to_white!
        : TRANSITION_EFFECTS.cross_dissolve!;

  let start: number;
  let end: number;
  let alignment: string;
  if (placed.kind === 'between') {
    const cut = placed.outgoing!.end;
    start = cut - placed.frames;
    end = cut + placed.frames;
    alignment = 'center';
  } else if (placed.kind === 'head') {
    start = placed.incoming!.start;
    end = start + placed.frames;
    alignment = 'start-black';
  } else {
    end = placed.outgoing!.end;
    start = end - placed.frames;
    alignment = 'end-black';
  }

  return [
    '          <transitionitem>',
    `            <start>${start}</start>`,
    `            <end>${end}</end>`,
    `            <alignment>${alignment}</alignment>`,
    rateXml(12),
    '            <effect>',
    `              <name>${escapeXml(effect.name)}</name>`,
    `              <effectid>${escapeXml(effect.name)}</effectid>`,
    `              <effectcategory>${escapeXml(effect.category)}</effectcategory>`,
    '              <effecttype>transition</effecttype>',
    '              <mediatype>video</mediatype>',
    '              <wipecode>0</wipecode>',
    '              <wipeaccuracy>100</wipeaccuracy>',
    '              <startratio>0</startratio>',
    '              <endratio>1</endratio>',
    '              <reverse>FALSE</reverse>',
    '            </effect>',
    '          </transitionitem>',
  ];
}

function rateElement(timebase: number, ntsc: boolean, indent: number): string {
  const pad = ' '.repeat(indent);
  return [
    `${pad}<rate>`,
    `${pad}  <timebase>${timebase}</timebase>`,
    `${pad}  <ntsc>${ntsc ? 'TRUE' : 'FALSE'}</ntsc>`,
    `${pad}</rate>`,
  ].join('\n');
}
