import {
  compareText,
  coverage,
  seqId,
  type Chapter,
  type MaterialProfile,
  type MediaAsset,
  type SemanticEvent,
} from '@editorial-ir/contracts';
import { captureStartsApartMs } from './ingest.js';
import { TITLE_CARD_MAX_MS } from './materials.js';
import { isTimecodeLike } from './onscreen-text.js';

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
  /**
   * A gap at least this long in real capture time starts a new chapter.
   *
   * Real time, from the files' own creation times, because the capture timeline
   * lays files end to end one second apart: the old two-minute rule measured
   * that second and could never fire. Half an hour sits between the two scales
   * it has to tell apart: the worked example's three recordings — morning,
   * midday, night — are three and seven hours apart, and the clips a phone
   * takes at each stop of one walk are minutes apart. Anything between is a
   * judgement, and this one errs toward fewer chapters, because a chapter per
   * clip is no chapter.
   */
  gapMs?: number;
  /** Fewest events a chapter may contain before it is folded into its neighbour. */
  minEvents?: number;
  /** Most chapters to produce. */
  maxChapters?: number;
}

/** What chapters need to know about the files the events came from. */
export interface ChapterKnowledge {
  assets?: readonly MediaAsset[];
  materials?: readonly Pick<MaterialProfile, 'asset_id' | 'kind'>[];
}

const DEFAULTS: Required<ChapterOptions> = {
  gapMs: 30 * 60_000,
  minEvents: 2,
  maxChapters: 12,
};

interface Settings extends Required<ChapterOptions> {
  assets: ReadonlyMap<string, MediaAsset>;
  kinds: ReadonlyMap<string, string>;
}

export function buildChapters(
  events: readonly SemanticEvent[],
  options: ChapterOptions = {},
  knowledge: ChapterKnowledge = {},
): { chapters: Chapter[]; assignments: Map<string, string> } {
  const settings: Settings = {
    ...DEFAULTS,
    ...options,
    assets: new Map((knowledge.assets ?? []).map((asset) => [asset.id, asset])),
    kinds: new Map((knowledge.materials ?? []).map((profile) => [profile.asset_id, profile.kind])),
  };
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
  groups = limitGroups(groups, settings);

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
  settings: Settings,
): boolean {
  // A title card is the programme saying where its next part begins.
  if (isTitleCard(event)) return true;

  const previousAsset = previous.source_ranges[0]?.asset_id;
  const eventAsset = event.source_ranges[0]?.asset_id;
  if (previousAsset !== eventAsset) {
    // Where both files say when they were shot, the time between them decides,
    // and a new file alone does not: every clip in a folder is a new file, and
    // making each one a chapter made one-event groups that the fold below then
    // collapsed into a single chapter for the whole folder.
    const gap = captureGapMs(previousAsset, eventAsset, settings);
    if (gap !== undefined) {
      if (gap >= settings.gapMs) return true;
    } else if (!(isShortPiece(previousAsset, settings) && isShortPiece(eventAsset, settings))) {
      // With no times, a different recording is almost always a different
      // moment of the day — except between clips and stills, which are pieces
      // of one outing that the rules below can still divide.
      return true;
    }
  }

  const previousPlaces = new Set(previous.entities.value.places);
  const places = event.entities.value.places;
  if (places.length > 0 && previousPlaces.size > 0 && places.every((p) => !previousPlaces.has(p))) {
    return true;
  }

  // A change of subject, measured the same way everything else measures text.
  const shared = coverage(previous.description.value, event.description.value);
  return shared < 0.1 && previous.event_type.value !== event.event_type.value;
}

function isTitleCard(event: SemanticEvent | undefined): boolean {
  return event?.segmentation.method === 'title_card';
}

function isShortPiece(assetId: string | undefined, settings: Settings): boolean {
  const kind = assetId === undefined ? undefined : settings.kinds.get(assetId);
  return kind === 'clip' || kind === 'still';
}

/**
 * Real time between the end of one file and the start of the next, when both
 * files say when they were shot on a clock they share — a camera's zone-less
 * time is compared with another's, never with a UTC instant. A photograph ends
 * when it starts.
 */
function captureGapMs(
  fromId: string | undefined,
  toId: string | undefined,
  settings: Settings,
): number | undefined {
  const from = fromId === undefined ? undefined : settings.assets.get(fromId);
  const to = toId === undefined ? undefined : settings.assets.get(toId);
  if (!from || !to) return undefined;
  const apart = captureStartsApartMs(from, to);
  return apart === undefined ? undefined : apart - from.duration_ms;
}

