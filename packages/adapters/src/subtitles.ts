import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AdapterCapabilities,
  type ApplyResult,
  type EditPlan,
  type TextOperation,
} from '@editorial-ir/contracts';
import type { ApplyRequest, EditorAdapter } from './types.js';

/**
 * Caption files: SubRip (.srt) and WebVTT (.vtt).
 *
 * They write the plan's caption operations and nothing else. Working the
 * captions out — which words are heard in which clip, where each line breaks —
 * is planning, and happens before an adapter is called (`buildCaptions` in the
 * agent, run by `oea plan --captions` or by `oea apply` when the plan has none).
 * An adapter that read the transcript out of the IR itself would be a second
 * planner, and the one place the two could disagree is the subtitle a viewer
 * reads.
 */
/**
 * What a caption file can hold: captions, and nothing about the picture.
 *
 * Declared as it is rather than generously. A subtitle file is written beside
 * the NLE files, not instead of them, so these adapters do not negotiate the
 * picture at all — there is nothing to downgrade in a file that never held it.
 */
const SIDECAR = {
  mode: 'file',
  text: false,
  captions: true,
  markers: false,
  basic_transition: false,
  speed_change: false,
  still_images: false,
  audio_tracks: 0,
  max_video_tracks: 1,
} as const;

export const SRT_CAPABILITIES: AdapterCapabilities = AdapterCapabilities.parse({
  ...SIDECAR,
  id: 'srt',
  name: 'SubRip subtitles',
  output_extensions: ['.srt'],
  notes: [
    'The plan’s captions as numbered cues with comma milliseconds; YouTube, Premiere and Resolve all import it.',
    '`oea apply --editor srt` works the captions out from the transcript when the plan has none.',
  ],
});

export const VTT_CAPABILITIES: AdapterCapabilities = AdapterCapabilities.parse({
  ...SIDECAR,
  id: 'vtt',
  name: 'WebVTT subtitles',
  output_extensions: ['.vtt'],
  notes: [
    'The plan’s captions as a WebVTT file, for the web’s <track> element and most players.',
    '`oea apply --editor vtt` works the captions out from the transcript when the plan has none.',
  ],
});

/** The captions a subtitle file carries, in the order they are shown. */
export function captionCues(plan: EditPlan): TextOperation[] {
  return plan.tracks.text
    .filter((text) => text.kind === 'caption' && text.timeline_end_ms > text.timeline_start_ms)
    .sort(
      (a, b) =>
        a.timeline_start_ms - b.timeline_start_ms ||
        (a.operation_id < b.operation_id ? -1 : a.operation_id > b.operation_id ? 1 : 0),
    );
}

/** `HH:MM:SS,mmm` for SubRip, `HH:MM:SS.mmm` for WebVTT. */
export function cueTime(ms: number, separator: ',' | '.'): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(h)}:${two(m)}:${two(s)}${separator}${String(t % 1000).padStart(3, '0')}`;
}

/**
 * The lines of a cue's text.
 *
 * A blank line ends a cue in both formats, so a caption with an empty line in
 * it would end early and turn its second half into garbage the player skips.
 */
function cueLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** A SubRip document: cues numbered from 1, milliseconds after a comma. */
export function buildSrt(plan: EditPlan): string {
  const blocks = captionCues(plan).map((cue, index) =>
    [
      String(index + 1),
      `${cueTime(cue.timeline_start_ms, ',')} --> ${cueTime(cue.timeline_end_ms, ',')}`,
      ...cueLines(cue.text),
    ].join('\n'),
  );
  return blocks.length === 0 ? '' : `${blocks.join('\n\n')}\n`;
}

/**
 * A WebVTT document.
 *
 * Cue text is markup in WebVTT, so `&` and `<` are escaped — a caption reading
 * "R&D <3" is otherwise a parse error or a stray tag — and `-->`, which would
 * end the cue's timing line if it began one, is written as an arrow.
 */
export function buildVtt(plan: EditPlan): string {
  const escape = (line: string): string =>
    line
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/--&gt;/g, '→');
  const blocks = captionCues(plan).map((cue) =>
    [
      `${cueTime(cue.timeline_start_ms, '.')} --> ${cueTime(cue.timeline_end_ms, '.')}`,
      ...cueLines(cue.text).map(escape),
    ].join('\n'),
  );
  return `WEBVTT\n\n${blocks.join('\n\n')}${blocks.length > 0 ? '\n' : ''}`;
}

abstract class SubtitleAdapter implements EditorAdapter {
  abstract readonly capabilities: AdapterCapabilities;
  protected abstract readonly extension: string;
  protected abstract build(plan: EditPlan): string;

  async apply(request: ApplyRequest): Promise<ApplyResult> {
    const startedAt = Date.now();
    const warnings: string[] = [];
    const cues = captionCues(request.plan);
    const other = request.plan.tracks.text.length - cues.length;
    if (other > 0) {
      warnings.push(
        `${other} title(s) and lower third(s) are not captions and are not in a subtitle file`,
      );
    }
    if (cues.length === 0) {
      warnings.push(
        'the plan has no captions, so nothing was written; "oea plan --captions" and ' +
          '"oea apply --editor srt" work them out from the transcript, when the analysis has one',
      );
      return {
        adapter: this.capabilities.id,
        artifacts: [],
        downgrades: [],
        warnings,
        elapsed_ms: Date.now() - startedAt,
      };
    }

    const name = request.name ?? 'timeline';
    mkdirSync(request.outputDir, { recursive: true });
    const path = join(request.outputDir, `${name}${this.extension}`);
    writeFileSync(path, this.build(request.plan));
    return {
      adapter: this.capabilities.id,
      artifacts: [
        {
          path,
          kind: 'subtitles',
          description: `${cues.length} caption(s), timed to the cut.`,
          byte_size: statSync(path).size,
        },
      ],
      downgrades: [],
      warnings,
      elapsed_ms: Date.now() - startedAt,
    };
  }
}

export class SrtAdapter extends SubtitleAdapter {
  readonly capabilities = SRT_CAPABILITIES;
  protected readonly extension = '.srt';
  protected build(plan: EditPlan): string {
    return buildSrt(plan);
  }
}

export class VttAdapter extends SubtitleAdapter {
  readonly capabilities = VTT_CAPABILITIES;
  protected readonly extension = '.vtt';
  protected build(plan: EditPlan): string {
    return buildVtt(plan);
  }
}
