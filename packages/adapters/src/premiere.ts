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
      const timelineStart = frames(operation.timeline_start_ms);
      const timelineEnd = frames(
        operation.timeline_start_ms + operationTimelineDuration(operation),
      );

      lines.push(`          <clipitem id="${clipId}">`);
      lines.push(`            <name>${escapeXml(asset.file_name)}</name>`);
      lines.push(`            <duration>${frames(asset.duration_ms)}</duration>`);
      lines.push(rateElement(timebase, ntsc, 12));
      lines.push(`            <start>${timelineStart}</start>`);
      lines.push(`            <end>${timelineEnd}</end>`);
      lines.push(`            <in>${frames(operation.source_in_ms)}</in>`);
      lines.push(`            <out>${frames(operation.source_out_ms)}</out>`);
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
    }
    lines.push('        </track>');
  }

  lines.push('      </video>');
  lines.push('      <audio>');
  lines.push('        <numOutputChannels>2</numOutputChannels>');
  lines.push('      </audio>');
  lines.push('    </media>');
  lines.push('  </sequence>');
  lines.push('</xmeml>');

  return `${lines.join('\n')}\n`;
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