/** How far apart two neighbouring events are, in real time where it is known. */
function gapBetween(previous: SemanticEvent, next: SemanticEvent, settings: Settings): number {
  const previousAsset = previous.source_ranges[0]?.asset_id;
  const nextAsset = next.source_ranges[0]?.asset_id;
  if (previousAsset !== nextAsset) {
    const real = captureGapMs(previousAsset, nextAsset, settings);
    if (real !== undefined) return real;
  }
  return next.start_ms - previous.end_ms;
}

/**
 * A chapter of one event is a heading, not a chapter.
 *
 * It joins the chapter before it — unless it opens on a title card, which heads
 * what follows: folded backwards, a card became the last event of the chapter
 * before and gave that chapter its name. A section the programme itself marked
 * stays a chapter however short, and a card that is nothing but a card — its
 * content split off by the user — takes the group after it.
 */
function foldSmallGroups(groups: SemanticEvent[][], minEvents: number): SemanticEvent[][] {
  if (groups.length <= 1) return groups;
  const folded: SemanticEvent[][] = [];
  for (const group of groups) {
    const previous = folded.at(-1);
    if (previous && isLoneCard(previous)) {
      previous.push(...group);
      continue;
    }
    if (group.length < minEvents && previous && !isTitleCard(group[0])) previous.push(...group);
    else folded.push([...group]);
  }
  // A short first group has no predecessor to join, so it joins what follows.
  if (folded.length > 1 && folded[0]!.length < minEvents && !isTitleCard(folded[0]![0])) {
    const [first, ...rest] = folded;
    rest[0]!.unshift(...first!);
    return rest;
  }
  return folded;
}

/** A group that is one title card and nothing it introduces. */
function isLoneCard(group: readonly SemanticEvent[]): boolean {
  const only = group.length === 1 ? group[0] : undefined;
  return isTitleCard(only) && only!.end_ms - only!.start_ms <= TITLE_CARD_MAX_MS;
}

/**
 * Merges at the weakest remaining boundary until the cap is met.
 *
 * Weakest is the shortest gap, in real time where it is known. Inside one
 * recording every gap is zero, and the first of them used to win every time, so
 * one long recording with twenty changes of subject came out as chapters of
 * [18, 2, 2, ...]: the first chapter swallowed the rest one by one. Of equal
 * gaps the pair with the fewest events is joined, which keeps chapters even. A
 * boundary at a title card is joined only when nothing else is left to join.
 */
function limitGroups(groups: SemanticEvent[][], settings: Settings): SemanticEvent[][] {
  let result = groups;
  while (result.length > settings.maxChapters) {
    let weakest = -1;
    for (const allowCards of [false, true]) {
      let weakestGap = Infinity;
      let weakestSize = Infinity;
      for (let i = 1; i < result.length; i++) {
        if (!allowCards && isTitleCard(result[i]![0])) continue;
        const gap = gapBetween(result[i - 1]!.at(-1)!, result[i]![0]!, settings);
        const size = result[i - 1]!.length + result[i]!.length;
        if (gap < weakestGap || (gap === weakestGap && size < weakestSize)) {
          weakestGap = gap;
          weakestSize = size;
          weakest = i;
        }
      }
      if (weakest > 0) break;
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
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))[0];
  return best?.[0];
}

/**
 * Names a chapter after whatever is most distinctive in it.
 *
 * In order: the title card it opens on, a place, then text that was on screen,
 * then the thing seen most often across its events, then the dominant event
 * type. The order is a ranking by how much a person would recognise: the name
 * the programme gave its own part beats anything inferred, "USJ" beats
 * "theme_park_gate", which beats "meal", which beats the first line of dialogue.
 */
function titleFor(group: readonly SemanticEvent[], place: string | undefined): string {
  // Scene text only — subtitles are kept apart from it — and never a counter
  // or a timecode burned into the picture, which named a folder of clips
  // `90010:00:60` and a camera test `00:00:10.008`.
  const readable = (event: SemanticEvent): string[] =>
    event.observed.ocr.filter((text) => text.length >= 3 && !isTimecodeLike(text));

  const card = isTitleCard(group[0]) ? readable(group[0]!)[0] : undefined;
  if (card) return card.slice(0, 40);

  if (place) return place;

  const onScreen = group.flatMap(readable);
  if (onScreen.length > 0) return onScreen[0]!.slice(0, 40);

  const labels = mostCommon(group.flatMap((event) => event.observed.visual_labels));
  if (labels) return labels.replace(/_/g, ' ');

  const types = mostCommon(
    group
      .map((event) => event.event_type.value)
      .filter((type) => type !== 'moment' && type !== 'b_roll'),
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
    .sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))[0];
  return best?.[0];
}
