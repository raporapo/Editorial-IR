import {
  seqId,
  type EditorialAssessment,
  type EventEditorial,
  type EventState,
  type ProjectContext,
  type SemanticEvent,
} from '@editorial-ir/contracts';
import { assessEvent, type EditorialDecisionModel } from '@editorial-ir/decision';
import { type CostBudget, selectForEscalation, type EscalationPolicy } from './budget.js';
import type { ModelRunRecorder } from './model-runs.js';

/**
 * Running the decision layer over every event.
 *
 * The same escalation shape as the context builder, for the same reason: most
 * events are unambiguous and a rule answers them as well as anything would, and
 * the few that are not are where a better judgement changes the cut.
 *
 * The user's explicit importance is applied after the model has answered, not
 * instead of asking. The model's opinion stays in the record; the user's wins.
 */
export interface AssessOptions {
  context: ProjectContext;
  runs: ModelRunRecorder;
  /** Answers every event. */
  baseModel: EditorialDecisionModel;
  /** Answers the events worth spending on. */
  escalationModel?: EditorialDecisionModel;
  escalation?: EscalationPolicy;
  budget?: CostBudget;
  /** Highest similarity each event has to any other, for redundancy. */
  similarities?: Map<string, number>;
  onProgress?: (stage: string, done: number, total: number) => void;
}

export async function assessEvents(
  events: readonly SemanticEvent[],
  options: AssessOptions,
): Promise<{ editorial: EventEditorial[]; escalated: string[] }> {
  const ordered = [...events].sort((a, b) => a.start_ms - b.start_ms);
  const totalMs = ordered.reduce((sum, e) => sum + (e.end_ms - e.start_ms), 0) || 1;
  const states = new Map<string, EventState>();

  for (const [index, event] of ordered.entries()) {
    states.set(
      event.id,
      buildEventState(
        event,
        ordered[index - 1],
        ordered[index + 1],
        index / Math.max(1, ordered.length - 1),
        {
          context: options.context,
          ...(options.similarities?.has(event.id)
            ? { maxSimilarity: options.similarities.get(event.id)! }
            : {}),
        },
      ),
    );
  }

  const baseRun = options.runs.record({
    stage: 'decision',
    backend: options.baseModel.identity.backend,
    ...(options.baseModel.identity.model === undefined
      ? {}
      : { model: options.baseModel.identity.model }),
    locality: options.baseModel.identity.locality,
    mediaLeavesDevice: options.baseModel.identity.mediaLeavesDevice,
  });

  const drafts = new Map<string, Awaited<ReturnType<typeof assessEvent>>>();
  for (const [index, event] of ordered.entries()) {
    options.onProgress?.('assess', index, ordered.length);
    drafts.set(event.id, await assessEvent(options.baseModel, states.get(event.id)!));
  }

  const escalated: string[] = [];
  if (options.escalationModel) {
    const model = options.escalationModel;
    const costPerEvent = model.identity.costPerEventUsd ?? 0.002;
    const decision = selectForEscalation(
      ordered.map((event) => {
        const draft = drafts.get(event.id)!;
        return {
          id: event.id,
          // Worth asking again where the cheap answer is unsure, where the event
          // is long, and where the decision is close to the line that decides
          // whether it survives at all.
          value:
            0.5 * (1 - draft.confidence) +
            0.3 * Math.min(1, ((event.end_ms - event.start_ms) / totalMs) * 20) +
            0.2 * (1 - Math.abs(draft.metrics.story_importance - 0.5) * 2),
          costUsd: costPerEvent,
        };
      }),
      options.escalation ?? {},
    );

    const escalationRun = options.runs.record({
      stage: 'decision',
      backend: model.identity.backend,
      ...(model.identity.model === undefined ? {} : { model: model.identity.model }),
      locality: model.identity.locality,
      mediaLeavesDevice: model.identity.mediaLeavesDevice,
    });

    let done = 0;
    for (const eventId of decision.selected) {
      options.onProgress?.('reassess', done++, decision.selected.length);
      options.budget?.spend(costPerEvent, `a second opinion on ${eventId}`);
      const draft = await assessEvent(model, states.get(eventId)!);
      drafts.set(eventId, draft);
      escalated.push(eventId);
      options.runs.addCost(
        escalationRun,
        draft.costUsd ?? costPerEvent,
        draft.inputTokens,
        draft.outputTokens,
      );
    }
  }

  const editorial: EventEditorial[] = ordered.map((event, index) => {
    const draft = drafts.get(event.id)!;
    const wasEscalated = escalated.includes(event.id);

    const assessment: EditorialAssessment = {
      id: seqId('asm', index + 1),
      event_id: event.id,
      model_run_id: baseRun,
      metrics: { ...draft.metrics },
      flags: { ...draft.flags },
      narrative_role: draft.narrative_role,
      ...(draft.rationale ? { rationale: draft.rationale } : {}),
      confidence: draft.confidence,
    };

    // The user outranks the model, and the model's answer is kept beside the
    // override rather than replaced by it.
    const override = event.knowledge.importance_override;
    if (override !== undefined) {
      const original: EditorialAssessment = {
        ...assessment,
        id: `${assessment.id}_model`,
        rationale: 'the model’s own assessment, kept because the user overrode it',
      };
      assessment.metrics = { ...assessment.metrics, story_importance: override };
      assessment.flags = {
        ...assessment.flags,
        preserve: Math.max(assessment.flags.preserve, override),
      };
      return { event_id: event.id, current: assessment, history: [original] };
    }

    void wasEscalated;
    return { event_id: event.id, current: assessment, history: [] };
  });

  return { editorial, escalated };
}

/** Builds the structured state a decision backend sees. */
export function buildEventState(
  event: SemanticEvent,
  previous: SemanticEvent | undefined,
  next: SemanticEvent | undefined,
  relativePosition: number,
  options: { context: ProjectContext; maxSimilarity?: number },
): EventState {
  const { context } = options;
  return {
    event_id: event.id,
    duration_ms: event.end_ms - event.start_ms,
    relative_position: Math.min(1, Math.max(0, relativePosition)),
    observed: {
      speech: event.observed.speech.map((s) => s.text),
      visual_labels: event.observed.visual_labels,
      ocr: event.observed.ocr,
      audio: [...new Set(event.observed.audio.map((a) => a.type))],
      shot_count: event.observed.shot_count,
      speech_ratio: event.observed.speech_ratio,
      silence_ratio: event.observed.silence_ratio,
      ...(event.observed.technical_quality === undefined
        ? {}
        : { technical_quality: event.observed.technical_quality }),
    },
    semantic: {
      description: event.description.value,
      event_type: event.event_type.value,
      entities: {
        people: event.entities.value.people,
        places: event.entities.value.places,
        topics: event.entities.value.topics,
      },
      affect: event.affect.value,
    },
    ...(previous
      ? {
          previous_event: {
            description: previous.description.value,
            event_type: previous.event_type.value,
          },
        }
      : {}),
    ...(next
      ? { next_event: { description: next.description.value, event_type: next.event_type.value } }
      : {}),
    user_context: {
      ...(context.background.occasion ? { occasion: context.background.occasion } : {}),
      ...(context.editing_goal.instruction ? { goal: context.editing_goal.instruction } : {}),
      tone: context.editing_goal.tone,
      notes: event.knowledge.notes,
      essential: event.knowledge.essential,
    },
    ...(options.maxSimilarity === undefined
      ? {}
      : { max_similarity_to_others: options.maxSimilarity }),
  };
}
