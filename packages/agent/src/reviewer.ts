import {
  compareText,
  formatTimecode,
  operationTimelineDuration,
  operationsInOrder,
  seqId,
  type EditPlan,
  type EditorialIR,
  type PlanRevision,
  type ReviewObservation,
} from '@editorial-ir/contracts';

/**
 * Reading a cut back and saying what is wrong with it.
 *
 * The first plan is a rough cut, not a finished piece, and the failures of an
 * automatic edit are recognisable enough to check for: a jump between two places
 * with nothing in between, a reply to a question the viewer never heard, the
 * same thing twice, a clip too short to register.
 *
 * This works from the plan and the IR rather than from rendered frames. Looking
 * at the output is a later and more expensive step; most of what is wrong with a
 * rough cut is visible in what it selected.
 */
export interface ReviewOptions {
  /** Below this continuity between neighbours, a cut reads as a jump. */
  continuityFloor?: number;
  /** Clips shorter than this rarely register. */
  minReadableMs?: number;
  /** Clips longer than this test the viewer's patience in a short piece. */
  maxComfortableMs?: number;
}

const DEFAULTS: Required<ReviewOptions> = {
  continuityFloor: 0.3,
  minReadableMs: 900,
  maxComfortableMs: 25_000,
};

export function reviewPlan(
  plan: EditPlan,
  ir: EditorialIR,
  options: ReviewOptions = {},
): ReviewObservation[] {
  const settings = { ...DEFAULTS, ...options };
  const observations: ReviewObservation[] = [];
  const operations = operationsInOrder(plan);
  let counter = 0;

  const add = (
    timelineMs: number,
    type: ReviewObservation['observation_type'],
    message: string,
    confidence: number,
    operationId?: string,
  ): void => {
    observations.push({
      id: seqId('rvo', ++counter, 4),
      timeline_ms: timelineMs,
      observation_type: type,
      message,
      ...(operationId ? { operation_id: operationId } : {}),
      confidence,
    });
  };

  const eventOf = (operationId: string): string | undefined =>
    operations.find((o) => o.operation_id === operationId)?.event_id;

  const usedEvents = new Set(operations.map((o) => o.event_id).filter(Boolean) as string[]);

  for (const [index, operation] of operations.entries()) {
    const duration = operationTimelineDuration(operation);

    if (duration < settings.minReadableMs) {
      add(
        operation.timeline_start_ms,
        'too_short',
        `${operation.operation_id} is ${Math.round(duration)}ms, too short to register`,
        0.8,
        operation.operation_id,
      );
    }
    if (duration > settings.maxComfortableMs) {
      add(
        operation.timeline_start_ms,
        'too_long',
        `${operation.operation_id} runs ${formatTimecode(duration, false)}`,
        0.5,
        operation.operation_id,
      );
    }

    const event = ir.events.find((e) => e.id === operation.event_id);
    if (!event) continue;

    // A clip that only makes sense after another clip, where the other clip is
    // not in the cut. This is the most recognisable failure of an automatic edit.
    const assessment = ir.editorial.find((e) => e.event_id === event.id)?.current;
    if ((assessment?.flags.requires_previous_context ?? 0) > 0.6) {
      const ordered = [...ir.events].sort((a, b) => a.start_ms - b.start_ms);
      const position = ordered.findIndex((e) => e.id === event.id);
      const previous = position > 0 ? ordered[position - 1] : undefined;
      if (previous && !usedEvents.has(previous.id)) {
        add(
          operation.timeline_start_ms,
          'missing_context',
          `${operation.operation_id} follows on from ${previous.id}, which is not in the cut`,
          0.7,
          operation.operation_id,
        );
      }
    }

    if (index === 0) continue;
    const previousOperation = operations[index - 1]!;
    const previousEvent = ir.events.find((e) => e.id === previousOperation.event_id);
    if (!previousEvent) continue;

    const continuity = ir.relations.find(
      (r) =>
        r.relation_type === 'continuation' &&
        r.source_event_id === previousEvent.id &&
        r.target_event_id === event.id,
    )?.strength;

    const places = new Set(previousEvent.entities.value.places);
    const changedPlace =
      places.size > 0 &&
      event.entities.value.places.length > 0 &&
      event.entities.value.places.every((p) => !places.has(p));

    // Two events that were never adjacent, in two different places, cut
    // together: that is the jump a viewer notices.
    const wereAdjacent = continuity !== undefined;
    if (changedPlace && !wereAdjacent) {
      add(
        operation.timeline_start_ms,
        'abrupt_location_change',
        `${previousOperation.operation_id} to ${operation.operation_id} jumps from ${[...places].join('/')} to ${event.entities.value.places.join('/')}`,
        0.6,
        operation.operation_id,
      );
    } else if (continuity !== undefined && continuity < settings.continuityFloor) {
      add(
        operation.timeline_start_ms,
        'audio_discontinuity',
        `the cut into ${operation.operation_id} is abrupt`,
        0.4,
        operation.operation_id,
      );
    }

    const duplicate = ir.relations.find(
      (r) =>
        r.relation_type === 'duplicate_of' &&
        ((r.source_event_id === previousEvent.id && r.target_event_id === event.id) ||
          (r.target_event_id === previousEvent.id && r.source_event_id === event.id)),
    );
    if (duplicate) {
      add(
        operation.timeline_start_ms,
        'repetition',
        `${operation.operation_id} covers the same thing as ${previousOperation.operation_id}`,
        duplicate.strength,
        operation.operation_id,
      );
    }
  }

  void eventOf;
  return observations.sort((a, b) => a.timeline_ms - b.timeline_ms || compareText(a.id, b.id));
}

