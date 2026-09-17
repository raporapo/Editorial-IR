import {
  EditorialError,
  assessmentFor,
  formatTimecode,
  type SemanticEvent,
} from '@editorial-ir/contracts';
import { openProject } from '../project.js';
import { bar, colour, heading, line, note, table, truncate } from '../ui.js';
import { requireIr } from '../ir.js';

export interface TimelineArgs {
  project?: string;
  json?: boolean;
  chapter?: string;
  full?: boolean;
}

/**
 * The semantic timeline.
 *
 * The first genuinely useful interface this project has is not an editor: it is
 * a view of what the machine understood, in a form a person can correct. Almost
 * every bad automatic edit traces back to a misunderstanding visible here.
 */
export function runTimeline(args: TimelineArgs): number {
  const store = openProject(args.project);
  const ir = requireIr(store);

  // Filtered before either branch, because `--chapter` used to apply to the
  // text output and not to `--json`: a script asking for one chapter was handed
  // the whole timeline, with nothing said and exit 0.
  const chapters = args.chapter ? ir.chapters.filter((c) => c.id === args.chapter) : ir.chapters;

  // And an id that names nothing is a mistake, not an empty project. It used to
  // print "nothing here yet. Run oea analyze first." at somebody whose project
  // was already analysed, sending them to re-run the expensive part.
  if (args.chapter && chapters.length === 0) {
    throw new EditorialError('not_found', `there is no chapter called "${args.chapter}"`, {
      available:
        ir.chapters.length === 0
          ? 'this analysis produced no chapters'
          : ir.chapters.map((c) => c.id).join(', '),
    });
  }

  if (args.json) {
    line(
      JSON.stringify(
        chapters.map((chapter) => ({ ...chapter, events: chapter.event_ids })),
        null,
        2,
      ),
    );
    return 0;
  }

  for (const chapter of chapters) {
    heading(
      `${formatTimecode(chapter.start_ms, false)} - ${formatTimecode(chapter.end_ms, false)}  ${chapter.title.value}`,
    );

    const rows: string[][] = [];
    for (const eventId of chapter.event_ids) {
      const event = ir.events.find((e) => e.id === eventId);
      if (!event) continue;
      const assessment = assessmentFor(ir, eventId);
      const importance = assessment?.metrics.story_importance ?? 0;
      const seconds = Math.round((event.end_ms - event.start_ms) / 1000);

      rows.push([
        colour.grey(event.id),
        formatTimecode(event.start_ms, false),
        `${String(seconds).padStart(3)}s`,
        bar(importance, 8),
        colour.cyan((assessment?.narrative_role.selected ?? '').padEnd(10)),
        markers(event),
        truncate(event.title?.value ?? event.description.value, args.full ? 200 : 52),
      ]);
    }
    table(rows);
  }

  if (chapters.length === 0) note('nothing here yet. Run "oea analyze" first.');
  else {
    line();
    note('The bar is story importance. To change one, use an annotation:');
    note('  oea annotate <event> essential      keep it, whatever it scores');
    note('  oea annotate <event> exclude        never use it');
  }
  return 0;
}

function markers(event: SemanticEvent): string {
  const marks: string[] = [];
  if (event.knowledge.essential) marks.push(colour.green('keep'));
  if (event.knowledge.excluded) marks.push(colour.red('drop'));
  if (event.observed.speech.length > 0) marks.push(colour.grey('talk'));
  if (event.observed.ocr.length > 0) marks.push(colour.grey('text'));
  return marks.join(' ').padEnd(12);
}
