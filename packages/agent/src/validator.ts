import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  EditPlan as EditPlanSchema,
  operationTimelineDuration,
  operationTimelineEnd,
  operationsInOrder,
  planDurationMs,
  reportOk,
  type AdapterCapabilities,
  type EditPlan,
  type EditorialIR,
  type ValidationIssue,
  type ValidationReport,
} from '@editorial-ir/contracts';

/**
 * Everything that must be true before a plan reaches an editing application.
 *
 * This is the last deterministic gate in the system, and it exists because the
 * thing upstream of it is allowed to be clever. A planner — rule-based or
 * model-driven — can produce a plan that is subtly impossible: an out point past
 * the end of a file, two clips on the same frame of the same track, a user's
 * must-keep moment quietly missing. None of that should reach an NLE, and none
 * of it should be caught by another model.
 */
export interface ValidateOptions {
  /** Checked against the plan's recorded fingerprint. */
  ir?: EditorialIR;
  /** What the target editing application can actually do. */
  capabilities?: AdapterCapabilities;
  /** Resolve and check that media files exist. */
  projectRoot?: string;
  checkMediaExists?: boolean;
  now?: () => string;
}

export function validatePlan(plan: unknown, options: ValidateOptions = {}): ValidationReport {
  const now = options.now ?? (() => new Date().toISOString());
  const issues: ValidationIssue[] = [];

  const parsed = EditPlanSchema.safeParse(plan);
  if (!parsed.success) {
    // A plan that does not parse cannot be reasoned about further; report the
    // schema failure and stop rather than producing a page of consequences.
    return {
      ok: false,
      checked_at: now(),
      issues: parsed.error.issues.slice(0, 20).map((issue) => ({
        code: 'plan_schema_invalid' as const,
        severity: 'error' as const,
        message: issue.message,
        path: issue.path.join('.'),
      })),
    };
  }

  const editPlan = parsed.data;
  const { ir } = options;

  if (editPlan.tracks.video.length === 0) {
    issues.push({ code: 'empty_plan', severity: 'error', message: 'the plan has no clips in it' });
  }

  // ---- identifiers ---------------------------------------------------------
  const seen = new Set<string>();
  for (const operation of editPlan.tracks.video) {
    if (seen.has(operation.operation_id)) {
      issues.push({
        code: 'duplicate_operation_id',
        severity: 'error',
        message: `two clips share the id ${operation.operation_id}`,
        operation_id: operation.operation_id,
      });
    }
    seen.add(operation.operation_id);
  }

  // ---- ranges --------------------------------------------------------------
  for (const operation of editPlan.tracks.video) {
    if (operation.source_out_ms <= operation.source_in_ms) {
      issues.push({
        code: 'invalid_range',
        severity: 'error',
        message: `${operation.operation_id} ends at or before it starts`,
        operation_id: operation.operation_id,
      });
    }
    if (operation.timeline_start_ms < 0) {
      issues.push({
        code: 'negative_timeline_position',
        severity: 'error',
        message: `${operation.operation_id} starts before the beginning of the sequence`,
        operation_id: operation.operation_id,
      });
    }

    const asset = ir?.assets.find((a) => a.id === operation.source_asset_id);
    if (ir && !asset) {
      issues.push({
        code: 'unknown_asset',
        severity: 'error',
        message: `${operation.operation_id} uses ${operation.source_asset_id}, which is not in this project`,
        operation_id: operation.operation_id,
        asset_id: operation.source_asset_id,
      });
    } else if (asset && asset.duration_ms > 0 && operation.source_out_ms > asset.duration_ms) {
      issues.push({
        code: 'range_out_of_bounds',
        severity: 'error',
        message: `${operation.operation_id} reads past the end of ${asset.file_name}`,
        operation_id: operation.operation_id,
        asset_id: asset.id,
        details: { source_out_ms: operation.source_out_ms, duration_ms: asset.duration_ms },
      });
    }

    if (ir && operation.event_id && !ir.events.some((e) => e.id === operation.event_id)) {
      issues.push({
        code: 'unknown_event',
        severity: 'error',
        message: `${operation.operation_id} refers to ${operation.event_id}, which is not in the IR`,
        operation_id: operation.operation_id,
        event_id: operation.event_id,
      });
    }
  }

  // ---- media ---------------------------------------------------------------
  if (options.checkMediaExists && ir && options.projectRoot) {
    const used = new Set(editPlan.tracks.video.map((o) => o.source_asset_id));
    for (const assetId of used) {
      const asset = ir.assets.find((a) => a.id === assetId);
      if (!asset) continue;
      const path = isAbsolute(asset.path) ? asset.path : resolve(options.projectRoot, asset.path);
      if (!existsSync(path)) {
        issues.push({
          code: 'missing_media',
          severity: 'error',
          message: `${asset.file_name} is not where the project says it is`,
          asset_id: assetId,
          details: { path },
        });
      }
    }
  }

  // ---- timeline ------------------------------------------------------------
  const byTrack = new Map<number, typeof editPlan.tracks.video>();
  for (const operation of operationsInOrder(editPlan)) {
    const list = byTrack.get(operation.track) ?? [];
    list.push(operation);
    byTrack.set(operation.track, list);
  }

  for (const [track, operations] of byTrack) {
    for (let i = 1; i < operations.length; i++) {
      const previous = operations[i - 1]!;
      const current = operations[i]!;
      const previousEnd = operationTimelineEnd(previous);

      if (current.timeline_start_ms < previousEnd) {
        issues.push({
          code: 'track_collision',
          severity: 'error',
          message: `${current.operation_id} starts before ${previous.operation_id} finishes on track ${track}`,
          operation_id: current.operation_id,
          details: { previous_end_ms: previousEnd, starts_at_ms: current.timeline_start_ms },
        });
      } else if (current.timeline_start_ms > previousEnd) {
        // A gap on the main track is usually a planner bug rather than an
        // intention, but it is playable, so it is a warning.
        issues.push({
          code: 'timeline_gap',
          severity: track === 0 ? 'warning' : 'info',
          message: `${previous.operation_id} to ${current.operation_id} on track ${track} at ${previousEnd}ms`,
          operation_id: current.operation_id,
          details: { gap_ms: current.timeline_start_ms - previousEnd },
        });
      }
    }
  }

  // ---- the user's instructions ---------------------------------------------
  if (ir) {
    const usedEvents = new Set(editPlan.tracks.video.map((o) => o.event_id).filter(Boolean));

    for (const event of ir.events) {
      if (event.knowledge.essential && !usedEvents.has(event.id)) {
        issues.push({
          code: 'essential_event_missing',
          severity: 'error',
          message: `the user marked ${event.id} essential and it is not in the cut`,
          event_id: event.id,
        });
      }
      if (event.knowledge.excluded && usedEvents.has(event.id)) {
        issues.push({
          code: 'excluded_event_present',
          severity: 'error',
          message: `the user excluded ${event.id} and it is in the cut`,
          event_id: event.id,
        });
      }
    }

    for (const assetId of ir.context.constraints.excluded_assets) {
      if (editPlan.tracks.video.some((o) => o.source_asset_id === assetId)) {
        issues.push({
          code: 'excluded_asset_present',
          severity: 'error',
          message: `${assetId} is excluded by the project constraints and is in the cut`,
          asset_id: assetId,
        });
      }
    }

    if (editPlan.ir_fingerprint && ir.fingerprint && editPlan.ir_fingerprint !== ir.fingerprint) {
      issues.push({
        code: 'stale_ir_fingerprint',
        severity: 'warning',
        message: 'this plan was made from an older analysis; re-plan to use the current one',
        details: { plan: editPlan.ir_fingerprint, ir: ir.fingerprint },
      });
    }
  }

  // ---- duration ------------------------------------------------------------
  const duration = planDurationMs(editPlan);
  const target = editPlan.sequence.target_duration_ms;
  const tolerance = editPlan.sequence.tolerance_ms;
  if (target > 0 && Math.abs(duration - target) > tolerance) {
    issues.push({
      code: 'duration_out_of_tolerance',
      severity: 'warning',
      message: `the cut is ${formatSeconds(duration)} against a target of ${formatSeconds(target)}`,
      details: { duration_ms: duration, target_ms: target, tolerance_ms: tolerance },
    });
  }

  for (const operation of editPlan.tracks.video) {
    const length = operationTimelineDuration(operation);
    const minimum = operation.constraints?.minimum_duration_ms;
    const maximum = operation.constraints?.maximum_duration_ms;
    if (minimum !== undefined && length < minimum) {
      issues.push({
        code: 'clip_too_short',
        severity: 'warning',
        message: `${operation.operation_id} is shorter than its own minimum`,
        operation_id: operation.operation_id,
      });
    }
    if (maximum !== undefined && length > maximum) {
      issues.push({
        code: 'clip_too_long',
        severity: 'warning',
        message: `${operation.operation_id} is longer than its own maximum`,
        operation_id: operation.operation_id,
      });
    }
  }

  // ---- what the target can do ----------------------------------------------
  if (options.capabilities) {
    issues.push(...capabilityIssues(editPlan, options.capabilities));
  }

  return { ok: reportOk(issues), plan_id: editPlan.id, issues, checked_at: now() };
}

