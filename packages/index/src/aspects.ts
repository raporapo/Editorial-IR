import {
  EMBEDDING_KINDS,
  type EmbeddingKind,
  type ProjectContext,
  type SemanticEvent,
} from '@editorial-ir/contracts';

/**
 * What text stands for each aspect of an event.
 *
 * One event does not fit in one vector. "the night view shot", "where they say
 * let's come back", "the arrival scene" and "the parts that feel like an
 * anniversary" are four different questions about the same eight seconds, and
 * squeezing them into a single average produces something that answers none of
 * them well.
 *
 * This mapping is used both to build the index and to search it. It has to be
 * one function, because an aspect indexed from one set of fields and searched
 * against another is a bug that shows up only as quietly poor results.
 */
export function aspectText(
  event: SemanticEvent,
  kind: EmbeddingKind,
  context?: ProjectContext,
): string {
  switch (kind) {
    case 'visual':
      return [
        ...event.observed.visual_labels,
        ...event.observed.ocr,
        ...event.entities.value.objects,
        ...event.entities.value.places,
      ].join(' ');

    case 'speech':
      return event.observed.speech.map((s) => s.text).join(' ');

    case 'event':
      return [event.title?.value ?? '', event.description.value, event.event_type.value].join(' ');

    case 'context':
      // The occasion belongs here and nowhere else: it is what makes "the parts
      // that feel like an anniversary" a question with an answer.
      return [
        event.description.value,
        ...event.entities.value.topics,
        ...event.entities.value.people,
        ...event.entities.value.places,
        ...event.knowledge.notes,
        event.knowledge.occasion ?? context?.background.occasion ?? '',
      ].join(' ');

    case 'mood':
      return [...affectWords(event), event.description.value].join(' ');

    case 'audio':
      return event.observed.audio.map((a) => a.type).join(' ');

    default:
      return event.description.value;
  }
}

/**
 * Renders affect as words so that a mood query can match it.
 *
 * An intensity of 0.88 on `excitement` is repeated as a word three times rather
 * than once, which is how a numeric intensity survives into a text index at all.
 */
export function affectWords(event: SemanticEvent): string[] {
  const words: string[] = [];
  for (const [axis, intensity] of Object.entries(event.affect.value)) {
    const repeats = Math.max(1, Math.round(intensity * 3));
    for (let i = 0; i < repeats; i++) words.push(axis);
  }
  return words;
}

/** Aspects that have any text for this event, so empty vectors are never stored. */
export function populatedAspects(event: SemanticEvent, context?: ProjectContext): EmbeddingKind[] {
  return EMBEDDING_KINDS.filter((kind) => aspectText(event, kind, context).trim().length > 0);
}

/** Everything about an event that a free-text query could reasonably match. */
export function searchableText(event: SemanticEvent, context?: ProjectContext): string {
  return EMBEDDING_KINDS.map((kind) => aspectText(event, kind, context)).join(' ');
}
