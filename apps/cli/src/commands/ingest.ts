import { ingestPaths, placeAssets } from '@editorial-ir/core';
import { formatTimecode } from '@editorial-ir/contracts';
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
  const backends = resolveBackends({ ...(args.perception ? { perception: args.perception } : {}) });
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

    success(`${result.added.length} added, ${result.assets.length} in the project`);

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

    if (result.failed.length > 0) {
      heading('could not read');
      for (const failure of result.failed) fail(`  ${failure.path}: ${failure.reason}`);
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
