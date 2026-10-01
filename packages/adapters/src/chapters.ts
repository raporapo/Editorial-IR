import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AdapterCapabilities,
  planDurationMs,
  type ApplyResult,
  type EditPlan,
} from '@editorial-ir/contracts';
import type { ApplyRequest, EditorAdapter } from './types.js';

/**
 * Chapters for a YouTube description: `00:00 Title`, one per line.
 *
 * YouTube shows chapters only when the list obeys three rules — the first starts
 * at 00:00, there are at least three, and each is at least ten seconds long —
 * and when it does not, it shows none and says nothing. A cut's chapters break
 * those rules routinely: on the worked example six of the twelve chapter runs
 * are 3.4 to 8.8 seconds long, and a hook-first cut can open on the middle of
 * the story. So the rules are applied here, and every chapter moved, merged or
 * left out is named in the result, because a chapter that silently disappeared
 * is one the user will go looking for.
 */
export const YOUTUBE_CHAPTERS_CAPABILITIES: AdapterCapabilities = AdapterCapabilities.parse({
  id: 'youtube-chapters',
  name: 'YouTube chapters',
  mode: 'file',
  output_extensions: ['.chapters.txt'],
  text: false,
  captions: false,
  markers: true,
  basic_transition: false,
  speed_change: false,
  still_images: false,
  audio_tracks: 0,
  max_video_tracks: 1,
  notes: [
    'The plan’s chapter markers as "00:00 Title" lines to paste into a video description.',
    'YouTube’s rules are applied: the first chapter at 00:00, at least three, each at least 10 s; a short chapter is merged into the one before it, and the result says which.',
  ],
});

/** YouTube's shortest chapter. */
export const YOUTUBE_MIN_CHAPTER_S = 10;
/** YouTube's fewest chapters. */
export const YOUTUBE_MIN_CHAPTERS = 3;

export interface ChapterLine {
  /** Whole seconds from the start of the cut. */
  seconds: number;
  title: string;
}

/**
 * The chapter list YouTube will accept, or undefined when none is possible.
 *
 * Times are whole seconds because that is all a description can say, rounded to
 * the nearest: a chapter written a fraction early shows its title over the last
 * moment of the one before, and one written late skips the first moment of its
 * own. The rules are checked on the rounded numbers, since those are the ones
 * YouTube reads.
 *
 * A chapter that is too short is merged into the one before it — its content is
 * still there, under the previous title — except the first, which absorbs the
 * one after it, since nothing comes before 00:00.
 */
export function youtubeChapters(plan: EditPlan, notes: string[] = []): ChapterLine[] | undefined {
  const total = Math.floor(planDurationMs(plan) / 1000);
  const lines: ChapterLine[] = [];
  const markers = plan.markers
    .filter((marker) => marker.kind === 'chapter')
    .sort((a, b) => a.timeline_ms - b.timeline_ms);

  for (const marker of markers) {
    const title = marker.name.replace(/\s+/g, ' ').trim();
    const seconds = Math.round(marker.timeline_ms / 1000);
    if (title.length === 0) continue;
    if (seconds >= total) {
      notes.push(`“${title}” starts at the very end of the cut and was left out`);
      continue;
    }
    const previous = lines.at(-1);
    if (previous && previous.title === title) {
      notes.push(
        `“${title}” at ${formatChapterTime(seconds, total)} continues the chapter before it and was merged into it`,
      );
      continue;
    }
    if (previous && previous.seconds === seconds) {
      notes.push(
        `“${previous.title}” and “${title}” start in the same second; “${title}” was kept`,
      );
      lines.pop();
    }
    lines.push({ seconds, title });
  }

  if (lines.length === 0) {
    notes.push('the plan has no chapter markers');
    return undefined;
  }

  if (lines[0]!.seconds > 0) {
    notes.push(
      `“${lines[0]!.title}” was moved from ${formatChapterTime(lines[0]!.seconds, total)} to 00:00: ` +
        'YouTube needs the first chapter to start the video',
    );
    lines[0] = { ...lines[0]!, seconds: 0 };
  }

  const lengthOf = (index: number): number =>
    (lines[index + 1]?.seconds ?? total) - lines[index]!.seconds;

  for (;;) {
    const short = lines.findIndex((_, index) => lengthOf(index) < YOUTUBE_MIN_CHAPTER_S);
    if (short === -1 || lines.length === 1) break;
    if (short === 0) {
      const absorbed = lines[1]!;
      notes.push(
        `“${lines[0]!.title}” was ${lengthOf(0)} s, under YouTube’s ${YOUTUBE_MIN_CHAPTER_S} s; ` +
          `“${absorbed.title}” (${formatChapterTime(absorbed.seconds, total)}) was merged into it`,
      );
      lines.splice(1, 1);
    } else {
      const merged = lines[short]!;
      notes.push(
        `“${merged.title}” (${formatChapterTime(merged.seconds, total)}) was ${lengthOf(short)} s, ` +
          `under YouTube’s ${YOUTUBE_MIN_CHAPTER_S} s; merged into “${lines[short - 1]!.title}”`,
      );
      lines.splice(short, 1);
    }
  }

  if (lines.length < YOUTUBE_MIN_CHAPTERS || lengthOf(0) < YOUTUBE_MIN_CHAPTER_S) {
    notes.push(
      `YouTube shows chapters only when there are at least ${YOUTUBE_MIN_CHAPTERS} of ` +
        `${YOUTUBE_MIN_CHAPTER_S} s or more; this cut has ${lines.length} after merging, so none were written`,
    );
    return undefined;
  }
  return lines;
}

/** `MM:SS`, or `H:MM:SS` for a video an hour or longer, as YouTube reads them. */
export function formatChapterTime(seconds: number, totalSeconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const two = (n: number) => String(n).padStart(2, '0');
  if (totalSeconds >= 3600) {
    return `${Math.floor(s / 3600)}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
  }
  return `${two(Math.floor(s / 60))}:${two(s % 60)}`;
}

/** The description block: one `00:00 Title` line per chapter. */
export function buildYoutubeChapters(plan: EditPlan, notes: string[] = []): string | undefined {
  const lines = youtubeChapters(plan, notes);
  if (!lines) return undefined;
  const total = Math.floor(planDurationMs(plan) / 1000);
  return `${lines.map((line) => `${formatChapterTime(line.seconds, total)} ${line.title}`).join('\n')}\n`;
}

export class YoutubeChaptersAdapter implements EditorAdapter {
  readonly capabilities = YOUTUBE_CHAPTERS_CAPABILITIES;

  async apply(request: ApplyRequest): Promise<ApplyResult> {
    const startedAt = Date.now();
    const warnings: string[] = [];
    const text = buildYoutubeChapters(request.plan, warnings);
    if (text === undefined) {
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
    const path = join(request.outputDir, `${name}.chapters.txt`);
    writeFileSync(path, text);
    return {
      adapter: this.capabilities.id,
      artifacts: [
        {
          path,
          kind: 'chapters',
          description: `${text.trim().split('\n').length} chapters, to paste into the video description.`,
          byte_size: statSync(path).size,
        },
      ],
      downgrades: [],
      warnings,
      elapsed_ms: Date.now() - startedAt,
    };
  }
}
