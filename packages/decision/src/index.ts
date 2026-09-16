/**
 * @editorial-ir/decision
 *
 * "What is this moment worth to an edit?" — asked as three primitives with
 * defined semantics, answered by whichever backend is configured.
 *
 * The rule this package exists to enforce: no backend is required, and every
 * backend answers the same questions, so the Editorial IR is the same shape
 * whoever produced it.
 */
export * from './types.js';
export * from './distribution.js';
export * from './questions.js';
export * from './assess.js';
export {
  HeuristicDecisionBackend,
  estimateMetric,
  estimateFlag,
  narrativeRoleWeights,
} from './backends/heuristic.js';
export {
  LocalSystemOneBackend,
  buildBatchPrompt,
  batchSchema,
} from './backends/local-system-one.js';
export { JevBackend, type JevBackendOptions } from './backends/jev.js';
export { FallbackDecisionBackend, type FallbackOptions } from './backends/fallback.js';
export { assessViaPrimitives } from './backends/primitive-batch.js';
