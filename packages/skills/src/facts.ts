import {
  NEUTRAL_FLAGS,
  NEUTRAL_METRICS,
  assessmentFor,
  eventsInOrder,
  normalizeText,
  type EditorialFlag,
  type EditorialIR,
  type EditorialMetric,
  type NarrativeRole,
  type SemanticEvent,
} from '@editorial-ir/contracts';

/**
 * Everything a Skill rule is allowed to look at, computed once per event.
 *
 * Rules test facts rather than reaching into the IR themselves. That keeps the
 * surface a Skill can depend on small and documented, so changing how an event
 * is represented does not quietly change what every published Skill means.
 */
export interface EventFacts {
  event_id: string;
  metrics: Record<EditorialMetric, number>;
  flags: Record<EditorialFlag, number>;
  narrative_role: NarrativeRole;
  event_type: string;
  affect: Record<string, number>;

  duration_ms: number;
  speech_ratio: number;
  silence_ratio: number;
  shot_count: number;
  motion: number;
  /** Share of the event that was still and silent; 0 when none was, or none was measured. */
  inactive_ratio: number;
  /**
   * The kind of material the event comes from, when it was classified:
   * `raw`, `edited`, `clip`, `screen_recording`, `audio_only` or `still`.
   */
  material?: string;
  /** True when the picture carries burned-in subtitles. */
  has_subtitles: boolean;

  /** True when this event's place differs from the previous event's. */
  new_location: boolean;
  /** True when someone appears who was not in the previous event. */
  new_person: boolean;
  has_speech: boolean;
  has_music: boolean;
  has_laughter: boolean;
  has_text_on_screen: boolean;

  is_user_essential: boolean;
  is_user_excluded: boolean;

  chapter_position: 'first' | 'middle' | 'last';
  project_position: 'first' | 'middle' | 'last';

  /** Description, speech and on-screen text, for `mentions`. */
  text: string;
  people: string[];
  places: string[];
}

/** Derives the facts for every event in an IR, in capture order. */
export function deriveFacts(ir: EditorialIR): Map<string, EventFacts> {
  const ordered = eventsInOrder(ir);
  const facts = new Map<string, EventFacts>();

  const materialOf = new Map(ir.materials.map((m) => [m.asset_id, m.kind]));

  const chapterMembers = new Map<string, string[]>();
  for (const event of ordered) {
    const key = event.chapter_id ?? '__none__';
    const list = chapterMembers.get(key) ?? [];
    list.push(event.id);
    chapterMembers.set(key, list);
  }

  for (let i = 0; i < ordered.length; i++) {
    const event = ordered[i];
    if (!event) continue;
    const previous = i > 0 ? ordered[i - 1] : undefined;
    const assessment = assessmentFor(ir, event.id);

    const chapterKey = event.chapter_id ?? '__none__';
    const siblings = chapterMembers.get(chapterKey) ?? [event.id];

    facts.set(event.id, {
      event_id: event.id,
      metrics: assessment ? { ...NEUTRAL_METRICS, ...assessment.metrics } : { ...NEUTRAL_METRICS },
      flags: assessment ? { ...NEUTRAL_FLAGS, ...assessment.flags } : { ...NEUTRAL_FLAGS },
      narrative_role: assessment?.narrative_role.selected ?? 'context',
      event_type: event.event_type.value,
      affect: event.affect.value,

      duration_ms: event.end_ms - event.start_ms,
      speech_ratio: event.observed.speech_ratio,
      silence_ratio: event.observed.silence_ratio,
      shot_count: event.observed.shot_count,
      motion: event.observed.motion ?? 0,
      // Absent means none: the analysis leaves the field out when nothing in the
      // event was still and silent, and a rule written "< 0.2" must match that.
      inactive_ratio: event.observed.inactive_ratio ?? 0,
      ...materialFact(event, materialOf),
      has_subtitles: (event.observed.subtitles?.length ?? 0) > 0,

      new_location: isNewLocation(event, previous),
      new_person: isNewPerson(event, previous),
      has_speech: event.observed.speech.length > 0,
      has_music: event.observed.audio.some((a) => a.type === 'music'),
      has_laughter: event.observed.audio.some((a) => a.type === 'laughter'),
      has_text_on_screen: event.observed.ocr.length > 0,

      is_user_essential: event.knowledge.essential,
      is_user_excluded: event.knowledge.excluded,

      chapter_position: positionIn(siblings, event.id),
      project_position: positionIn(
        ordered.map((e) => e.id),
        event.id,
      ),

      text: searchText(event),
      people: event.entities.value.people,
      places: event.entities.value.places,
    });
  }

  return facts;
}

/** The kind of the material an event is cut from, when that asset was classified. */
function materialFact(
  event: SemanticEvent,
  materialOf: ReadonlyMap<string, string>,
): { material?: string } {
  const assetId = event.source_ranges[0]?.asset_id;
  const kind = assetId === undefined ? undefined : materialOf.get(assetId);
  return kind === undefined ? {} : { material: kind };
}

function isNewLocation(event: SemanticEvent, previous: SemanticEvent | undefined): boolean {
  const places = event.entities.value.places;
  if (places.length === 0) return false;
  // With nothing before it, arriving somewhere is by definition arriving
  // somewhere new.
  if (!previous) return true;
  const before = new Set(previous.entities.value.places);
  return places.some((place) => !before.has(place));
}

function isNewPerson(event: SemanticEvent, previous: SemanticEvent | undefined): boolean {
  const people = event.entities.value.people;
  if (people.length === 0) return false;
  if (!previous) return true;
  const before = new Set(previous.entities.value.people);
  return people.some((person) => !before.has(person));
}

function positionIn(ids: string[], id: string): 'first' | 'middle' | 'last' {
  if (ids.length <= 1) return 'first';
  if (ids[0] === id) return 'first';
  if (ids[ids.length - 1] === id) return 'last';
  return 'middle';
}

function searchText(event: SemanticEvent): string {
  return normalizeText(
    [
      event.description.value,
      event.title?.value ?? '',
      ...event.observed.speech.map((s) => s.text),
      ...event.observed.ocr,
      ...event.entities.value.topics,
    ].join(' '),
  );
}
