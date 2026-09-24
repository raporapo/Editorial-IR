import {
  compareText,
  EditorialError,
  assessmentFor,
  chapterById,
  eventById,
  eventsInOrder,
  formatTimecode,
  neighboursOf,
  type Chapter,
  type EditPlan,
  type EditorialIR,
  type EmbeddingKind,
  type ProjectContext,
  type SemanticEvent,
  type ValidationReport,
} from '@editorial-ir/contracts';
import type { SemanticIndex, SearchHit } from '@editorial-ir/index';
import { planEdit, type PlanOptions } from './planner.js';
import { validatePlan, type ValidateOptions } from './validator.js';

/**
 * The two layers below the event, supplied by whoever built the toolkit.
 *
 * The toolkit itself reads an in-memory document and nothing else, which is what
 * makes it testable without a project on disk. Shots and frames live on disk, so
 * they arrive through this rather than through a filesystem call in here.
 */
export interface InspectionSource {
  /** The shots one event is made of. */
  shots(event: SemanticEvent): ShotDetail[];
  /** Sampled frames for one event, or none if the media was never sampled. */
  frames(event: SemanticEvent, options?: { count?: number; perShot?: boolean }): FrameRef[];
  /** Lays frames out as a single image and returns where it was written. */
  contactSheet?(event: SemanticEvent, options?: { count?: number }): Promise<string>;
}

export interface ShotDetail {
  shot: { id: string; asset_id: string; start_ms: number; end_ms: number };
  offset_ms: number;
  duration_ms: number;
  whole: boolean;
}

export interface FrameRef {
  path: string;
  asset_id: string;
  source_ms: number;
}

/**
 * What an editing agent is allowed to do.
 *
 * Deliberately narrow. An agent works on the Editorial IR, not on video and not
 * on an editing application: it can read events, search them, look closer at one
 * when it needs to, and produce a plan that then goes through the same validator
 * as everything else. It cannot reach past the IR into an NLE, which is what
 * stops "the agent drives Premiere" from ever becoming the architecture.
 *
 * Progressive inspection is the shape of it: the summary first, the detail only
 * where the summary was not enough.
 */
export interface EventSummary {
  id: string;
  chapter_id?: string;
  start: string;
  end: string;
  duration_ms: number;
  description: string;
  event_type: string;
  role: string;
  importance: number;
  emotion: number;
  redundancy: number;
  essential: boolean;
  confidence: number;
  /**
   * Share of the event that was still and silent, when any of it was.
   *
   * The analysis already decided not to spend a model on these stretches, and
   * the editing agent is the next thing that would: an event at 0.9 described
   * as "a static shot" invites a closer look, and a contact sheet of it is nine
   * pictures of the same frame, paid for. Absent when none of it was, as in the
   * IR, so the common case costs the model nothing to read.
   */
  inactive_ratio?: number;
}

export type DetailLevel = 'summary' | 'detailed' | 'full';

export interface ListEventsFilter {
  timeRange?: { start_ms: number; end_ms: number };
  chapterId?: string;
  minImportance?: number;
  maxRedundancy?: number;
  role?: string;
  eventType?: string;
  hasSpeech?: boolean;
  essentialOnly?: boolean;
  limit?: number;
}

export class AgentToolkit {
  constructor(
    private readonly ir: EditorialIR,
    private readonly index?: SemanticIndex,
    private readonly inspection?: InspectionSource,
  ) {}

  /** Everything the user said this piece is for. */
  getProjectContext(): ProjectContext & {
    title: string;
    total_duration_ms: number;
    event_count: number;
  } {
    return {
      ...this.ir.context,
      title: this.ir.project.title,
      total_duration_ms: this.ir.stats.total_media_duration_ms,
      event_count: this.ir.stats.event_count,
    };
  }

  listChapters(): (Chapter & { duration_ms: number })[] {
    return this.ir.chapters.map((chapter) => ({
      ...chapter,
      duration_ms: chapter.end_ms - chapter.start_ms,
    }));
  }

