import { z } from 'zod';
import { UnitScore, obj } from './primitives.js';
import { EventId, ModelRunId, RelationId } from './ids.js';
import { Provenance } from './provenance.js';

/**
 * Relations turn a list of events into a graph.
 *
 * The list already carries "what happened, in order". The graph carries the
 * things an editor actually reasons about: that this shot pays off that one,
 * that these two answer each other, that this is a second take of that.
 */
export const RELATION_TYPES = [
  /** B directly continues A in time and subject; cutting between them is free. */
  'continuation',
  /** B is the consequence the earlier A set up. */
  'payoff_of',
  /** A prepares the audience for B. */
  'setup_for',
  /** B is a reaction to A. */
  'reaction_to',
  /** B answers the question asked in A. */
  'answers',
  /** Same subject matter, not necessarily adjacent. */
  'same_topic',
  'same_location',
  'same_person',
  /** Deliberate opposition, useful for cutting between them. */
  'contrast',
  /** B refers back to A much later. */
  'callback',
  /** B covers the same material as A; at most one of them belongs in the edit. */
  'duplicate_of',
] as const;

export const RelationType = z.enum(RELATION_TYPES).meta({ id: 'RelationType' });
export type RelationType = z.infer<typeof RelationType>;

export const EventRelation = obj({
  id: RelationId,
  source_event_id: EventId,
  target_event_id: EventId,
  relation_type: RelationType,
  /** How strongly the relation holds, in [0,1]. */
  strength: UnitScore,
  provenance: Provenance,
  model_run_id: ModelRunId.optional(),
  note: z.string().optional(),
}).meta({ id: 'EventRelation', title: 'EventRelation' });
export type EventRelation = z.infer<typeof EventRelation>;

/** Relations that are symmetric: storing A→B implies B→A. */
export const SYMMETRIC_RELATIONS: ReadonlySet<RelationType> = new Set<RelationType>([
  'same_topic',
  'same_location',
  'same_person',
  'contrast',
  'duplicate_of',
]);