/** Records a round of review against a plan. */
export function recordRevision(
  plan: EditPlan,
  revisionNumber: number,
  observations: readonly ReviewObservation[],
  reason: string,
  now: () => string = () => new Date().toISOString(),
): PlanRevision {
  return {
    id: seqId('rev', revisionNumber, 3),
    plan_id: plan.id,
    revision_number: revisionNumber,
    reason,
    observations: [...observations],
    created_at: now(),
  };
}

/**
 * What to change, given what review found.
 *
 * Returned as suggestions rather than applied, because the fix for "this jumps"
 * is usually to add a shot the planner already rejected, and that is a decision
 * with a cost — the piece gets longer — that belongs to whoever is running it.
 */
export interface RevisionSuggestion {
  observation_id: string;
  action: 'drop_operation' | 'extend_operation' | 'insert_bridge' | 'reorder';
  operation_id?: string;
  /** An event that would fix it, where one exists. */
  candidate_event_id?: string;
  reason: string;
}

export function suggestRevisions(
  observations: readonly ReviewObservation[],
  plan: EditPlan,
  ir: EditorialIR,
): RevisionSuggestion[] {
  const used = new Set(plan.tracks.video.map((o) => o.event_id).filter(Boolean) as string[]);
  const suggestions: RevisionSuggestion[] = [];

  for (const observation of observations) {
    switch (observation.observation_type) {
      case 'too_short':
        suggestions.push({
          observation_id: observation.id,
          action: 'extend_operation',
          ...(observation.operation_id ? { operation_id: observation.operation_id } : {}),
          reason: 'too short to register; give it at least a second',
        });
        break;

      case 'repetition':
        suggestions.push({
          observation_id: observation.id,
          action: 'drop_operation',
          ...(observation.operation_id ? { operation_id: observation.operation_id } : {}),
          reason: 'the cut already showed this',
        });
        break;

      case 'missing_context':
      case 'abrupt_location_change': {
        // Look for something that was between the two, and was left out: a shot
        // of the train is exactly what a jump from the hotel to the park wants.
        const operation = plan.tracks.video.find(
          (o) => o.operation_id === observation.operation_id,
        );
        const bridge = operation?.event_id ? findBridge(ir, operation.event_id, used) : undefined;
        suggestions.push({
          observation_id: observation.id,
          action: 'insert_bridge',
          ...(observation.operation_id ? { operation_id: observation.operation_id } : {}),
          ...(bridge ? { candidate_event_id: bridge } : {}),
          reason: bridge
            ? 'there is material between these two that would carry the viewer across'
            : 'nothing in the material bridges this; it may need a title or a dissolve',
        });
        break;
      }

      default:
        break;
    }
  }

  return suggestions;
}

/** An unused event immediately before this one, ideally a transition. */
function findBridge(
  ir: EditorialIR,
  eventId: string,
  used: ReadonlySet<string>,
): string | undefined {
  const ordered = [...ir.events].sort((a, b) => a.start_ms - b.start_ms);
  const position = ordered.findIndex((e) => e.id === eventId);
  if (position <= 0) return undefined;

  for (let i = position - 1; i >= Math.max(0, position - 4); i--) {
    const candidate = ordered[i];
    if (!candidate || used.has(candidate.id)) continue;
    const role = ir.editorial.find((e) => e.event_id === candidate.id)?.current.narrative_role
      .selected;
    if (role === 'transition' || role === 'context' || role === 'setup') return candidate.id;
  }
  return undefined;
}
