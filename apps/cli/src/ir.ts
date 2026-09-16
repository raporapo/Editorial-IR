import { EditorialError, type EditorialIR } from '@editorial-ir/contracts';
import { FlatVectorIndex, SemanticIndex } from '@editorial-ir/index';
import { HashingTextEmbedding } from '@editorial-ir/perception';
import type { FileProjectStore } from '@editorial-ir/core';

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
