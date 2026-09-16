import {
  newId,
  overlapMs,
  rangesOverlap,
  type Conflict,
  type EventKnowledge,
  type SemanticEvent,
  type UserAnnotation,
} from '@editorial-ir/contracts';

/**
 * Applying what the user said.
 *
 * Overrides are applied beside model output, never over it. Turning an override
 * off restores the model's opinion instead of losing it, and a disagreement
 * between the two is recorded rather than resolved away — a system that quietly
 * overwrote an observation with a user's belief would be unable to tell anyone
 * afterwards that the two ever differed.
 */

/** Which annotations apply to an event, by id or by overlapping time. */
export function annotationsFor(
  event: SemanticEvent,
  annotations: readonly UserAnnotation[],
  captureOffsetMs = 0,
): UserAnnotation[] {
  return annotations
    .filter((annotation) => {
      const target = annotation.target;
      switch (target.kind) {
        case 'event':
          return target.event_id === event.id;
        case 'event_pair':
          return target.event_a === event.id || target.event_b === event.id;
        case 'time_range': {
          if (target.asset_id && !event.source_ranges.some((r) => r.asset_id === target.asset_id)) return false;
          const range = {
            start_ms: target.start_ms + (target.asset_id ? captureOffsetMs : 0),
            end_ms: target.end_ms + (target.asset_id ? captureOffsetMs : 0),
          };
          // Half the event has to be inside the range, or a loosely drawn
          // selection would mark three neighbours essential as well.
          return overlapMs(range, event) >= Math.min(event.end_ms - event.start_ms, range.end_ms - range.start_ms) / 2;
        }
        case 'asset':
          return event.source_ranges.some((r) => r.asset_id === target.asset_id);
        case 'project':
          return true;
        default:
          return false;
      }
    })
    // Highest priority last, so it is applied last and therefore wins.
    .sort((a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at));
}

export interface AppliedKnowledge {
  knowledge: EventKnowledge;
  /** Fields the user overrode, applied to the event after the model wrote it. */
  overrides: {
    description?: string;
    title?: string;
    labels?: string[];
    people?: string[];
    mood?: Record<string, number>;
    narrativeRole?: string;
  };
  conflicts: Conflict[];
}

/**
 * Resolves the annotations that apply to one event.
 *
 * `essential` and `exclude` both applying is not a contradiction to silently
 * pick a winner in: it is a mistake the user made, and the safe reading is to
 * exclude, because including something they asked to remove is the worse error.
 */
export function applyAnnotations(
  event: SemanticEvent,
  applicable: readonly UserAnnotation[],
  occasion?: string,
  now: () => string = () => new Date().toISOString(),
): AppliedKnowledge {
  const knowledge: EventKnowledge = {
    ...(occasion ? { occasion } : {}),
    notes: [],
    essential: false,
    excluded: false,
    annotation_refs: [],
  };
  const overrides: AppliedKnowledge['overrides'] = {};
  const conflicts: Conflict[] = [];

  for (const annotation of applicable) {
    knowledge.annotation_refs.push(annotation.id);
    switch (annotation.type) {
      case 'essential':
        knowledge.essential = true;
        break;
      case 'exclude':
        knowledge.excluded = true;
        break;
      case 'importance':
        knowledge.importance_override = annotation.value;
        break;
      case 'note':
        knowledge.notes.push(annotation.text);
        break;
      case 'rename':
        overrides.title = annotation.title;
        break;
      case 'label':
        overrides.labels = [...(overrides.labels ?? []), ...annotation.labels];
        break;
      case 'person':
        overrides.people = annotation.people;
        break;
      case 'mood':
        overrides.mood = annotation.mood;
        if (Object.keys(event.affect.value).length > 0) {
          conflicts.push({
            id: newId('cfl'),
            path: `events.${event.id}.affect`,
            user_value: annotation.mood,
            inferred_value: event.affect.value,
            resolved_with: 'user_provided',
            note: 'the user corrected the affect the model inferred',
            detected_at: now(),
          });
        }
        break;
      case 'narrative_role':
        overrides.narrativeRole = annotation.role;
        break;
      default:
        break;
    }
  }

  if (knowledge.essential && knowledge.excluded) {
    // Excluding wins: including something the user asked to remove is the worse
    // of the two errors, and the contradiction is recorded so they can see it.
    knowledge.essential = false;
    conflicts.push({
      id: newId('cfl'),
      path: `events.${event.id}.knowledge`,
      user_value: { essential: true, excluded: true },
      resolved_with: 'user_provided',
      note: 'this event is marked both essential and excluded; it has been excluded',
      detected_at: now(),
    });
  }

  return { knowledge, overrides, conflicts };
}

/** Applies overrides on top of an event the model produced. */
export function withOverrides(event: SemanticEvent, applied: AppliedKnowledge): SemanticEvent {
  const next: SemanticEvent = { ...event, knowledge: applied.knowledge };
  const { overrides } = applied;

  if (overrides.title) {
    next.title = { value: overrides.title, provenance: 'user_provided', confidence: 1 };
  }
  if (overrides.labels) {
    next.observed = {
      ...next.observed,
      visual_labels: [...new Set([...next.observed.visual_labels, ...overrides.labels])],
    };
  }
  if (overrides.people) {
    next.entities = {
      ...next.entities,
      value: { ...next.entities.value, people: overrides.people },
      provenance: 'user_provided',
    };
  }
  if (overrides.mood) {
    next.affect = { value: overrides.mood, provenance: 'user_provided', confidence: 1 };
  }
  return next;
}

/** Continuity strengths the user set between specific pairs of events. */
export function continuityOverrides(annotations: readonly UserAnnotation[]): Map<string, number> {
  const overrides = new Map<string, number>();
  for (const annotation of annotations) {
    if (annotation.type !== 'continuity' || annotation.target.kind !== 'event_pair') continue;
    overrides.set(`${annotation.target.event_a}->${annotation.target.event_b}`, annotation.strength);
  }
  return overrides;
}

/** Time-range annotations that name no asset, for matching against capture time. */
export function projectRangeAnnotations(annotations: readonly UserAnnotation[]): UserAnnotation[] {
  return annotations.filter((a) => a.target.kind === 'time_range' && !a.target.asset_id);
}

export { rangesOverlap };
