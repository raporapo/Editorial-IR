import { z } from 'zod';
import { obj } from './primitives.js';

/**
 * Deterministic validation between the agent and any editing application.
 *
 * A planner — rule-based or model-driven — can produce a plan that is subtly
 * impossible: an out point past the end of a file, two clips on the same frame
 * of the same track, a user's must-keep moment quietly missing. None of that
 * should ever reach an NLE, and none of it should be caught by a model.
 */
export const ValidationSeverity = z.enum(['error', 'warning', 'info']).meta({
  id: 'ValidationSeverity',
});
export type ValidationSeverity = z.infer<typeof ValidationSeverity>;

/** Stable machine-readable codes. Tests and adapters match on these, not on messages. */
export const VALIDATION_CODES = [
  'missing_media',
  'invalid_range',
  'range_out_of_bounds',
  'negative_timeline_position',
  'track_collision',
  'timeline_gap',
  'unknown_asset',
  'unknown_event',
  'essential_event_missing',
  'excluded_event_present',
  'excluded_asset_present',
  'duration_out_of_tolerance',
  'below_minimum_speech_share',
  'clip_too_short',
  'clip_too_long',
  'unsupported_capability',
  'unsupported_transition',
  'transition_too_long',
  'duplicate_operation_id',
  'stale_ir_fingerprint',
  'empty_plan',
  'speed_not_supported',
  'plan_schema_invalid',
  'sequence_mismatch',
] as const;

export const ValidationCode = z.enum(VALIDATION_CODES).meta({ id: 'ValidationCode' });
export type ValidationCode = z.infer<typeof ValidationCode>;

export const ValidationIssue = obj({
  code: ValidationCode,
  severity: ValidationSeverity,
  message: z.string(),
  operation_id: z.string().optional(),
  event_id: z.string().optional(),
  asset_id: z.string().optional(),
  /** Dotted path into the plan, when the issue is structural. */
  path: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
}).meta({ id: 'ValidationIssue' });
export type ValidationIssue = z.infer<typeof ValidationIssue>;

export const ValidationReport = obj({
  /** False when any issue has severity `error`. */
  ok: z.boolean(),
  plan_id: z.string().optional(),
  issues: z.array(ValidationIssue).default([]),
  checked_at: z.string(),
}).meta({ id: 'ValidationReport', title: 'ValidationReport' });
export type ValidationReport = z.infer<typeof ValidationReport>;

export function reportOk(issues: ValidationIssue[]): boolean {
  return !issues.some((i) => i.severity === 'error');
}

export function summariseReport(report: ValidationReport): string {
  const errors = report.issues.filter((i) => i.severity === 'error').length;
  const warnings = report.issues.filter((i) => i.severity === 'warning').length;
  if (report.ok && warnings === 0) return 'valid';
  return `${errors} error(s), ${warnings} warning(s)`;
}
