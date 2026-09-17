import { join } from 'node:path';
import { EditorialError, type EditPlan, type EditorialIR } from '@editorial-ir/contracts';
import { FlatVectorIndex, SemanticIndex } from '@editorial-ir/index';
import { HashingTextEmbedding } from '@editorial-ir/perception';
import { contactSheet, framesIn, shotsIn, type FileProjectStore } from '@editorial-ir/core';
import type { InspectionSource } from '@editorial-ir/agent';

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
): SemanticIndex {
  const vectors = new FlatVectorIndex();
  const stored = store.readEmbeddings();
  if (stored) vectors.add(stored.records);
  return new SemanticIndex(ir, vectors, encoder ?? new HashingTextEmbedding());
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
