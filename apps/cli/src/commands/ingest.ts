import { ingestPaths, placeAssets } from '@editorial-ir/core';
import { formatTimecode, type MediaAsset } from '@editorial-ir/contracts';
import { resolveBackends } from '../backends.js';
import { openProject } from '../project.js';
import { Progress, detail, fail, heading, note, success, table, warn } from '../ui.js';

export interface IngestArgs {
  paths: string[];
  project?: string;
  perception?: string;
}

export async function runIngest(args: IngestArgs): Promise<number> {
  const store = openProject(args.project);
  // Ingestion reads container metadata and nothing else. It has no opinion to
  // be wrong about, so it must not be held up by a missing judgement model —
  // otherwise you could not even add footage before configuring one.
  const backends = await resolveBackends({
    ...(args.perception ? { perception: args.perception } : {}),
    mode: 'offline-minimal',
  });
  const progress = new Progress();

  try {
    const result = await ingestPaths(args.paths, {
      projectRoot: store.paths.root,
      probe: backends.suite.probe,
      cache: store.cache,
      existing: store.readAssets(),
      onProgress: (message, done, total) => progress.update('reading', message, done, total),
    });
    progress.clear();

    store.writeAssets(result.assets);
    const project = store.readProject();
    store.writeProject({ ...project, status: 'ingested', updated_at: new Date().toISOString() });

    const placements = placeAssets(result.assets);
    const total = result.assets.reduce((sum, a) => sum + a.duration_ms, 0);

    // "ok 0 added" above a list of errors is a headline contradicting its own
    // body, and this is the first command a new user runs on their own footage.
    const nothingWorked = result.added.length === 0 && result.failed.length > 0;
    if (nothingWorked) {
      fail(`could not read any of the ${result.failed.length} file(s) given`);
    } else {
      success(`${result.added.length} added, ${result.assets.length} in the project`);
    }

    if (result.added.length > 0) {
      heading('added');
      table(
        result.added.map((asset) => [
          asset.id,
          asset.path,
          formatTimecode(asset.duration_ms, false),
          asset.width ? `${asset.width}x${asset.height}` : asset.kind,
        ]),
      );
    }

    if (result.duplicates.length > 0) {
      heading('already here');
      for (const duplicate of result.duplicates) {
        note(`  ${duplicate.path} is the same content as ${duplicate.existingId}`);
      }
    }

    if (result.refreshed.length > 0) {
      // Said, because it changes what the next analysis does: a second audio
      // track now gets listened to, a phone clip gets its real frame rate.
      note(
        `  read again: ${result.refreshed.map((asset) => asset.id).join(', ')} ` +
          `(ids and order unchanged; "oea analyze" uses what was learned)`,
      );
    }

    const worthSaying = [...result.added, ...result.refreshed].flatMap((asset) =>
      mediaNotes(asset).map((line) => `  ${asset.id} ${asset.file_name}: ${line}`),
    );
    if (worthSaying.length > 0) {
      heading('worth knowing');
      for (const line of worthSaying) note(line);
    }

    if (result.failed.length > 0) {
      heading('could not read');
      const fixes = new Set<string>();
      for (const failure of result.failed) {
        fail(`  ${failure.path}: ${failure.reason}`);
        if (failure.fix) fixes.add(failure.fix);
      }
      // One remedy, once, rather than repeated under every file that hit it.
      for (const fix of fixes) note(`  ${fix}`);
    }

    if (nothingWorked) {
      note('Nothing was added, so there is no timeline yet.');
      note('Run "oea doctor" to see what is installed.');
      return 1;
    }

    heading('the capture timeline');
    detail('length', formatTimecode(total, false));
    detail('ordered by', placements[0]?.ordered_by ?? 'file_name');
    if (placements[0]?.ordered_by === 'file_name') {
      warn('no capture times in the metadata, so file name decides the order');
      note('  A wrong order invents continuity that was never there; check it.');
    }

    return result.failed.length > 0 ? 1 : 0;
  } finally {
    progress.clear();
    await backends.close();
  }
}

/**
 * The facts about a file that change what happens to it, in words.
 *
 * Each of these used to be silent and wrong: a clip with no sound was put
 * through three audio stages, a second audio track was never heard, a phone
 * clip's dropped frames set the sequence rate.
 */
export function mediaNotes(asset: MediaAsset): string[] {
  const notes: string[] = [];
  const streams = asset.audio_streams;
  if (asset.kind === 'video' && streams !== undefined && streams.length === 0) {
    notes.push('no audio track; nothing will be transcribed, and that is not an error');
  }
  if (streams !== undefined && streams.length > 1) {
    notes.push(
      `${streams.length} audio streams; the one with the most speech is analysed, ` +
        'and the analysis says which',
    );
  }
  if (asset.variable_frame_rate && asset.fps !== undefined) {
    const average = asset.avg_fps === undefined ? '' : ` (averaging ${asset.avg_fps.toFixed(2)})`;
    notes.push(
      `variable frame rate${average}; treated as ${Number(asset.fps.toFixed(3))} fps, ` +
        'the rate an editor will conform it to',
    );
  }
  return notes;
}
