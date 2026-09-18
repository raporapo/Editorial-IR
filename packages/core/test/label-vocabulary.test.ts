import { describe, expect, it } from 'vitest';
import type { ProjectContext } from '@editorial-ir/contracts';
import {
  GENERAL_SCENE_VOCABULARY,
  MAX_VOCABULARY,
  labelVocabulary,
  vocabularyFor,
} from '../src/label-vocabulary.js';

/**
 * What a zero-shot vision model is offered as candidate labels.
 *
 * The parameter this feeds has existed since the contract was written and the
 * compiler passed `[]` to it every time, so the labelling path, the z-score
 * calibration behind it and `visual_labels` on every frame were all unreachable.
 * These tests are mostly about the two ways of fixing that badly: inventing a
 * taxonomy the user never asked for, and offering a model words it cannot read.
 */

function context(background: Partial<ProjectContext['background']> = {}): ProjectContext {
  return {
    project_id: 'proj_test',
    background: { people: [], places: [], vocabulary: [], notes: [], ...background },
    editing_goal: { tone: [], opening: [], middle: [], ending: [] },
    constraints: {
      forbidden: [],
      required_assets: [],
      excluded_assets: [],
      allow_speed_change: false,
      allowed_music: [],
      forbidden_music: [],
    },
    updated_at: '2026-01-01T00:00:00Z',
  };
}

describe('labelVocabulary', () => {
  it('offers the general scene words when the user has written nothing', () => {
    expect(labelVocabulary(undefined)).toEqual([...GENERAL_SCENE_VOCABULARY]);
  });

  it("puts the user's own domain words first", () => {
    // They are the part that is about this footage; the generic half is filler.
    const vocabulary = labelVocabulary(context({ vocabulary: ['a ramen shop counter'] }), {
      queryLanguage: 'en',
    });
    expect(vocabulary[0]).toBe('a ramen shop counter');
  });

  it('includes declared places and their aliases', () => {
    const vocabulary = labelVocabulary(
      context({
        places: [
          { id: 'p1', display_name: 'Dotonbori', aliases: ['the canal street'] },
          { id: 'p2', aliases: [] },
        ],
      }),
      { queryLanguage: 'en' },
    );
    expect(vocabulary).toContain('Dotonbori');
    expect(vocabulary).toContain('the canal street');
  });

  it('never offers a person as a candidate label', () => {
    // A zero-shot image model cannot recognise an individual. Offered a name it
    // returns it for any frame with a person in it, and that fabricated label
    // lands in the IR beside things that were actually observed.
    const vocabulary = labelVocabulary(
      context({
        people: [{ id: 'yuki', display_name: 'Yuki', aliases: ['ゆき'] }],
      }),
      { queryLanguage: 'en' },
    );
    expect(vocabulary).not.toContain('Yuki');
    expect(vocabulary.join(' ')).not.toContain('Yuki');
  });

  it('drops words an English-only text tower cannot read', () => {
    // Not hiding the limitation: 道頓堀 against CLIP's tower scores at noise
    // level, and the z-test either discards it or accepts it because something
    // else scored lower. Both outcomes are worse than not asking.
    const vocabulary = labelVocabulary(context({ vocabulary: ['道頓堀', 'a canal at night'] }), {
      queryLanguage: 'en',
    });
    expect(vocabulary).not.toContain('道頓堀');
    expect(vocabulary).toContain('a canal at night');
  });

  it('keeps them for a multilingual tower', () => {
    const vocabulary = labelVocabulary(context({ vocabulary: ['道頓堀'] }), {
      queryLanguage: 'multi',
    });
    expect(vocabulary).toContain('道頓堀');
  });

  it('is capped, because the list length is part of the threshold', () => {
    // Labels are chosen by how far a score stands out from the other candidates
    // for that frame, so a long list flattens the distribution rather than
    // adding recall.
    const many = Array.from({ length: 200 }, (_, i) => `a distinctive thing number ${i}`);
    expect(labelVocabulary(context({ vocabulary: many })).length).toBe(MAX_VOCABULARY);
  });

  it('deduplicates case-insensitively', () => {
    const vocabulary = labelVocabulary(
      context({ vocabulary: ['A City Street', 'a city street'] }),
      { queryLanguage: 'en' },
    );
    expect(vocabulary.filter((term) => term.toLowerCase() === 'a city street')).toHaveLength(1);
  });

  it('returns nothing rather than a single candidate', () => {
    // "The best of one" is not evidence, and the backend correctly refuses to
    // label from it — so sending one would cost a text-tower pass per batch for
    // a guaranteed empty answer.
    expect(labelVocabulary(context({ vocabulary: ['a canal'] }), { general: [] })).toEqual([]);
  });

  it('is deterministic, because it is part of the cache key', () => {
    const made = (): string[] =>
      labelVocabulary(context({ vocabulary: ['a canal', 'a bridge'] }), { queryLanguage: 'en' });
    expect(made()).toEqual(made());
  });
});

describe('vocabularyFor', () => {
  it('sends nothing to a model that cannot encode text', () => {
    // An export with no text tower embeds frames perfectly well. Asking it to
    // label them is an error it would have to raise once per batch.
    expect(vocabularyFor({ queryLanguage: undefined }, context())).toEqual([]);
  });

  it("uses the model's language, not the user's", () => {
    const vocabulary = vocabularyFor(
      { embedQuery: async () => [], queryLanguage: 'en' },
      context({ vocabulary: ['道頓堀', 'a canal at night'] }),
    );
    expect(vocabulary).toEqual(expect.arrayContaining(['a canal at night']));
    expect(vocabulary).not.toContain('道頓堀');
  });
});
