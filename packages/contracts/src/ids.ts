import { idSchema } from './primitives.js';

/**
 * Identifier schemas are defined exactly once.
 *
 * Each carries a JSON Schema `$id`, so building two schemas for the same prefix
 * would produce a duplicate definition the moment the whole contract is exported
 * as one document.
 */
export const ProjectId = idSchema('prj', 'A project.');
export const AssetId = idSchema('asset', 'A registered source file.');
export const ShotId = idSchema('shot', 'A camera shot within one asset.');
export const UtteranceId = idSchema('utt', 'One transcribed utterance.');
export const AudioEventId = idSchema('aev', 'One detected audio event.');
export const OcrId = idSchema('ocr', 'One on-screen text observation.');
export const VideoEventId = idSchema(
  'vev',
  'One span of the picture doing something measurable: holding still, going black.',
);
export const FrameId = idSchema('frm', 'One sampled frame.');
export const ChapterId = idSchema('chp', 'A group of consecutive events.');
export const EventId = idSchema('evt', 'A semantic event: one thing that happened.');
export const RelationId = idSchema('rel', 'An edge in the event graph.');
export const EmbeddingId = idSchema('emb', 'A stored vector.');
export const AssessmentId = idSchema('asm', "One decision backend's verdict on one event.");
export const AnnotationId = idSchema('ann', 'A user override.');
export const PlanId = idSchema('plan', 'An EditPlan.');
export const OperationId = idSchema('op', 'One operation within an EditPlan.');
export const RevisionId = idSchema('rev', 'A revision of an EditPlan.');
export const ModelRunId = idSchema('run', 'One execution of a model or rule-based stage.');
export const SkillId = idSchema('skl', 'A loaded skill.');
export const ConflictId = idSchema('cfl', 'A recorded disagreement between sources.');
export const ReviewId = idSchema('rvo', 'An observation made while reviewing a preview.');
