/**
 * @editorial-ir/agent
 *
 * Deciding what goes in the cut, and proving the result is possible.
 *
 * The planner is a deterministic optimiser rather than a language model, because
 * "three minutes" and "the user marked this essential" are hard constraints and
 * a planner that satisfies them by construction beats one that usually does. A
 * model-driven agent sits above it through the same toolkit, and whatever it
 * produces goes through the same validator.
 */
export * from './trim.js';
export * from './planner.js';
export * from './validator.js';
export * from './toolkit.js';
export * from './reviewer.js';
