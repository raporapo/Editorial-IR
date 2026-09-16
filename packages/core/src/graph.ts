import {
  coverage,
  seqId,
  type EventRelation,
  type RelationType,
  type SemanticEvent,
} from '@editorial-ir/contracts';

/**
 * The event graph.
 *
 * A list of events already carries "what happened, in order". The graph carries
 * what an editor actually reasons about: that this pays off that, that these two
 * are the same take, that this shot only makes sense after that one. It is what
 * makes "cutting here would strand the setup" a checkable statement rather than
 * an instinct.
 */
export interface GraphOptions {
  /** Similarity above which two events are considered second takes of each other. */
  duplicateThreshold?: number;
  /** Similarity above which two events are considered to be on the same topic. */
  topicThreshold?: number;
  /** Strengths the user set explicitly, keyed `a->b`. Never overwritten. */
  continuityOverrides?: Map<string, number>;
  /** Similarity between two events, when an index is available. */
  similarity?: (a: string, b: string) => number | undefined;
  /** How far apart two events may be and still be linked as a callback. */
  maxCallbackDistance?: number;
}

const DEFAULTS = {
  duplicateThreshold: 0.88,
  topicThreshold: 0.6,
  maxCallbackDistance: 40,
};

export function buildEventGraph(
  events: readonly SemanticEvent[],
  options: GraphOptions = {},
): EventRelation[] {
  const settings = { ...DEFAULTS, ...options };
  const ordered = [...events].sort((a, b) => a.start_ms - b.start_ms);
  const relations: EventRelation[] = [];
  let counter = 0;

  const add = (
    source: string,
    target: string,
    type: RelationType,
    strength: number,
    provenance: EventRelation['provenance'] = 'inferred',
    note?: string,
  ): void => {
    if (strength <= 0) return;
    relations.push({
      id: seqId('rel', ++counter, 5),
      source_event_id: source,
      target_event_id: target,
      relation_type: type,
      strength: Math.round(Math.min(1, Math.max(0, strength)) * 10_000) / 10_000,
      provenance,
      ...(note ? { note } : {}),
    });
  };

  // ---- adjacency -----------------------------------------------------------
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1]!;
    const event = ordered[i]!;
    const key = `${previous.id}->${event.id}`;

    const override = settings.continuityOverrides?.get(key);
    if (override !== undefined) {
      // The user's word about continuity is not a signal to blend in; it is the
      // answer, and it is marked as theirs.
      add(previous.id, event.id, 'continuation', override, 'user_provided', 'set by the user');
      continue;
    }

    add(previous.id, event.id, 'continuation', continuityBetween(previous, event, settings));
  }

  // ---- pairwise ------------------------------------------------------------
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const a = ordered[i]!;
      const b = ordered[j]!;
      const similarity = settings.similarity?.(a.id, b.id) ?? textSimilarity(a, b);

      if (similarity >= settings.duplicateThreshold) {
        add(a.id, b.id, 'duplicate_of', similarity, 'inferred', 'these look like two takes of the same thing');
      } else if (similarity >= settings.topicThreshold) {
        add(a.id, b.id, 'same_topic', similarity);
      }

      const sharedPlace = shared(a.entities.value.places, b.entities.value.places);
      if (sharedPlace.length > 0) add(a.id, b.id, 'same_location', 0.6 + 0.1 * sharedPlace.length);

      const sharedPeople = shared(a.entities.value.people, b.entities.value.people);
      if (sharedPeople.length > 0) add(a.id, b.id, 'same_person', 0.5 + 0.15 * sharedPeople.length);

      // A callback: the same subject returning much later, which is worth
      // knowing because dropping the first one strands the second.
      if (j - i > 8 && j - i <= settings.maxCallbackDistance && similarity >= settings.topicThreshold) {
        add(a.id, b.id, 'callback', similarity * 0.8);
      }
    }
  }

  return relations;
}

/**
 * How continuous two adjacent events are.
 *
 * Place first, because a cut between two places is the one a viewer notices;
 * then subject, then whether the two were even recorded in the same file.
 */
export function continuityBetween(
  previous: SemanticEvent,
  event: SemanticEvent,
  options: { maxCallbackDistance?: number } = {},
): number {
  void options;
  const sameAsset = previous.source_ranges[0]?.asset_id === event.source_ranges[0]?.asset_id;
  const gapMs = Math.max(0, event.start_ms - previous.end_ms);

  const places = shared(previous.entities.value.places, event.entities.value.places);
  const samePlace = places.length > 0;
  const noPlaces =
    previous.entities.value.places.length === 0 && event.entities.value.places.length === 0;

  const subject = coverage(previous.description.value, event.description.value);

  let score = 0.25;
  if (sameAsset) score += 0.2;
  if (samePlace) score += 0.3;
  else if (noPlaces) score += 0.1;
  score += 0.25 * subject;
  // Time apart erodes continuity: two minutes later is a different moment.
  score -= Math.min(0.3, gapMs / 600_000);

  return Math.min(1, Math.max(0, score));
}

/** The relations that bear on whether an event can be used on its own. */
export function dependenciesOf(relations: readonly EventRelation[], eventId: string): string[] {
  return [
    ...new Set(
      relations
        .filter(
          (relation) =>
            relation.target_event_id === eventId &&
            (relation.relation_type === 'setup_for' ||
              relation.relation_type === 'answers' ||
              relation.relation_type === 'reaction_to'),
        )
        .map((relation) => relation.source_event_id),
    ),
  ];
}

/** Groups of events that cover the same material; at most one belongs in a cut. */
export function duplicateGroups(relations: readonly EventRelation[]): string[][] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const seen = parent.get(id);
    if (seen === undefined || seen === id) return id;
    const root = find(seen);
    parent.set(id, root);
    return root;
  };
  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };

  for (const relation of relations) {
    if (relation.relation_type !== 'duplicate_of') continue;
    parent.set(relation.source_event_id, parent.get(relation.source_event_id) ?? relation.source_event_id);
    parent.set(relation.target_event_id, parent.get(relation.target_event_id) ?? relation.target_event_id);
    union(relation.source_event_id, relation.target_event_id);
  }

  const groups = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    const group = groups.get(root) ?? [];
    group.push(id);
    groups.set(root, group);
  }

  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => group.sort())
    .sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
}

/**
 * Similarity from text, when no index is available.
 *
 * An event with nothing said, nothing on screen and nothing detected has no
 * distinctive content, and comparing two of those finds them identical — which
 * would make every quiet moment in a project a duplicate of every other. So an
 * event with nothing to compare is compared to nothing.
 */
function textSimilarity(a: SemanticEvent, b: SemanticEvent): number {
  const left = distinctiveText(a);
  const right = distinctiveText(b);
  if (left.length === 0 || right.length === 0) return 0;
  return Math.max(coverage(left, right), coverage(right, left));
}

function distinctiveText(event: SemanticEvent): string {
  return [
    ...event.observed.speech.map((s) => s.text),
    ...event.observed.ocr,
    ...event.observed.visual_labels,
    ...event.entities.value.topics,
    ...event.entities.value.places,
  ]
    .join(' ')
    .trim();
}

function shared(a: readonly string[], b: readonly string[]): string[] {
  const set = new Set(b);
  return a.filter((value) => set.has(value));
}