  listEvents(filter: ListEventsFilter = {}): EventSummary[] {
    let events = eventsInOrder(this.ir);

    if (filter.timeRange) {
      const { start_ms, end_ms } = filter.timeRange;
      events = events.filter((e) => e.start_ms < end_ms && start_ms < e.end_ms);
    }
    if (filter.chapterId) events = events.filter((e) => e.chapter_id === filter.chapterId);
    if (filter.eventType) events = events.filter((e) => e.event_type.value === filter.eventType);
    if (filter.hasSpeech !== undefined) {
      events = events.filter((e) => e.observed.speech.length > 0 === filter.hasSpeech);
    }
    if (filter.essentialOnly) events = events.filter((e) => e.knowledge.essential);

    let summaries = events.map((event) => this.summarise(event));
    if (filter.minImportance !== undefined) {
      summaries = summaries.filter((s) => s.importance >= filter.minImportance!);
    }
    if (filter.maxRedundancy !== undefined) {
      summaries = summaries.filter((s) => s.redundancy <= filter.maxRedundancy!);
    }
    if (filter.role) summaries = summaries.filter((s) => s.role === filter.role);

    return filter.limit === undefined ? summaries : summaries.slice(0, filter.limit);
  }

  getEvent(eventId: string): EventSummary | undefined {
    const event = eventById(this.ir, eventId);
    return event ? this.summarise(event) : undefined;
  }

  getNeighbours(eventId: string): { previous?: EventSummary; next?: EventSummary } {
    const { previous, next } = neighboursOf(this.ir, eventId);
    return {
      ...(previous ? { previous: this.summarise(previous) } : {}),
      ...(next ? { next: this.summarise(next) } : {}),
    };
  }

  /**
   * Looks closer at one event.
   *
   * The reason this is a separate call rather than part of every listing: an
   * agent asked to plan a three-minute cut from six hundred events cannot be
   * handed every transcript, and does not need to be.
   */
  inspectEvent(
    eventId: string,
    detail: DetailLevel = 'detailed',
  ): Record<string, unknown> | undefined {
    const event = eventById(this.ir, eventId);
    if (!event) return undefined;
    const assessment = assessmentFor(this.ir, eventId);
    const summary = this.summarise(event);

    if (detail === 'summary') return { ...summary };

    const detailed: Record<string, unknown> = {
      ...summary,
      speech: event.observed.speech.map((s) => s.text),
      on_screen_text: event.observed.ocr,
      seen: event.observed.visual_labels,
      sound: [...new Set(event.observed.audio.map((a) => a.type))],
      people: event.entities.value.people,
      places: event.entities.value.places,
      topics: event.entities.value.topics,
      affect: event.affect.value,
      user_notes: event.knowledge.notes,
      excluded: event.knowledge.excluded,
    };
    if (detail === 'detailed') return detailed;

    return {
      ...detailed,
      metrics: assessment?.metrics ?? {},
      flags: assessment?.flags ?? {},
      narrative_role_probabilities: assessment?.narrative_role.probabilities ?? {},
      rationale: assessment?.rationale,
      source_ranges: event.source_ranges,
      segmentation: event.segmentation,
      relations: this.relationsFor(eventId),
      // Provenance is part of the answer: an agent should be able to tell what
      // was observed from what was guessed.
      provenance: {
        description: event.description.provenance,
        entities: event.entities.provenance,
        affect: event.affect.provenance,
      },
    };
  }

  compareEvents(eventIds: readonly string[]): Record<string, unknown>[] {
    return eventIds
      .map((id) => this.inspectEvent(id, 'detailed'))
      .filter((event): event is Record<string, unknown> => event !== undefined);
  }

  /* --- below the event ----------------------------------------------------- */

  /**
   * The shots one event is made of.
   *
   * An event is a stretch of meaning and a shot is a stretch of camera, and they
   * do not line up. "Why does this event look like that" is often answered by
   * "because it is four shots and one of them is of the ground".
   */
  listShots(eventId: string): ShotDetail[] {
    const event = eventById(this.ir, eventId);
    if (!event || !this.inspection) return [];
    return this.inspection.shots(event);
  }

