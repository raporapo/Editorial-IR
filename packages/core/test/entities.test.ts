import { describe, expect, it } from 'vitest';
import { ProjectContext } from '@editorial-ir/contracts';
import { linkKnownEntities, mentions, withKnownEntities } from '../src/entities.js';

/**
 * Linking what the user named to where it appears.
 *
 * `context.yaml` is documented as the authority on who is in the footage and
 * where it was shot. Until this existed it was neither: every event in the
 * worked example had no people and no places, while the transcript said
 * 今日はUSJだね and the context declared USJ with two aliases that nothing read.
 */
const context = ProjectContext.parse({
  project_id: 'prj_1',
  updated_at: '2026-05-17T09:00:00.000Z',
  background: {
    people: [
      { id: 'me', role: '自分', aliases: ['two_people'] },
      { id: 'partner', role: '彼女', aliases: ['two_people', '彼女'] },
    ],
    places: [
      {
        id: 'USJ',
        display_name: 'ユニバーサル・スタジオ・ジャパン',
        aliases: ['ユニバ', 'universal studios japan'],
      },
      { id: '展望台', display_name: '梅田スカイビル空中庭園', aliases: ['observation_deck'] },
    ],
  },
});

const nothing = { speech: [], ocr: [], visual_labels: [] };

describe('mentions', () => {
  it('finds a latin name inside a Japanese sentence', () => {
    // The boundary is "not another latin letter", not whitespace. 今日はUSJだね
    // has no space anywhere near USJ, and requiring one meant the one event
    // whose transcript names the place was the one that did not match it.
    expect(mentions('usj', '今日はusjだね 楽しみすぎる')).toBe(true);
  });

  it('does not find a short latin name inside a longer word', () => {
    expect(mentions('me', 'come here')).toBe(false);
    expect(mentions('me', 'ame')).toBe(false);
    expect(mentions('me', 'look at me')).toBe(true);
  });

  it('finds a Japanese name as a substring, because there is no boundary to use', () => {
    expect(mentions('ユニバ', 'ユニバーサルシティ駅')).toBe(true);
  });

  it('finds a multi-word latin name', () => {
    expect(mentions('universal studios japan', '[universal studios japan]')).toBe(true);
  });

  it('is false for an empty form', () => {
    expect(mentions('', 'anything')).toBe(false);
  });
});

describe('linkKnownEntities', () => {
  it('links a place the transcript names', () => {
    const linked = linkKnownEntities({ ...nothing, speech: ['今日はUSJだね'] }, context);
    expect(linked.places).toEqual(['USJ']);
  });

  it('links through an alias, which is what aliases are for', () => {
    // The sign in shot says ユニバーサルシティ駅; nobody says USJ.
    const linked = linkKnownEntities({ ...nothing, ocr: ['ユニバーサルシティ駅'] }, context);
    expect(linked.places).toEqual(['USJ']);
  });

  it('links through a visual label, because a place is often only visible', () => {
    const linked = linkKnownEntities(
      { ...nothing, visual_labels: ['observation_deck', 'night_view'] },
      context,
    );
    expect(linked.places).toEqual(['展望台']);
  });

  it('returns the canonical id, never the form that matched', () => {
    // Everything downstream has to see one name for one thing, or a skill rule
    // matching on a place works on some events and not others.
    const bySign = linkKnownEntities({ ...nothing, ocr: ['UNIVERSAL STUDIOS JAPAN'] }, context);
    const bySpeech = linkKnownEntities({ ...nothing, speech: ['USJ行こう'] }, context);
    expect(bySign.places).toEqual(bySpeech.places);
  });

  it('links a person by a label that means they are in shot', () => {
    const linked = linkKnownEntities({ ...nothing, visual_labels: ['two_people'] }, context);
    expect(linked.people.sort()).toEqual(['me', 'partner']);
  });

  it('finds nothing in an event that names nothing', () => {
    const linked = linkKnownEntities({ ...nothing, visual_labels: ['street', 'walking'] }, context);
    expect(linked).toEqual({ people: [], places: [] });
  });

  it('finds nothing when there is no text at all', () => {
    expect(linkKnownEntities(nothing, context)).toEqual({ people: [], places: [] });
  });

  it('ignores a one-character name, which would match everything', () => {
    const risky = ProjectContext.parse({
      project_id: 'prj_1',
      updated_at: '2026-05-17T09:00:00.000Z',
      background: { places: [{ id: '山' }] },
    });
    expect(linkKnownEntities({ ...nothing, speech: ['山手線で行こう'] }, risky).places).toEqual([]);
  });
});

describe('withKnownEntities', () => {
  const found = {
    people: ['a woman'],
    places: ['a theme park'],
    objects: [],
    topics: [],
    organisations: [],
  };

  it('keeps what the model found as well', () => {
    // The model saw the footage and this did not; dropping its answer would be
    // throwing away the more informed of the two.
    const merged = withKnownEntities(found, { people: ['partner'], places: [] });
    expect(merged.people).toContain('a woman');
    expect(merged.people).toContain('partner');
  });

  it('puts the user’s ids first, because those are the ones a skill uses', () => {
    const merged = withKnownEntities(found, { people: ['partner'], places: ['USJ'] });
    expect(merged.people[0]).toBe('partner');
    expect(merged.places[0]).toBe('USJ');
  });

  it('does not repeat a name both sides found', () => {
    const merged = withKnownEntities(
      { ...found, people: ['partner'] },
      { people: ['partner'], places: [] },
    );
    expect(merged.people).toEqual(['partner']);
  });
});
