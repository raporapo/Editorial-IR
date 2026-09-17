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
import { msToFrames, negotiate, resolveAssetPath, toFileUrl } from './types.js';

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
  basic_transition: true,
  transition_types: ['cross_dissolve', 'dip_to_black', 'dip_to_white'],
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
    'Text and captions are not written: they belong to a live transport, not to this format.',
  ],
});

export class PremiereAdapter implements EditorAdapter {
  readonly capabilities = PREMIERE_CAPABILITIES;

  async apply(request: ApplyRequest): Promise<ApplyResult> {
    const startedAt = Date.now();
    const { plan, downgrades } = negotiate(request.plan, this.capabilities);
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

/** Exported so the XML can be checked without touching the filesystem. */
export function buildFcpXml(
  plan: EditPlan,
  request: ApplyRequest,
  warnings: string[] = [],
): string {
  const { frame_rate_num: rateNum, frame_rate_den: rateDen } = plan.sequence;
  // NTSC rates are written as the rounded timebase plus a flag, which is how
  // this format has always represented 29.97 and 23.976.
  const ntsc = rateDen !== 1;
  const timebase = Math.round(rateNum / rateDen);
  const frames = (ms: number): number => msToFrames(ms, rateNum, rateDen);

  const operations = operationsInOrder(plan);
  const sequenceFrames = frames(
    operations.reduce(
      (end, operation) =>
        Math.max(end, operation.timeline_start_ms + operationTimelineDuration(operation)),
      0,
    ),
  );

  // One <file> definition per asset; later clips reference it by id, which is
  // what stops a fifty-clip sequence from declaring the same media fifty times
  // and importing it as fifty master clips.
  const fileIds = new Map<string, string>();
  const lines: string[] = [];

  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<!DOCTYPE xmeml>');
  lines.push('<xmeml version="4">');
  lines.push('  <sequence id="sequence-1">');
  lines.push(`    <name>${escapeXml(plan.sequence.name)}</name>`);
  lines.push(`    <duration>${sequenceFrames}</duration>`);
  lines.push(rateElement(timebase, ntsc, 4));
  lines.push('    <media>');
  lines.push('      <video>');
  lines.push('        <format>');
  lines.push('          <samplecharacteristics>');
  lines.push(rateElement(timebase, ntsc, 12));
  lines.push(`            <width>${plan.sequence.width}</width>`);
  lines.push(`            <height>${plan.sequence.height}</height>`);
  lines.push('            <pixelaspectratio>square</pixelaspectratio>');
  lines.push('          </samplecharacteristics>');
  lines.push('        </format>');

  const tracks = new Map<number, typeof operations>();
  for (const operation of operations) {
    const list = tracks.get(operation.track) ?? [];
    list.push(operation);
    tracks.set(operation.track, list);
  }

  for (const [trackIndex, trackOperations] of [...tracks.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push('        <track>');
    for (const [index, operation] of trackOperations.entries()) {
      const asset = request.ir.assets.find((a) => a.id === operation.source_asset_id);
      const path = resolveAssetPath(request, operation.source_asset_id);
      if (!asset || !path) {
        warnings.push(
          `${operation.operation_id} refers to ${operation.source_asset_id}, which has no file`,
        );
        continue;
      }

      const clipId = `clipitem-${trackIndex + 1}-${index + 1}`;
      const span = spanOf(operation, trackOperations[index + 1], frames);
      const { start: timelineStart, end: timelineEnd, in: sourceIn, out: sourceOut } = span;

      lines.push(`          <clipitem id="${clipId}">`);
      lines.push(`            <name>${escapeXml(asset.file_name)}</name>`);
      lines.push(`            <duration>${frames(asset.duration_ms)}</duration>`);
      lines.push(rateElement(timebase, ntsc, 12));
      lines.push(`            <start>${timelineStart}</start>`);
      lines.push(`            <end>${timelineEnd}</end>`);
      lines.push(`            <in>${sourceIn}</in>`);
      lines.push(`            <out>${sourceOut}</out>`);
      lines.push('            <enabled>TRUE</enabled>');

      const existing = fileIds.get(asset.id);
      if (existing) {
        lines.push(`            <file id="${existing}"/>`);
      } else {
        const fileId = `file-${fileIds.size + 1}`;
        fileIds.set(asset.id, fileId);
        lines.push(`            <file id="${fileId}">`);
        lines.push(`              <name>${escapeXml(asset.file_name)}</name>`);
        lines.push(`              <pathurl>${escapeXml(toFileUrl(path))}</pathurl>`);
        lines.push(rateElement(timebase, ntsc, 14));
        lines.push(`              <duration>${frames(asset.duration_ms)}</duration>`);
        lines.push('              <media>');
        lines.push('                <video>');
        lines.push('                  <samplecharacteristics>');
        lines.push(`                    <width>${asset.width ?? plan.sequence.width}</width>`);
        lines.push(`                    <height>${asset.height ?? plan.sequence.height}</height>`);
        lines.push('                  </samplecharacteristics>');
        lines.push('                </video>');
        if (asset.audio_channels && asset.audio_channels > 0) {
          lines.push('                <audio>');
          lines.push(`                  <channelcount>${asset.audio_channels}</channelcount>`);
          lines.push('                </audio>');
        }
        lines.push('              </media>');
        lines.push('            </file>');
      }

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

      lines.push('          </clipitem>');

      // The transition into the *next* clip, written between the two clipitems
      // it joins, which is where this format expects it.
      const next = trackOperations[index + 1];
      if (next) {
        const item = transitionItem(
          operation,
          next,
          span,
          request,
          timebase,
          ntsc,
          frames,
          warnings,
        );
        if (item) lines.push(...item);
      }
    }
    lines.push('        </track>');
  }

  lines.push('      </video>');

  // ---- audio ---------------------------------------------------------------
  // A cut with no sound is not a rough cut. The plan names which clips carry
  // their own audio and declares the tracks to lay it on; both were read here
  // and neither was written, so every sequence imported silent while the
  // capabilities advertised two audio tracks.
  //
  // FCP7 XML links picture and sound by `linkclipref`: one video clipitem and
  // its audio clipitems name each other, and the editor sees them as one clip
  // that can still be unlinked.
  lines.push('      <audio>');
  lines.push('        <numOutputChannels>2</numOutputChannels>');

  const sourceAudio = plan.tracks.audio.filter((spec) => spec.type === 'source_audio');
  if (plan.tracks.audio.some((spec) => spec.type === 'external')) {
    warnings.push('an external audio bed was asked for; this adapter writes source audio only');
  }

  // One track per channel of a stereo source, which is what the format expects
  // and what an editor opening a sequence expects to find under the picture.
  const AUDIO_CHANNELS = 2;

  for (const spec of sourceAudio) {
    for (let channel = 0; channel < AUDIO_CHANNELS; channel++) {
      const written: string[] = [];
      for (const [index, operation] of operations.entries()) {
        if (!operation.use_source_audio) continue;
        const asset = request.ir.assets.find((a) => a.id === operation.source_asset_id);
        const fileId = fileIds.get(operation.source_asset_id);
        if (!asset || !fileId) continue;

        const span = spanOf(operation, operations[index + 1], frames);
        const clipId = `clipitem-a${spec.track + 1}-${channel + 1}-${index + 1}`;

        written.push(`          <clipitem id="${clipId}">`);
        written.push(`            <name>${escapeXml(asset.file_name)}</name>`);
        written.push(`            <duration>${frames(asset.duration_ms)}</duration>`);
        written.push(rateElement(timebase, ntsc, 12));
        written.push(`            <start>${span.start}</start>`);
        written.push(`            <end>${span.end}</end>`);
        written.push(`            <in>${span.in}</in>`);
        written.push(`            <out>${span.out}</out>`);
        written.push('            <enabled>TRUE</enabled>');
        written.push(`            <file id="${fileId}"/>`);
        written.push('            <sourcetrack>');
        written.push('              <mediatype>audio</mediatype>');
        written.push(`              <trackindex>${channel + 1}</trackindex>`);
        written.push('            </sourcetrack>');
        // Names the picture this sound belongs to, so the editor links them.
        written.push('            <link>');
        written.push(`              <linkclipref>clipitem-1-${index + 1}</linkclipref>`);
        written.push('            </link>');
        written.push('            <link>');
        written.push(`              <linkclipref>${clipId}</linkclipref>`);
        written.push('            </link>');
        written.push('          </clipitem>');
      }

      if (written.length === 0) continue;
      lines.push('        <track>');
      lines.push(...written);
      lines.push('        </track>');
    }
  }

  lines.push('      </audio>');
  lines.push('    </media>');
  lines.push('  </sequence>');
  lines.push('</xmeml>');

  return `${lines.join('\n')}\n`;
}

/**
 * One clip, laid on the frame grid.
 *
 * A sequence is frames, not milliseconds, and three things have to hold at once:
 * a clip's two lengths must agree (`end - start` and `out - in`), no clip may
 * start before the one before it ends, and the cut must not gain gaps the plan
 * did not ask for. Rounding each edge independently from milliseconds satisfies
 * none of them reliably — it made the two lengths differ by a frame on 14 of the
 * 39 clips in the worked example, and fixing that alone pushed one clip's end a
 * frame past the next clip's start.
 *
 * So the length is decided once, on the grid, and the source out is derived from
 * it. Where the next clip starts sooner than this one's rounded length would
 * end, the length gives way: an overlap is a thing a sequence cannot represent,
 * and the importer resolves it by guessing.
 */
function spanOf(
  operation: VideoOperation,
  next: VideoOperation | undefined,
  frames: (ms: number) => number,
): { start: number; end: number; in: number; out: number } {
  const start = frames(operation.timeline_start_ms);
  const wanted = Math.max(1, frames(operationTimelineDuration(operation)));
  const nextStart = next ? frames(next.timeline_start_ms) : undefined;
  const length =
    nextStart !== undefined && nextStart > start ? Math.min(wanted, nextStart - start) : wanted;
  const sourceIn = frames(operation.source_in_ms);
  return { start, end: start + length, in: sourceIn, out: sourceIn + length };
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
 * The dissolve between two clips.
 *
 * The capabilities advertised `basic_transition` and three dissolve types, so
 * negotiation let every transition through untouched — and nothing wrote one.
 * A skill asking for a dissolve at a chapter change produced a sequence of hard
 * cuts, with no downgrade recorded to say the request had been dropped.
 *
 * A dissolve is not free: it is made of frames neither clip is using, taken
 * from beyond the outgoing clip's out point and from before the incoming
 * clip's in point. Writing one the media cannot supply is how an FCP7 XML
 * imports with clips in the wrong places, so the length is cut to the handles
 * that exist, and a cut with no handles at all stays a cut and says so.
 */
function transitionItem(
  outgoing: VideoOperation,
  incoming: VideoOperation,
  span: { start: number; end: number; in: number; out: number },
  request: ApplyRequest,
  timebase: number,
  ntsc: boolean,
  frames: (ms: number) => number,
  warnings: string[],
): string[] | undefined {
  const transition = incoming.transition_in ?? outgoing.transition_out;
  if (!transition || transition.type === 'hard_cut') return undefined;
  const effect = TRANSITION_EFFECTS[transition.type];
  if (!effect) return undefined;

  const wanted = frames(transition.duration_ms);
  if (wanted < 1) return undefined;

  // Handles: what the outgoing clip has left after its out point, and what the
  // incoming clip has before its in point.
  const outgoingAsset = request.ir.assets.find((a) => a.id === outgoing.source_asset_id);
  const incomingAsset = request.ir.assets.find((a) => a.id === incoming.source_asset_id);
  const after = outgoingAsset ? Math.max(0, frames(outgoingAsset.duration_ms) - span.out) : 0;
  const before = incomingAsset ? Math.max(0, frames(incoming.source_in_ms)) : 0;

  // Centred, so each side gives half. The shorter handle decides.
  const half = Math.min(Math.floor(wanted / 2), after, before);
  if (half < 1) {
    warnings.push(
      `${incoming.operation_id} asked for a ${transition.type}, and there is not enough footage ` +
        'either side of the cut to make one; it stays a hard cut',
    );
    return undefined;
  }

  const cut = span.end;
  const start = cut - half;
  const end = cut + half;

  return [
    '          <transitionitem>',
    `            <start>${start}</start>`,
    `            <end>${end}</end>`,
    '            <alignment>center</alignment>',
    rateElement(timebase, ntsc, 12),
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

/**
 * Characters XML 1.0 cannot represent at all.
 *
 * Matching control characters is the whole point here, so the rule that warns
 * about them has nothing useful to say.
 */
// eslint-disable-next-line no-control-regex
const UNREPRESENTABLE = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]', 'g');

/**
 * Escapes text for XML.
 *
 * Not optional: file names and event descriptions in this project are user
 * content, routinely contain ampersands and Japanese punctuation, and one
 * unescaped ampersand makes the whole file unopenable.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(UNREPRESENTABLE, '');
}