/**
 * Checks a plan against one editing application's declared abilities.
 *
 * Reported as warnings rather than errors: an adapter is expected to downgrade
 * gracefully — a dissolve becomes a cut — and refusing to export at all because
 * one transition is unsupported would be worse than the downgrade.
 */
export function capabilityIssues(
  plan: EditPlan,
  capabilities: AdapterCapabilities,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const tracks = new Set(plan.tracks.video.map((o) => o.track));
  if (tracks.size > capabilities.max_video_tracks) {
    issues.push({
      code: 'unsupported_capability',
      severity: 'warning',
      message: `${capabilities.name} supports ${capabilities.max_video_tracks} video track(s); the plan uses ${tracks.size}`,
    });
  }

  for (const operation of plan.tracks.video) {
    if (operation.speed !== 1 && !capabilities.speed_change) {
      issues.push({
        code: 'speed_not_supported',
        severity: 'warning',
        message: `${capabilities.name} cannot change clip speed; ${operation.operation_id} will play at normal speed`,
        operation_id: operation.operation_id,
      });
    }

    for (const transition of [operation.transition_in, operation.transition_out]) {
      if (!transition || transition.type === 'hard_cut') continue;
      if (
        !capabilities.basic_transition ||
        !capabilities.transition_types.includes(transition.type)
      ) {
        issues.push({
          code: 'unsupported_transition',
          severity: 'warning',
          message: `${capabilities.name} cannot do a ${transition.type}; it will become a cut`,
          operation_id: operation.operation_id,
        });
      }
      const clip = operationTimelineDuration(operation);
      if (transition.duration_ms * 2 > clip) {
        issues.push({
          code: 'transition_too_long',
          severity: 'warning',
          message: `the transition on ${operation.operation_id} is long relative to the clip`,
          operation_id: operation.operation_id,
        });
      }
    }
  }

  if (plan.tracks.text.length > 0 && !capabilities.text) {
    issues.push({
      code: 'unsupported_capability',
      severity: 'warning',
      message: `${capabilities.name} cannot add text; ${plan.tracks.text.length} text item(s) will be dropped`,
    });
  }

  const audioTracks = new Set(plan.tracks.audio.map((a) => a.track));
  if (audioTracks.size > capabilities.audio_tracks) {
    issues.push({
      code: 'unsupported_capability',
      severity: 'warning',
      message: `${capabilities.name} supports ${capabilities.audio_tracks} audio track(s); the plan uses ${audioTracks.size}`,
    });
  }

  return issues;
}

function formatSeconds(ms: number): string {
  return `${Math.round(ms / 100) / 10}s`;
}
