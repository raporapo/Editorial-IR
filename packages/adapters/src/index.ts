/**
 * @editorial-ir/adapters
 *
 * The boundary between this project and any editing application.
 *
 * An adapter translates an EditPlan and nothing else. It never plans and never
 * judges, which is what makes a second editor an adapter rather than a rewrite —
 * and why the agent is never allowed to speak to an NLE directly.
 */
export * from './types.js';
export * from './xml.js';
export * from './timeline.js';
export * from './otio.js';
export * from './premiere.js';
export * from './aviutl2.js';
export * from './edl.js';
export * from './fcpxml.js';
export * from './subtitles.js';
export * from './chapters.js';
export * from './registry.js';