  /**
   * Sampled frames for one event.
   *
   * Empty when the media was ingested without frame sampling, or when the work
   * directory has since been deleted — both are normal, and neither is an error.
   */
  listFrames(eventId: string, options: { count?: number; perShot?: boolean } = {}): FrameRef[] {
    const event = eventById(this.ir, eventId);
    if (!event || !this.inspection) return [];
    return this.inspection.frames(event, options);
  }

  /**
   * One image showing what an event looks like.
   *
   * The bottom of the staircase, and the step that costs money: a hosted vision
   * model charges per image. A grid answers "what actually happens here" about
   * as well as the separate frames do, for a fraction of the price, and it shows
   * the order.
   */
  async getContactSheet(eventId: string, options: { count?: number } = {}): Promise<string> {
    const event = eventById(this.ir, eventId);
    if (!event) {
      throw new EditorialError('not_found', `no event called ${eventId}`);
    }
    if (!this.inspection?.contactSheet) {
      throw new EditorialError(
        'unsupported',
        'this toolkit was built without a way to look at frames',
      );
    }
    return this.inspection.contactSheet(event, options);
  }

  relationsFor(eventId: string): { type: string; other: string; strength: number }[] {
    return this.ir.relations
      .filter((r) => r.source_event_id === eventId || r.target_event_id === eventId)
      .map((r) => ({
        type: r.relation_type,
        other: r.source_event_id === eventId ? r.target_event_id : r.source_event_id,
        strength: r.strength,
      }))
      .sort((a, b) => b.strength - a.strength || compareText(a.other, b.other));
  }

  /* --- search ------------------------------------------------------------- */

  private async searchAspect(
    query: string,
    kind: EmbeddingKind,
    limit: number,
  ): Promise<SearchHit[]> {
    if (!this.index) return [];
    return this.index.search(query, { kinds: [kind], limit });
  }

  /** "the shot with the night view" */
  searchVisual(query: string, limit = 8): Promise<SearchHit[]> {
    return this.searchAspect(query, 'visual', limit);
  }

  /** "where they say let's come back" */
  searchSpeech(query: string, limit = 8): Promise<SearchHit[]> {
    return this.searchAspect(query, 'speech', limit);
  }

  /** "the part where they arrive" */
  searchEvent(query: string, limit = 8): Promise<SearchHit[]> {
    return this.searchAspect(query, 'event', limit);
  }

  /** "the parts that feel like an anniversary" */
  searchContext(query: string, limit = 8): Promise<SearchHit[]> {
    return this.searchAspect(query, 'context', limit);
  }

  /** "something calm" */
  searchMood(query: string, limit = 8): Promise<SearchHit[]> {
    return this.searchAspect(query, 'mood', limit);
  }

  /** Searches every aspect and keeps each event's best match. */
  async search(query: string, limit = 10): Promise<SearchHit[]> {
    if (!this.index) return [];
    return this.index.search(query, { limit });
  }

  /* --- planning ----------------------------------------------------------- */

  createEditPlan(options: Omit<PlanOptions, 'ir'>): EditPlan {
    return planEdit({ ...options, ir: this.ir });
  }

  validateEditPlan(plan: unknown, options: Omit<ValidateOptions, 'ir'> = {}): ValidationReport {
    return validatePlan(plan, { ...options, ir: this.ir });
  }

  private summarise(event: SemanticEvent): EventSummary {
    const assessment = assessmentFor(this.ir, event.id);
    return {
      id: event.id,
      ...(event.chapter_id ? { chapter_id: event.chapter_id } : {}),
      start: formatTimecode(event.start_ms, false),
      end: formatTimecode(event.end_ms, false),
      duration_ms: event.end_ms - event.start_ms,
      description: event.description.value,
      event_type: event.event_type.value,
      role: assessment?.narrative_role.selected ?? 'context',
      importance: assessment?.metrics.story_importance ?? 0.5,
      emotion: assessment?.metrics.emotional_intensity ?? 0.5,
      redundancy: assessment?.metrics.redundancy ?? 0.5,
      essential: event.knowledge.essential,
      confidence: event.confidence,
      ...(event.observed.inactive_ratio ? { inactive_ratio: event.observed.inactive_ratio } : {}),
    };
  }
}

