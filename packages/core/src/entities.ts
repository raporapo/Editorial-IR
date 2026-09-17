import { normalizeText, type Entities, type ProjectContext } from '@editorial-ir/contracts';

/**
 * Linking what the user named to where it appears.
 *
 * `context.yaml` is where someone writes who is in their footage and where it
 * was shot, and it is documented as the authority on both. Until this existed it
 * was neither: the rule-based context model returned empty people and places
 * unconditionally, so every event in the worked example had none — while the
 * transcript said 今日はUSJだね and the context declared USJ with the aliases
 * ユニバ and universal studios japan, which nothing read.
 *
 * Doing this by matching rather than by asking a model is deliberate:
 *
 * - **It is the user's vocabulary that has to win.** A vision model asked who is
 *   in a shot answers "a woman in a red coat". That is not wrong and it is not
 *   usable: a skill that says "keep the moments with both of them" needs the ids
 *   the user chose, and so does the person reading the timeline.
 * - **It costs nothing and works offline**, so the free configuration is not the
 *   one where the single highest-value input does nothing.
 * - **It is deterministic**, so a skill rule matching on `partner` behaves the
 *   same on every run and on every backend.
 *
 * What a model finds is kept: matches are merged into the entities it produced
 * rather than replacing them.
 */

/** Everything an event says, in one haystack. */
export interface EntityHaystack {
  speech: readonly string[];
  ocr: readonly string[];
  visual_labels: readonly string[];
  description?: string;
}

/**
 * The names one declared entity could appear under.
 *
 * The id is included because people write `USJ` in the transcript and then use
 * `USJ` as the id; `display_name` and `aliases` are the same idea for the cases
 * where they do not.
 */
function surfaceFormsOf(entity: {
  id: string;
  display_name?: string | undefined;
  aliases?: readonly string[] | undefined;
}): string[] {
  return (
    [entity.id, entity.display_name ?? '', ...(entity.aliases ?? [])]
      .map((form) => normalizeText(form))
      // One character matches almost everything, and a name nobody wrote is not a
      // mention. Two is the shortest a real name gets — 山, 都 and the like are
      // parts of words far more often than they are names.
      .filter((form) => form.length >= 2)
  );
}

const LATIN_ONLY = /^[\p{Script=Latin}\p{N}\s]+$/u;

/**
 * Whether a surface form appears in some text.
 *
 * A latin name needs a boundary, because `me` is inside `come` and `ame`, and
 * `me` is the id the worked example actually uses. The boundary is "not another
 * latin letter or digit" rather than whitespace, which is not the same thing:
 * 「今日はUSJだね」 has no space anywhere near USJ, and requiring one meant the one
 * event whose transcript names the place was the one event that did not match it.
 *
 * A name in a spaceless script is matched as a substring, because there is no
 * boundary available and none is needed — a run of two or more kana or kanji
 * appearing inside a sentence is a mention of it.
 */
export function mentions(form: string, haystack: string): boolean {
  if (form.length === 0) return false;
  if (LATIN_ONLY.test(form)) {
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const edge = '[\\p{Script=Latin}\\p{N}]';
    return new RegExp(`(?<!${edge})${escaped}(?!${edge})`, 'u').test(haystack);
  }
  return haystack.includes(form);
}

/**
 * People and places the user declared, that this event mentions.
 *
 * Returns canonical ids, never the surface form that matched: the point is that
 * everything downstream sees one name for one thing.
 */
export function linkKnownEntities(
  haystack: EntityHaystack,
  context: ProjectContext,
): { people: string[]; places: string[] } {
  // Visual labels are included because "who is here" is answered by the picture
  // at least as often as by the words, and a place is frequently only visible.
  const text = normalizeText(
    [
      ...haystack.speech,
      ...haystack.ocr,
      ...haystack.visual_labels,
      haystack.description ?? '',
    ].join(' '),
  );
  if (text.length === 0) return { people: [], places: [] };

  const matched = <T extends { id: string }>(entities: readonly T[]): string[] =>
    entities
      .filter((entity) => surfaceFormsOf(entity).some((form) => mentions(form, text)))
      .map((entity) => entity.id);

  return {
    people: matched(context.background.people),
    places: matched(context.background.places),
  };
}

/**
 * Adds the links to what the model found, keeping both.
 *
 * A model's answer is not discarded: it saw the footage and this did not. The
 * user's ids go first because they are the ones a skill and a reader use.
 */
export function withKnownEntities(
  entities: Entities,
  linked: ReturnType<typeof linkKnownEntities>,
): Entities {
  return {
    ...entities,
    people: [...new Set([...linked.people, ...entities.people])],
    places: [...new Set([...linked.places, ...entities.places])],
  };
}
