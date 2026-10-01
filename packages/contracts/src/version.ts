/**
 * Version constants for every contract this package owns.
 *
 * These are **not** package versions. They are the versions written into
 * serialized documents, and consumers are expected to branch on them.
 *
 * - `IR_VERSION` changes when the shape or meaning of {@link EditorialIR} changes.
 * - `EDIT_PLAN_VERSION` changes when the shape or meaning of an EditPlan changes.
 * - `PIPELINE_VERSION` changes when perception/segmentation semantics change in a
 *   way that invalidates cached observations even though no schema changed.
 *   It participates in every cache key (see `@editorial-ir/core`).
 */
export const IR_VERSION = '0.2.0';
export const EDIT_PLAN_VERSION = '0.1.0';
// 0.1.1: audio is extracted on the file's own clock (gaps filled, a late start
// padded). Transcripts and silences cached from the old extraction were wrong on
// any file with timestamp gaps, and nothing in their keys would have changed.
// 0.1.2: the proxy is made at the file's nominal rate, constant-frame-rate, and
// named for how it was made; with several audio streams the one with the speech
// is analysed. Shots and motion cached from the old implicitly-CFR proxy of a
// variable-rate file would otherwise be served again, because paths are not part
// of a cache key.
export const PIPELINE_VERSION = '0.1.2';
export const SKILL_MANIFEST_VERSION = '0.1.0';
export const PERCEPTION_PROTOCOL_VERSION = '0.1.0';

/** Semver-major compatibility check used when loading a persisted document. */
export function isCompatibleVersion(documentVersion: string, runtimeVersion: string): boolean {
  const docMajor = documentVersion.split('.')[0];
  const runMajor = runtimeVersion.split('.')[0];
  if (docMajor !== runMajor) return false;
  if (docMajor === '0') {
    // While < 1.0.0 the minor is treated as the breaking segment.
    return documentVersion.split('.')[1] === runtimeVersion.split('.')[1];
  }
  return true;
}