/**
 * The toolkit as tool definitions, for driving it with a language model.
 *
 * Shipped as data so that a model-driven agent and the deterministic planner see
 * exactly the same surface. Anything a model can reach for here is something the
 * rule-based path can do too.
 */
export const AGENT_TOOL_DEFINITIONS = [
  {
    name: 'get_project_context',
    description:
      'What the user said this piece is for: occasion, people, places, goal, target duration.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_chapters',
    description: 'The coarse structure of the material. Start here before looking at events.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_events',
    description: 'Events, optionally filtered. Returns summaries, not transcripts.',
    parameters: {
      type: 'object',
      properties: {
        chapterId: { type: 'string' },
        minImportance: { type: 'number' },
        maxRedundancy: { type: 'number' },
        role: { type: 'string' },
        eventType: { type: 'string' },
        hasSpeech: { type: 'boolean' },
        essentialOnly: { type: 'boolean' },
        limit: { type: 'integer' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'inspect_event',
    description:
      'Look closer at one event. Use "full" only when the summary genuinely was not enough; it is the expensive one.',
    parameters: {
      type: 'object',
      properties: {
        eventId: { type: 'string' },
        detail: { type: 'string', enum: ['summary', 'detailed', 'full'] },
      },
      required: ['eventId'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_shots',
    description:
      'The shots one event is made of. Use when an event behaves oddly and you want to know whether it is one continuous take or five.',
    parameters: {
      type: 'object',
      properties: { eventId: { type: 'string' } },
      required: ['eventId'],
      additionalProperties: false,
    },
  },
  {
    name: 'look_at_event',
    description:
      'Actually look at an event, as a grid of frames. The last resort and the only tool that costs money per call: everything above is text. Use it when the description and the shots still do not tell you what is on screen. Not for an event whose summary gives inactive_ratio near 1: that much of it is still and silent, and the frames are the same picture repeated.',
    parameters: {
      type: 'object',
      properties: {
        eventId: { type: 'string' },
        count: {
          type: 'integer',
          description: 'How many frames to show. 4 to 9 is usually enough.',
        },
      },
      required: ['eventId'],
      additionalProperties: false,
    },
  },
  {
    name: 'search',
    description:
      'Find events by describing them. Aspects: visual for what is on screen, speech for what was said, event for what happened, context for what it meant, mood for how it felt.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        aspect: { type: 'string', enum: ['any', 'visual', 'speech', 'event', 'context', 'mood'] },
        limit: { type: 'integer' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_neighbours',
    description:
      'The events immediately before and after one event, for judging whether a cut would strand it.',
    parameters: {
      type: 'object',
      properties: { eventId: { type: 'string' } },
      required: ['eventId'],
      additionalProperties: false,
    },
  },
  {
    name: 'compare_events',
    description: 'Several events side by side, for choosing between takes of the same thing.',
    parameters: {
      type: 'object',
      properties: { eventIds: { type: 'array', items: { type: 'string' } } },
      required: ['eventIds'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_edit_plan',
    description:
      'Produce an EditPlan from a skill and a target duration. The plan is validated before it is used.',
    parameters: {
      type: 'object',
      properties: { skill: { type: 'string' }, targetDurationMs: { type: 'integer' } },
      required: ['skill'],
      additionalProperties: false,
    },
  },
  {
    name: 'validate_edit_plan',
    description:
      'Check a plan against the media, the user’s instructions and the target application.',
    parameters: {
      type: 'object',
      properties: { plan: { type: 'object' } },
      required: ['plan'],
      additionalProperties: false,
    },
  },
] as const;

export { chapterById };
