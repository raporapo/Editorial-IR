import {
  EMBEDDING_KINDS,
  EditorialError,
  assessmentFor,
  formatTimecode,
  type EmbeddingKind,
} from '@editorial-ir/contracts';
import { openProject } from '../project.js';
import { openSearchableIndex, requireIr } from '../ir.js';
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
  const opened = await openSearchableIndex(store, ir);
  try {
    return await search(args, ir, opened);
  } finally {
    // A worker left running holds a model in memory and the process open.
    await opened.close();
  }
}

async function search(
  args: SearchArgs,
  ir: ReturnType<typeof requireIr>,
  opened: Awaited<ReturnType<typeof openSearchableIndex>>,
): Promise<number> {
  const { index, indexedWith, queryingWith, lexical } = opened;
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
    // Only when it is true. This advice was printed unconditionally, including
    // to someone whose project *was* embedded with a real model — which made
    // the one situation worth reporting, an index nothing here can query, read
    // as the expected state of affairs.
    if (lexical) {
      note('This index is being searched lexically: it finds the words that are there,');
      note('so it will not find "night view" for 夜景, or the reverse.');
      note('Set OEA_EMBED_BASE_URL and OEA_EMBED_MODEL for meaning-based search.');
    }
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

  const { unsearchableKinds: unsearchable, visualFallback } = index.lastDiagnostics;
  if (unsearchable.length > 0) {
    note(
      `The ${unsearchable.join(' and ')} aspect${unsearchable.length > 1 ? 's were' : ' was'} matched on text alone:`,
    );
    note('its vectors come from a different model, and comparing across spaces would be noise.');
    // Which two models, by name. Without this the line above is true of a
    // correctly-configured hashing setup and of a project whose index is simply
    // unreachable from here, and they look identical — which is how every
    // search running purely lexically went unnoticed.
    if (indexedWith && queryingWith && indexedWith !== queryingWith) {
      note(`  this index was built with ${indexedWith}; the query used ${queryingWith}.`);
      note('  configure the same model, or re-run "oea analyze" to rebuild the vectors.');
    } else if (indexedWith && !queryingWith) {
      note(`  this index was built with ${indexedWith} and nothing here can encode a query.`);
      note('  set OEA_PERCEPTION=python with OEA_TEXT_MODEL, or OEA_EMBED_BASE_URL.');
    }
    // Which of the three situations it is, because they have different answers
    // and the line above is the same for all of them.
    if (visualFallback === 'no_query_encoder') {
      note('  no vision model here can encode a query — set OEA_VISUAL_MODEL to a CLIP export.');
    } else if (visualFallback === 'query_language') {
      note('  this vision model reads English only. The same question in English reaches it.');
    } else if (visualFallback === 'encoder_failed') {
      note('  the vision model did not answer this time; the words still matched.');
    }
  }
  return 0;
}
