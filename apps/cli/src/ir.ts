import { join } from 'node:path';
import { EditorialError, type EditPlan, type EditorialIR } from '@editorial-ir/contracts';
import { FlatVectorIndex, SemanticIndex } from '@editorial-ir/index';
import { HashingTextEmbedding } from '@editorial-ir/perception';
import { contactSheet, framesIn, shotsIn, type FileProjectStore } from '@editorial-ir/core';
import type { InspectionSource } from '@editorial-ir/agent';
import { resolveBackends } from './backends.js';

/** Loads the analysis, with a message that says what to do when there is none. */
export function requireIr(store: FileProjectStore): EditorialIR {
  const ir = store.readIr();
  if (!ir) {
    throw new EditorialError(
      'not_found',
      'this project has not been analysed yet. Run "oea analyze".',
    );
  }
  return ir;
}

/**
 * Loads a plan, naming the ones there are when the id names none.
 *
 * `--plan plan_nope` reported "there is no plan yet. Run 'oea plan' first." at
 * a project full of plans, and running `oea plan` again did not help — it made
 * another one, after which the same id failed identically. Nothing printed the
 * real ids, so the message pointed away from the answer.
 */
export function requirePlan(store: FileProjectStore, planId?: string): EditPlan {
  const plan = planId ? store.readPlan(planId) : store.latestPlan();
  if (plan) return plan;

  const known = store.listPlans();
  if (planId) {
    throw new EditorialError('not_found', `there is no plan called "${planId}"`, {
      ...(known.length > 0
        ? { available: known.join(', ') }
        : { hint: 'this project has no plans yet — run "oea plan"' }),
    });
  }
  throw new EditorialError('not_found', 'there is no plan yet. Run "oea plan" first.');
}

/**
 * Rebuilds the search index from the stored vectors.
 *
 * The vectors live in a sidecar file rather than in the IR, so this is the step
 * that puts them back together. The hashing encoder is used for the query unless
 * one is configured, which is why a query and its index have to come from the
 * same place.
 */
export function openIndex(
  store: FileProjectStore,
  ir: EditorialIR,
  encoder?: { embed(texts: string[], role?: 'query' | 'passage'): Promise<number[][]> },
  /**
   * The vision model's text tower. Without it the `visual` aspect is matched on
   * its labels as words: the frame vectors are in the index and no query can
   * reach them.
   */
  visualEncoder?: { embedQuery(texts: string[]): Promise<number[][]>; queryLanguage?: string },
): SemanticIndex {
  const vectors = new FlatVectorIndex();
  const stored = store.readEmbeddings();
  if (stored) vectors.add(stored.records);
  return new SemanticIndex(ir, vectors, encoder ?? new HashingTextEmbedding(), visualEncoder);
}

/** The model whose vectors are in the index, according to the analysis itself. */
export function indexedWith(ir: EditorialIR): string | undefined {
  const run = ir.model_runs.find((entry) => entry.stage === 'embedding');
  return run?.model ?? run?.backend;
}

/**
 * The index, together with the models that can actually query it.
 *
 * This exists because `openIndex(store, ir)` — which is how both `oea search`
 * and the editing agent opened it — passes no encoder, so the query was hashed
 * while the stored vectors came from whatever model analysed the project. The
 * index refuses to compare vectors of different widths, correctly, so **every
 * aspect fell back to literal word overlap on every search this project has ever
 * run.** Reproduced on a real 62-minute analysis embedded with
 * multilingual-e5-large: searching "night view" reported all six aspects matched
 * on text alone and returned one hit, which was the string "NIGHT" read off a
 * sign by OCR.
 *
 * What made it survive is that it was never silent — it printed "its vectors
 * come from a different model, and comparing across spaces would be noise",
 * which reads like a design note about the hashing stand-in rather than a report
 * that the semantic index just built is unreachable.
 *
 * Resolving backends costs a Python worker start when one is configured. That is
 * the price of the query coming from the same model as the index, and there is
 * no cheaper way to get it: the vectors are numbers, and only the model that
 * made them can turn a sentence into a comparable one.
 */
export async function openSearchableIndex(
  store: FileProjectStore,
  ir: EditorialIR,
  options: { onLog?: (message: string) => void } = {},
): Promise<{
  index: SemanticIndex;
  /** The model the stored vectors came from, and the one answering queries now. */
  indexedWith?: string;
  queryingWith?: string;
  /**
   * True when the query encoder matches words rather than meaning.
   *
   * Distinct from "there is no encoder": the hashing stand-in is always present
   * and always has a name, so a check on the name reported a configured
   * semantic setup and an unconfigured lexical one identically.
   */
  lexical: boolean;
  close(): Promise<void>;
}> {
  // `offline-minimal` because searching an analysis that already exists must not
  // require the models that would have been needed to make it. Whatever is here
  // is used; nothing is refused.
  const backends = await resolveBackends({
    mode: 'offline-minimal',
    ...(options.onLog ? { onLog: options.onLog } : {}),
  });
  const visual = backends.suite.visual;
  const visualEncoder =
    visual?.embedQuery !== undefined
      ? {
          embedQuery: (texts: string[]): Promise<number[][]> => visual.embedQuery!(texts),
          ...(visual.queryLanguage ? { queryLanguage: visual.queryLanguage } : {}),
        }
      : undefined;

  return {
    index: openIndex(store, ir, backends.suite.text, visualEncoder),
    ...(indexedWith(ir) ? { indexedWith: indexedWith(ir) } : {}),
    ...(backends.suite.text.identity.model
      ? { queryingWith: backends.suite.text.identity.model }
      : {}),
    lexical: backends.suite.text.lexical === true,
    close: () => backends.close(),
  };
}

/**
 * The two layers below the event, read from the project on disk.
 *
 * Kept here rather than inside the toolkit so that `packages/agent` stays a pure
 * function of a document: an agent can be tested without a project directory,
 * and a hosted deployment can supply these from object storage instead.
 */
export function openInspection(
  store: FileProjectStore,
  ir: EditorialIR,
): InspectionSource | undefined {
  const observations = store.readObservations();
  if (!observations) return undefined;

  return {
    shots: (event) => shotsIn(observations, event),
    frames: (event, options = {}) =>
      framesIn(ir, store.paths.root, event, { ...options, observations }),
    contactSheet: async (event, options = {}) => {
      const frames = framesIn(ir, store.paths.root, event, { ...options, observations });
      const path = join(store.paths.workDir, 'sheets', `${event.id}.jpg`);
      return contactSheet(frames, path, { columns: frames.length > 4 ? 3 : 2 });
    },
  };
}
