import { z } from 'zod';
import * as media from './media.js';
import * as project from './project.js';
import * as observation from './observation.js';
import * as event from './event.js';
import * as editorial from './editorial.js';
import * as relation from './relation.js';
import * as embedding from './embedding.js';
import * as ir from './ir.js';
import * as plan from './plan.js';
import * as skill from './skill.js';
import * as decision from './decision.js';
import * as adapter from './adapter.js';
import * as validation from './validation.js';
import * as perception from './perception.js';
import * as provenance from './provenance.js';
import * as modelRun from './model-run.js';
import { IR_VERSION, EDIT_PLAN_VERSION, PERCEPTION_PROTOCOL_VERSION, SKILL_MANIFEST_VERSION } from './version.js';

/**
 * JSON Schema is the canonical cross-language contract.
 *
 * TypeScript owns the definitions, the Python perception runtime validates
 * against the exported schemas, and the files in `schemas/` are committed so a
 * schema change shows up as a reviewable diff rather than as a surprise at
 * runtime in another language.
 */
export const SCHEMA_REGISTRY = {
  // documents
  EditorialIR: ir.EditorialIR,
  EditPlan: plan.EditPlan,
  ObservationTimeline: observation.ObservationTimeline,
  SkillManifest: skill.SkillManifest,
  ProjectContext: project.ProjectContext,
  ValidationReport: validation.ValidationReport,
  EmbeddingSet: embedding.EmbeddingSet,
  AdapterCapabilities: adapter.AdapterCapabilities,
  ApplyResult: adapter.ApplyResult,
  PlanRevision: plan.PlanRevision,

  // protocol
  PerceptionRequest: perception.PerceptionRequest,
  PerceptionResponse: perception.PerceptionResponse,
  PerceptionEvent: perception.PerceptionEvent,
  HealthResult: perception.HealthResult,
  ProbeResult: perception.ProbeResult,
  PrepareResult: perception.PrepareResult,
  TranscribeResult: perception.TranscribeResult,
  DetectShotsResult: perception.DetectShotsResult,
  EmbedFramesResult: perception.EmbedFramesResult,
  AnalyzeAudioResult: perception.AnalyzeAudioResult,
  OcrResult: perception.OcrResult,
  DescribeResult: perception.DescribeResult,
  EmbedTextResult: perception.EmbedTextResult,

  // decision layer
  EventState: decision.EventState,
  ChoiceRequest: decision.ChoiceRequest,
  ChoiceResult: decision.ChoiceResult,
  ScoreRequest: decision.ScoreRequest,
  ScoreResult: decision.ScoreResult,
  BooleanRequest: decision.BooleanRequest,
  BooleanResult: decision.BooleanResult,
  EditorialAssessment: editorial.EditorialAssessment,

  // building blocks
  MediaAsset: media.MediaAsset,
  AssetPlacement: media.AssetPlacement,
  UserAnnotation: project.UserAnnotation,
  SemanticEvent: event.SemanticEvent,
  Chapter: event.Chapter,
  EventRelation: relation.EventRelation,
  ModelRun: modelRun.ModelRun,
  Conflict: provenance.Conflict,
  SkillDirective: skill.SkillDirective,
} as const satisfies Record<string, z.ZodType>;

export type SchemaName = keyof typeof SCHEMA_REGISTRY;

export const SCHEMA_NAMES = Object.keys(SCHEMA_REGISTRY) as SchemaName[];

const SCHEMA_BASE_URI = 'https://editorial-ir.dev/schemas';

/** Versions written into the exported schema bundle so a consumer can pin. */
export const CONTRACT_VERSIONS = {
  ir: IR_VERSION,
  edit_plan: EDIT_PLAN_VERSION,
  skill_manifest: SKILL_MANIFEST_VERSION,
  perception_protocol: PERCEPTION_PROTOCOL_VERSION,
} as const;

export function toJsonSchema(name: SchemaName): Record<string, unknown> {
  const schema = SCHEMA_REGISTRY[name] as z.ZodType;
  const json = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'output',
    unrepresentable: 'any',
    reused: 'ref',
  }) as Record<string, unknown>;
  return { $id: `${SCHEMA_BASE_URI}/${name}.schema.json`, ...hoistRootRef(json) };
}

/**
 * Zod lifts a named root schema into `$defs` and leaves a `$ref` behind. That is
 * valid, but a file whose entire body is one `$ref` is unpleasant to read and
 * trips simpler validators, so the root definition is inlined again.
 */
function hoistRootRef(json: Record<string, unknown>): Record<string, unknown> {
  const ref = json.$ref;
  const defs = json.$defs as Record<string, Record<string, unknown>> | undefined;
  if (typeof ref !== 'string' || !defs) return json;
  const match = /^#\/\$defs\/(.+)$/.exec(ref);
  const key = match?.[1];
  if (!key || !defs[key]) return json;
  const { [key]: root, ...rest } = defs;
  const out: Record<string, unknown> = { $schema: json.$schema, ...root };
  if (Object.keys(rest).length > 0) out.$defs = rest;
  return out;
}

/** Every schema in one document, for tooling that prefers a single file. */
export function toJsonSchemaBundle(): Record<string, unknown> {
  const definitions: Record<string, unknown> = {};
  for (const name of SCHEMA_NAMES) definitions[name] = toJsonSchema(name);
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${SCHEMA_BASE_URI}/editorial-ir.bundle.schema.json`,
    title: 'Editorial IR contracts',
    description:
      'Canonical contracts for Editorial IR. Generated from the TypeScript definitions in @editorial-ir/contracts; do not edit by hand.',
    'x-contract-versions': CONTRACT_VERSIONS,
    $defs: definitions,
  };
}
