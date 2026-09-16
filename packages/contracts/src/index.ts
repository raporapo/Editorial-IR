/**
 * @editorial-ir/contracts
 *
 * The canonical definition of everything that crosses a boundary in this
 * project: the Editorial IR document, the EditPlan, the Skill manifest, the
 * decision-layer primitives, the adapter contract and the perception protocol.
 *
 * Nothing in here imports anything but `zod`. It is the one package every other
 * package depends on, and it must stay cheap enough to depend on.
 */
export * from './version.js';
export * from './primitives.js';
export * from './ids.js';
export * from './text.js';
export * from './provenance.js';
export * from './model-run.js';
export * from './media.js';
export * from './project.js';
export * from './observation.js';
export * from './event.js';
export * from './editorial.js';
export * from './relation.js';
export * from './embedding.js';
export * from './ir.js';
export * from './plan.js';
export * from './skill.js';
export * from './decision.js';
export * from './adapter.js';
export * from './validation.js';
export * from './perception.js';
export * from './errors.js';
export * from './json-schema.js';
