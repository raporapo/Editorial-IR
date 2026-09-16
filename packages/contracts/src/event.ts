import { z } from 'zod';
import { Confidence, Milliseconds, UnitScore, obj } from './primitives.js';
import { AnnotationId, AssetId, ChapterId, EventId } from './ids.js';
import { ProvenancedString, Provenance, provenanced } from './provenance.js';
import { NarrativeRole } from './editorial.js';

/**
 * Where an event's material actually lives.
 *
 * An event occupies one range on the capture timeline but may draw on several
 * assets (two cameras on the same moment), so the source ranges are explicit.
 */
export const EventSourceRange = obj({
  asset_id: AssetId,
  source_in_ms: Milliseconds,
  source_out_ms: Milliseconds,
}).meta({ id: 'EventSourceRange' });
export type EventSourceRange = z.infer<typeof EventSourceRange>;

/**
 * Affect is an open vocabulary of named intensities in [0,1].
 *
 * It is deliberately not an enum of "emotions": editing cares about
 * gradients ("how excited"), not about picking one label, and different Skills
 * care about different axes.
 */
export const Affect = z.record(z.string(), UnitScore).meta({
  id: 'Affect',
  description: 'Named affect intensities in [0,1], e.g. {"excitement":0.88,"happiness":0.83}.',
});
export type Affect = z.infer<typeof Affect>;

/** Well-known affect axes. Backends may emit others; these are the ones Skills can rely on. */
export const STANDARD_AFFECT_AXES = [
  'excitement',
  'happiness',
  'calm',
  'tension',
  'sadness',
  'intimacy',
  'humour',
  'awe',
] as const;

export const Entities = obj({
  /** Ids from `background.people` where resolvable, otherwise free text. */
  people: z.array(z.string()).default([]),
  places: z.array(z.string()).default([]),
  objects: z.array(z.string()).default([]),
  topics: z.array(z.string()).default([]),
  organisations: z.array(z.string()).default([]),
}).meta({ id: 'Entities' });
export type Entities = z.infer<typeof Entities>;

/**
 * The observations that informed this event, copied in at compile time.
 *
 * Denormalised on purpose: an event must be readable and reviewable on its own,
 * including by an agent that is only allowed to see events. The originals stay
 * in the ObservationTimeline.
 */
export const EventObservations = obj({
  speech: z
    .array(
      obj({
        text: z.string(),
        start_ms: Milliseconds,
        end_ms: Milliseconds,
        speaker_id: z.string().optional(),
        confidence: Confidence,
      }),
    )
    .default([]),
  visual_labels: z.array(z.string()).default([]),
  ocr: z.array(z.string()).default([]),
  audio: z.array(obj({ type: z.string(), confidence: Confidence })).default([]),
  shot_ids: z.array(z.string()).default([]),
  /** Number of distinct shots. A high count in a short event means fast cutting already happened. */
  shot_count: z.int().min(0).default(0),
  /** Fraction of the event occupied by speech, in [0,1]. */
  speech_ratio: UnitScore.default(0),
  /** Fraction of the event below the silence threshold, in [0,1]. */
  silence_ratio: UnitScore.default(0),
  /** Mean camera motion in [0,1]. */
  motion: UnitScore.optional(),
  /** Mean technical quality in [0,1], from sharpness and exposure. */
  technical_quality: UnitScore.optional(),
}).meta({ id: 'EventObservations' });
export type EventObservations = z.infer<typeof EventObservations>;

/** User knowledge that applies to this event, resolved from context and annotations. */
export const EventKnowledge = obj({
  occasion: z.string().optional(),
  /** Free text the user attached to this moment. */
  notes: z.array(z.string()).default([]),
  /** The user demanded this event be kept. */
  essential: z.boolean().default(false),
  /** The user demanded this event be dropped. */
  excluded: z.boolean().default(false),
  /** Importance the user set explicitly, overriding the decision layer. */
  importance_override: UnitScore.optional(),
  /** Narrative role the user set explicitly, e.g. "this is the ending". */
  narrative_role_override: NarrativeRole.optional(),
  /** Ids of the annotations that produced the fields above. */
  annotation_refs: z.array(AnnotationId).default([]),
}).meta({ id: 'EventKnowledge' });
export type EventKnowledge = z.infer<typeof EventKnowledge>;

const ProvenancedEntities = provenanced(Entities, 'ProvenancedEntities');
const ProvenancedAffect = provenanced(Affect, 'ProvenancedAffect');

/**
 * A semantic event: one thing that happened.
 *
 * A shot is a camera unit; an event is a unit of meaning. Three shots of walking
 * up to a gate are one event, and the boundary between events is where the
 * *subject* changes, not where the camera cut.
 */
export const SemanticEvent = obj({
  id: EventId,
  chapter_id: ChapterId.optional(),
  /** Position on the capture timeline (see AssetPlacement). */
  start_ms: Milliseconds,
  end_ms: Milliseconds,
  source_ranges: z.array(EventSourceRange).min(1),
  /** One sentence describing what happens. */
  description: ProvenancedString,
  /** Open-vocabulary kind, e.g. `arrival`, `meal`, `travel`, `reaction`. */
  event_type: ProvenancedString,
  /** Short display title, used by the semantic timeline UI. */
  title: ProvenancedString.optional(),
  entities: ProvenancedEntities,
  affect: ProvenancedAffect,
  observed: EventObservations,
  knowledge: EventKnowledge,
  /** How the boundaries of this event were decided. */
  segmentation: obj({
    method: z.enum(['shot', 'speech', 'silence', 'similarity', 'user', 'asset', 'fixed']),
    boundary_confidence: Confidence,
  }),
  /** Ids of embeddings held in the sidecar vector store. */
  embedding_refs: z.array(z.string()).default([]),
  confidence: Confidence,
}).meta({ id: 'SemanticEvent', title: 'SemanticEvent' });
export type SemanticEvent = z.infer<typeof SemanticEvent>;

/**
 * A chapter groups consecutive events that belong to the same phase of the day
 * or the same topic. Chapters exist so the agent can budget time at a coarse
 * level before it looks at individual events.
 */
export const Chapter = obj({
  id: ChapterId,
  start_ms: Milliseconds,
  end_ms: Milliseconds,
  title: ProvenancedString,
  summary: ProvenancedString.optional(),
  event_ids: z.array(EventId).default([]),
  /** Dominant place across the chapter's events, when one exists. */
  place: z.string().optional(),
  provenance: Provenance,
}).meta({ id: 'Chapter', title: 'Chapter' });
export type Chapter = z.infer<typeof Chapter>;
