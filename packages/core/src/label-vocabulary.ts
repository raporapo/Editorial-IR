import type { ProjectContext } from '@editorial-ir/contracts';
import type { VisualEmbeddingModel } from '@editorial-ir/perception';

/**
 * The candidate labels a zero-shot vision model is offered for each frame.
 *
 * ## Why this file exists
 *
 * `EmbedFramesParams.label_vocabulary` has been in the contract since it was
 * written, documented as "candidate labels for zero-shot tagging", and the
 * compiler passed `[]`. Every time. So `_zero_shot`, the z-score calibration
 * behind it — six frames, 20,000 synthetic rows, a threshold argued down to
 * 1.8 — and `visual_labels` on every frame feature were all unreachable in a
 * real run. `visual_labels` was an empty array in every IR this project has
 * ever produced, and the `visual` aspect of the index is built from it.
 *
 * ## Where the words come from, and where they must not
 *
 * From the user. `background.vocabulary` is already defined as "domain words
 * the transcriber and the context model should expect" and is already handed to
 * the speech model as its decoding prompt; place names are already declared with
 * their aliases. Those are the words this particular user's footage is actually
 * about, and using them is the project's own rule — user knowledge outranks
 * every model — rather than a taxonomy invented here and validated on nothing.
 *
 * **People are deliberately excluded.** A zero-shot image model cannot recognise
 * an individual; offered "Yuki" as a candidate it will happily return it for any
 * frame with a person in it, and that label goes into the IR beside observations
 * that were actually observed. Saying who is in a shot is `entities.people`'s
 * job, which the compiler fills from the transcript and from what the user said.
 * A face the model has never seen is not an observation.
 *
 * ## The generic half
 *
 * A handful of scene words carry the cases every project has — indoors or out,
 * day or night, food, a crowd, a sign — so that a project whose owner wrote no
 * vocabulary still gets something. Kept short on purpose: the labels are scored
 * against each other within a frame, so a long list does not add recall, it
 * flattens the distribution the z-score is measured against and makes every
 * label harder to earn.
 */

/**
 * Scene words that apply to any footage.
 *
 * Phrases rather than nouns because the text tower was trained on captions, and
 * the backend wraps each one in "a photo of {}." for the same reason.
 */
export const GENERAL_SCENE_VOCABULARY: readonly string[] = [
  'a city street',
  'a room indoors',
  'a landscape outdoors',
  'the sea or a river',
  'a meal or a plate of food',
  'a crowd of people',
  'one person talking to the camera',
  'a sign with writing on it',
  'a vehicle or a train',
  'a night scene with lights',
  'a shop or a market',
  'a hotel room',
];

/**
 * How many candidates to offer at once.
 *
 * Each frame's labels are chosen by how far a score stands out from the other
 * candidates *for that frame*, so the list length is part of the threshold. It
 * also costs a text-tower pass per distinct list, which the backend memoises.
 */
export const MAX_VOCABULARY = 40;

/** Scripts an English-only text tower cannot rank. See `looksEnglishEnough`. */
const NON_LATIN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Thai}\p{Script=Devanagari}]/u;

/**
 * Candidate labels for this project, or nothing when there is no point.
 *
 * `queryLanguage` is the model's, not the user's: CLIP's and SigLIP-base's text
 * towers are English-only, and offering them 道頓堀 as a candidate does not
 * produce a Japanese label — it produces a score at noise level that the z-test
 * then either discards or, worse, accepts because some other candidate scored
 * lower. Dropping a word the model cannot read is not a limitation being hidden;
 * it is the alternative to a fabricated observation.
 */
export function labelVocabulary(
  context: ProjectContext | undefined,
  options: { queryLanguage?: string; general?: readonly string[] } = {},
): string[] {
  const readable = (term: string): boolean =>
    options.queryLanguage === 'multi' || !NON_LATIN.test(term);

  const fromUser: string[] = [];
  const background = context?.background;
  if (background) {
    fromUser.push(...background.vocabulary);
    for (const place of background.places) {
      if (place.display_name) fromUser.push(place.display_name);
      fromUser.push(...place.aliases);
    }
  }

  const seen = new Set<string>();
  const vocabulary: string[] = [];
  // The user's words first, so that the cap falls on the generic half when both
  // are long. What the user wrote is the part that is about this footage.
  for (const term of [...fromUser, ...(options.general ?? GENERAL_SCENE_VOCABULARY)]) {
    const cleaned = term.trim();
    if (cleaned.length < 2 || !readable(cleaned)) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    vocabulary.push(cleaned);
    if (vocabulary.length >= MAX_VOCABULARY) break;
  }

  // One candidate is not a choice, and `labels_from_scores` correctly refuses to
  // treat "the best of one" as evidence. Sending it would cost a text-tower pass
  // per batch for a guaranteed empty answer.
  return vocabulary.length >= 2 ? vocabulary : [];
}

/**
 * The vocabulary to send to a particular model, or none if it cannot use one.
 *
 * A vision model with no text tower embeds frames and cannot label them; asking
 * it to is an error the worker would have to raise per batch.
 */
export function vocabularyFor(
  visual: Pick<VisualEmbeddingModel, 'embedQuery' | 'queryLanguage'>,
  context: ProjectContext | undefined,
): string[] {
  if (visual.embedQuery === undefined) return [];
  return labelVocabulary(context, {
    ...(visual.queryLanguage ? { queryLanguage: visual.queryLanguage } : {}),
  });
}
