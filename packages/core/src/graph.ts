import {
  coverage,
  matchFeatures,
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
  /**
   * How many links of one associative kind an event keeps, strongest first.
   *
   * The associative kinds — same topic, same place, same person, callback — are
   * pairwise, so without a bound the graph grows with the square of the events
   * and an hour of footage is not a small number of events. Measured on
   * synthetic material: 600 events produced 220,000 relations and 28 MB of JSON
   * inside `ir.json`, and 1,200 produced 716,000 and 101 MB, taking fifteen
   * seconds to build. One long recording is the commonest input there is.
   *
   * Nothing wants them all. These links are an associative aid — "what else is
   * about this" — and every consumer already takes a handful: the agent toolkit
   * returns the six strongest, `oea explain` prints six. Keeping each event's
   * strongest few preserves what they are for and makes the graph linear.
   *
   * `continuation` is never capped: it is one link per adjacent pair, so already
   * linear, and dropping one would invent a discontinuity that is not there.
   */
  maxPerEventPerKind?: number;
}

const DEFAULTS = {
  duplicateThreshold: 0.88,
  topicThreshold: 0.6,
  maxCallbackDistance: 40,
  maxPerEventPerKind: 8,
};

/**
 * Links that say two events are alike, rather than that one follows another.
 *
 * `duplicate_of` is here despite being read exhaustively, because it is pairwise
 * too and its threshold is no protection on the material that matters: a static
 * camera running for three hours produces hundreds of near-identical events, and
 * 400 of them link to each other 80,000 times. Capping is safe for its one
 * consumer — `duplicateGroups` takes the transitive closure, and a cluster whose
 * every member links to its strongest few neighbours is still one cluster.
 *
 * `continuation` is not here. It is one link per adjacent pair, so it is already
 * linear, and dropping one would invent a discontinuity that is not there.
 */
const ASSOCIATIVE: ReadonlySet<RelationType> = new Set([
  'same_topic',
  'same_location',
  'same_person',
  'callback',
  'duplicate_of',
]);

export function buildEventGraph(
  events: readonly SemanticEvent[],
  options: GraphOptions = {},
): EventRelation[] {
  const settings = { ...DEFAULTS, ...options };
  const ordered = [...events].sort((a, b) => a.start_ms - b.start_ms);

  // Each event's matchable features, once.
  //
  // The comparison below is pairwise, so anything computed inside it is computed
  // a number of times that grows with the square of the events. Splitting a
  // description into features is not free — it normalises, then walks the string
  // deciding which runs are words and which are character bigrams — and it was
  // being done four times per pair. Hoisting it leaves set intersection in the
  // inner loop and nothing else.
  const features = new Map<string, Set<string>>();
  for (const event of ordered) {
    features.set(event.id, new Set(matchFeatures(distinctiveText(event))));
  }
  // Collected before they are numbered, because the associative ones are
  // thinned first and an id has to mean the same thing across two runs.
  const draft: Omit<EventRelation, 'id'>[] = [];

  const add = (
    source: string,
    target: string,
    type: RelationType,
    strength: number,
    provenance: EventRelation['provenance'] = 'inferred',
    note?: string,
  ): void => {
    if (strength <= 0) return;
    draft.push({
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
      const similarity =
        settings.similarity?.(a.id, b.id) ??
        featureSimilarity(features.get(a.id), features.get(b.id));

      if (similarity >= settings.duplicateThreshold) {
        add(
          a.id,
          b.id,
          'duplicate_of',
          similarity,
          'inferred',
          'these look like two takes of the same thing',
        );
      } else if (similarity >= settings.topicThreshold) {
        add(a.id, b.id, 'same_topic', similarity);
      }

      const sharedPlace = shared(a.entities.value.places, b.entities.value.places);
      if (sharedPlace.length > 0) add(a.id, b.id, 'same_location', 0.6 + 0.1 * sharedPlace.length);

      const sharedPeople = shared(a.entities.value.people, b.entities.value.people);
      if (sharedPeople.length > 0) add(a.id, b.id, 'same_person', 0.5 + 0.15 * sharedPeople.length);

      // A callback: the same subject returning much later, which is worth
      // knowing because dropping the first one strands the second.
      if (
        j - i > 8 &&
        j - i <= settings.maxCallbackDistance &&
        similarity >= settings.topicThreshold
      ) {
        add(a.id, b.id, 'callback', similarity * 0.8);
      }
    }
  }

  return keepStrongest(draft, settings.maxPerEventPerKind).map((relation, index) => ({
    id: seqId('rel', index + 1, 5),
    ...relation,
  }));
}

/**
 * Thins the associative links to each event's strongest few.
 *
 * An edge survives if either of its two events wants it, so a link that matters
 * a great deal to one event is not lost because the other has better ones. The
 * original order is preserved rather than the ranking order, so that the graph
 * still reads chronologically and two runs over the same events produce the same
 * ids.
 */
function keepStrongest(
  draft: readonly Omit<EventRelation, 'id'>[],
  limit: number,
): Omit<EventRelation, 'id'>[] {
  if (!Number.isFinite(limit) || limit <= 0) return [...draft];

  const ranked = new Map<string, number[]>();
  const rankKey = (eventId: string, type: RelationType): string => `${eventId}\u0000${type}`;

  for (const [index, relation] of draft.entries()) {
    if (!ASSOCIATIVE.has(relation.relation_type)) continue;
    for (const eventId of [relation.source_event_id, relation.target_event_id]) {
      const key = rankKey(eventId, relation.relation_type);
      const bucket = ranked.get(key);
      if (bucket) bucket.push(index);
      else ranked.set(key, [index]);
    }
  }

  const wanted = new Set<number>();
  for (const bucket of ranked.values()) {
    bucket
      .sort((a, b) => {
        const first = draft[a]!;
        const second = draft[b]!;
        return (
          second.strength - first.strength ||
          first.source_event_id.localeCompare(second.source_event_id) ||
          first.target_event_id.localeCompare(second.target_event_id)
        );
      })
      .slice(0, limit)
      .forEach((index) => wanted.add(index));
  }

  return draft.filter(
    (relation, index) => !ASSOCIATIVE.has(relation.relation_type) || wanted.has(index),
  );
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
    parent.set(
      relation.source_event_id,
      parent.get(relation.source_event_id) ?? relation.source_event_id,
    );
    parent.set(
      relation.target_event_id,
      parent.get(relation.target_event_id) ?? relation.target_event_id,
    );
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
/**
 * How much two events have in common, from their precomputed features.
 *
 * The same number `Math.max(coverage(a, b), coverage(b, a))` produced, which is
 * the shared features over the smaller of the two sets: two events are alike
 * when one is largely contained in the other, whichever way round that is.
 */
export function featureSimilarity(
  a: ReadonlySet<string> | undefined,
  b: ReadonlySet<string> | undefined,
): number {
  if (!a?.size || !b?.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const feature of small) if (large.has(feature)) shared++;
  return shared / small.size;
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
