/**
 * @editorial-ir/skills
 *
 * A Skill says what counts as a good edit. It never looks at video.
 *
 * The decision layer says "this moment scores 0.91 on emotional intensity"; a
 * Skill says "when it scores that high, do not cut it shorter than three
 * seconds". Change the model and the style survives; change the style and the
 * expensive analysis survives.
 */
export * from './condition.js';
export * from './facts.js';
export * from './runtime.js';
export * from './loader.js';
