import {
  coverage,
  seqId,
  type Chapter,
  type SemanticEvent,
} from '@editorial-ir/contracts';

/**
 * Grouping events into chapters.
 *
 * Chapters exist so the agent can budget time coarsely before it looks at
 * individual events: "a quarter of the running time for the morning" is a
 * decision a person can review, and "7.2 seconds for event 31" is not.
 *
 * The boundaries are where the day changed: a new place, a new recording, a gap
 * long enough that something happened in between, or a shift in what is being
 * talked about.
 */
export interface ChapterOptions {
  /** A gap at least this long on the capture timeline starts a new chapter. */
  gapMs?: number;
  /** Fewest events a chapter may contain before it is folded into its neighbour. */
  minEvents?: number;
  /** Most chapters to produce. */
  maxChapters?: number;
}

const DEFAULTS: Required<ChapterOptions> = {
  gapMs: 120_000,
  minEvents: 2,
  maxChapters: 12,
};

export function buildChapters(
  events: readonly SemanticEvent[],
  options: ChapterOptions = {},
): { chapters: Chapter[]; assignments: Map<string, string> } {
  const settings = { ...DEFAULTS, ...options };
  const ordered = [...events].sort((a, b) => a.start_ms - b.start_ms);
  if (ordered.length === 0) return { chapters: [], assignments: new Map() };

  let groups: SemanticEvent[][] = [];
  let current: SemanticEvent[] = [];

  for (const [index, event] of ordered.entries()) {
    const previous = index > 0 ? ordered[index - 1] : undefined;
    if (previous && startsNewChapter(previous, event, settings)) {
      groups.push(current);
      current = [];
    }
    current.push(event);
  }
  if (current.length > 0) groups.push(current);

  groups = foldSmallGroups(groups, settings.minEvents);
  groups = limitGroups(groups, settings.maxChapters);

  const assignments = new Map<string, string>();
  const chapters = groups.map((group, index) => {
    const id = seqId('chp', index + 1, 3);
    for (const event of group) assignments.set(event.id, id);
    const place = dominantPlace(group);
    return {
      id,
      start_ms: group[0]!.start_ms,
      end_ms: group.at(-1)!.end_ms,
      title: { value: titleFor(group, place), provenance: 'inferred' as const, confidence: 0.4 },
      summary: {
        value: group
          .slice(0, 3)
          .map((e) => e.description.value)
          .join(' / '),
        provenance: 'inferred' as const,
        confidence: 0.3,
      },
      event_ids: group.map((e) => e.id),
      ...(place ? { place } : {}),
      provenance: 'inferred' as const,
    };
  });

  return { chapters, assignments };
}

function startsNewChapter(
  previous: SemanticEvent,
  event: SemanticEvent,
  settings: Required<ChapterOptions>,
): boolean {
  // A different recording is almost always a different moment of the day.
  const previousAsset = previous.source_ranges[0]?.asset_id;
  const eventAsset = event.source_ranges[0]?.asset_id;
  if (previousAsset !== eventAsset) return true;

  if (event.start_ms - previous.end_ms >= settings.gapMs) return true;

  const previousPlaces = new Set(previous.entities.value.places);
  const places = event.entities.value.places;
  if (places.length > 0 && previousPlaces.size > 0 && places.every((p) => !previousPlaces.has(p))) {
    return true;
  }

  // A change of subject, measured the same way everything else measures text.
  const shared = coverage(previous.description.value, event.description.value);
  return shared < 0.1 && previous.event_type.value !== event.event_type.value;
}

/** A chapter of one event is a heading, not a chapter. */
function foldSmallGroups(groups: SemanticEvent[][], minEvents: number): SemanticEvent[][] {
  if (groups.length <= 1) return groups;
  const folded: SemanticEvent[][] = [];
  for (const group of groups) {
    const previous = folded.at(-1);
    if (group.length < minEvents && previous) previous.push(...group);
    else folded.push([...group]);
  }
  // A short first group has no predecessor to join, so it joins what follows.
  if (folded.length > 1 && folded[0]!.length < minEvents) {
    const [first, ...rest] = folded;
    rest[0]!.unshift(...first!);
    return rest;
  }
  return folded;
}

/** Merges at the weakest remaining boundary until the cap is met. */
function limitGroups(groups: SemanticEvent[][], maxChapters: number): SemanticEvent[][] {
  let result = groups;
  while (result.length > maxChapters) {
    let weakest = 0;
    let weakestGap = Infinity;
    for (let i = 1; i < result.length; i++) {
      const gap = result[i]![0]!.start_ms - result[i - 1]!.at(-1)!.end_ms;
      if (gap < weakestGap) {
        weakestGap = gap;
        weakest = i;
      }
    }
    result = [
      ...result.slice(0, weakest - 1),
      [...result[weakest - 1]!, ...result[weakest]!],
      ...result.slice(weakest + 1),
    ];
  }
  return result;
}

function dominantPlace(group: readonly SemanticEvent[]): string | undefined {
  const counts = new Map<string, number>();
  for (const event of group) {
    for (const place of event.entities.value.places) {
      counts.set(place, (counts.get(place) ?? 0) + 1);
    }
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return best?.[0];
}

/**
 * Names a chapter after whatever is most distinctive in it.
 *
 * In order: a place, then text that was on screen, then the thing seen most
 * often across its events, then the dominant event type. The order is a ranking
 * by how much a person would recognise: "USJ" beats "theme_park_gate", which
 * beats "meal", which beats the first line of dialogue.
 */
function titleFor(group: readonly SemanticEvent[], place: string | undefined): string {
  if (place) return place;

  const onScreen = group.flatMap((event) => event.observed.ocr).filter((text) => text.length >= 3);
  if (onScreen.length > 0) return onScreen[0]!.slice(0, 40);

  const labels = mostCommon(group.flatMap((event) => event.observed.visual_labels));
  if (labels) return labels.replace(/_/g, ' ');

  const types = mostCommon(
    group.map((event) => event.event_type.value).filter((type) => type !== 'moment' && type !== 'b_roll'),
  );
  if (types) return types;

  return group[0]?.title?.value ?? group[0]?.description.value.slice(0, 40) ?? 'chapter';
}

/** The value seen most often, ties broken by name so runs agree. */
function mostCommon(values: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const best = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return best?.[0];
}
