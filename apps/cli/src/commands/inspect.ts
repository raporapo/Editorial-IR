import { formatTimecode } from '@editorial-ir/contracts';
import { AgentToolkit } from '@editorial-ir/agent';
import { openProject } from '../project.js';
import { openInspection, requireIr } from '../ir.js';
import { colour, detail, fail, heading, line, note, success, table } from '../ui.js';

export interface InspectArgs {
  target: string;
  project?: string;
  shots?: boolean;
  frames?: boolean;
  sheet?: boolean;
  json?: boolean;
}

/**
 * Looking closer at one moment.
 *
 * The representation is a hierarchy and almost everything happens at the event
 * layer, because that is where editing decisions are made and where an hour of
 * footage is small enough to think about. This command is the staircase down:
 * the shots an event is made of, the frames those shots are made of, and — when
 * you actually need to see it — one image with the frames laid out in order.
 *
 * Deliberately a separate verb from `explain`. That one answers "why was this
 * kept or cut", from the record. This one answers "what is actually in there",
 * from the material, and each step down costs more than the one above it.
 */
export async function runInspect(args: InspectArgs): Promise<number> {
  const store = openProject(args.project);
  const ir = requireIr(store);
  const inspection = openInspection(store, ir);
  const toolkit = new AgentToolkit(ir, undefined, inspection);

  const event = ir.events.find((e) => e.id === args.target);
  if (!event) {
    fail(`no event called ${args.target}`);
    note('Run "oea timeline" for the ids in this project.');
    return 1;
  }

  // Nothing asked for means everything cheap: the shots, and whether there is
  // anything to look at. Frames and the contact sheet are opt-in because one
  // costs a directory listing and the other costs an ffmpeg run.
  const wantShots = args.shots || (!args.frames && !args.sheet);
  const shots = wantShots ? toolkit.listShots(event.id) : [];
  const frames =
    args.frames || args.sheet
      ? toolkit.listFrames(event.id, { perShot: args.frames === true })
      : [];

  let sheetPath: string | undefined;
  if (args.sheet) {
    if (frames.length === 0) {
      fail('there are no sampled frames for this moment');
      note('Frames are written during "oea ingest", and only for real video files.');
      note('The worked example replays a recorded analysis, so it has none.');
      return 1;
    }
    sheetPath = await toolkit.getContactSheet(event.id);
  }

  if (args.json) {
    line(
      JSON.stringify(
        {
          event_id: event.id,
          shots: shots.map((s) => ({ ...s.shot, offset_ms: s.offset_ms, whole: s.whole })),
          frames,
          ...(sheetPath ? { contact_sheet: sheetPath } : {}),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  heading(
    `${event.id}  ${formatTimecode(event.start_ms, false)} - ${formatTimecode(event.end_ms, false)}`,
  );
  line(`  ${event.description.value}`);

  if (wantShots) {
    heading(`shots (${shots.length})`);
    if (shots.length === 0) {
      note('  no shot boundaries were detected inside this event');
    } else {
      table(
        shots.map((s) => [
          colour.grey(s.shot.id),
          formatTimecode(s.offset_ms, false),
          `${String(Math.round(s.duration_ms / 100) / 10).padStart(5)}s`,
          s.whole ? '' : colour.grey('clipped by the event edge'),
        ]),
      );
    }
  }

  if (args.frames) {
    heading(`frames (${frames.length})`);
    if (frames.length === 0) {
      note('  this project has no sampled frames');
      note('  They are written during "oea ingest", and only for real video files.');
    } else {
      for (const frame of frames) {
        detail(formatTimecode(frame.source_ms, false), frame.path);
      }
    }
  }

  if (sheetPath) {
    success(`wrote a contact sheet of ${frames.length} frames`);
    line(`  ${sheetPath}`);
  }

  if (wantShots && shots.length > 0 && !args.frames && !args.sheet) {
    line();
    note('oea inspect <event> --frames   the frames behind those shots');
    note('oea inspect <event> --sheet    all of them as one image');
  }
  return 0;
}
