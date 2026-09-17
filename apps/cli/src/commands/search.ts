import {
  EMBEDDING_KINDS,
  EditorialError,
  assessmentFor,
  formatTimecode,
  type EmbeddingKind,
} from '@editorial-ir/contracts';
import { openProject } from '../project.js';
import { openIndex, requireIr } from '../ir.js';
import { bar, colour, heading, line, note, table, truncate } from '../ui.js';

export interface SearchArgs {
  query: string;
  project?: string;
  aspect?: string;
  limit?: number;
  json?: boolean;
}

export async function runSearch(args: SearchArgs): Promise<number> {
  const store = openProject(args.project);
  const ir = requireIr(store);
  const index = openIndex(store, ir);

  // Checked rather than cast. `--aspect audoi` used to search descriptions and
  // report "nothing matched", while `--aspect visuals` returned ten hits whose
  // "which aspect matched" column named an aspect that does not exist — the
  // cast made every misspelling look like an answer.
  let aspect: EmbeddingKind[] | undefined;
  if (args.aspect && args.aspect !== 'any') {
    const known = EMBEDDING_KINDS.find((kind) => kind === args.aspect);
    if (!known) {
      throw new EditorialError('invalid_input', `there is no aspect called "${args.aspect}"`, {
        available: [...EMBEDDING_KINDS, 'any'].join(', '),
      });
    }
    aspect = [known];
  }
  const hits = await index.search(args.query, {
    limit: args.limit ?? 10,
    // Below this a match is coincidence rather than a result, and a list of
    // confident-looking noise is worse than an empty one.
    minScore: 0.15,
    ...(aspect ? { kinds: aspect } : {}),
  });

  if (args.json) {
    line(JSON.stringify(hits, null, 2));
    return 0;
  }

  if (hits.length === 0) {
    note(`nothing matched "${args.query}"`);
    note('The default index is lexical, not semantic: it finds the words that are there,');
    note('so it will not find "night view" for 夜景, or the reverse.');
    note('Set OEA_EMBED_BASE_URL and OEA_EMBED_MODEL for meaning-based search.');
    return 0;
  }

  heading(`${hits.length} result(s) for "${args.query}"`);
  table(
    hits.map((hit) => {
      const event = ir.events.find((e) => e.id === hit.event_id);
      const assessment = assessmentFor(ir, hit.event_id);
      return [
        colour.grey(hit.event_id),
        event ? formatTimecode(event.start_ms, false) : '',
        bar(hit.score, 8),
        colour.cyan(hit.kind.padEnd(8)),
        bar(assessment?.metrics.story_importance ?? 0, 5),
        truncate(hit.snippet, 48),
      ];
    }),
  );
  line();
  note('Columns: id, position, match, which aspect matched, importance, what matched.');

  const unsearchable = index.lastDiagnostics.unsearchableKinds;
  if (unsearchable.length > 0) {
    note(
      `The ${unsearchable.join(' and ')} aspect${unsearchable.length > 1 ? 's were' : ' was'} matched on text alone:`,
    );
    note('its vectors come from a different model, and comparing across spaces would be noise.');
  }
  return 0;
}
