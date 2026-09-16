import { describe, expect, it } from 'vitest';
import { evaluateCondition, parseNumericCondition, type EventFacts } from '../src/index.js';
import { NEUTRAL_FLAGS, NEUTRAL_METRICS } from '@editorial-ir/contracts';

function facts(overrides: Partial<EventFacts> = {}): EventFacts {
  return {
    event_id: 'evt_0001',
    metrics: { ...NEUTRAL_METRICS },
    flags: { ...NEUTRAL_FLAGS },
    narrative_role: 'context',
    event_type: 'moment',
    affect: {},
    duration_ms: 8000,
    speech_ratio: 0.5,
    silence_ratio: 0.1,
    shot_count: 2,
    motion: 0.2,
    new_location: false,
    new_person: false,
    has_speech: true,
    has_music: false,
    has_laughter: false,
    has_text_on_screen: false,
    is_user_essential: false,
    is_user_excluded: false,
    chapter_position: 'middle',
    project_position: 'middle',
    text: 'usjの入口に到着した universal studios',
    people: ['me', 'partner'],
    places: ['USJ'],
    ...overrides,
  };
}

describe('the comparator language', () => {
  it('reads the forms an editor would write', () => {
    expect(parseNumericCondition('>0.7').test(0.8)).toBe(true);
    expect(parseNumericCondition('>0.7').test(0.7)).toBe(false);
    expect(parseNumericCondition('>=0.7').test(0.7)).toBe(true);
    expect(parseNumericCondition('<0.2').test(0.1)).toBe(true);
    expect(parseNumericCondition('<=0.2').test(0.2)).toBe(true);
    expect(parseNumericCondition('==0.5').test(0.5)).toBe(true);
    expect(parseNumericCondition('!=0.5').test(0.5)).toBe(false);
    expect(parseNumericCondition('0.3..0.7').test(0.5)).toBe(true);
    expect(parseNumericCondition('0.3..0.7').test(0.8)).toBe(false);
    expect(parseNumericCondition(0.5).test(0.5)).toBe(true);
  });

  it('tolerates whitespace, because people write it', () => {
    expect(parseNumericCondition('  >  0.7 ').test(0.8)).toBe(true);
    expect(parseNumericCondition(' 0.3 .. 0.7 ').test(0.5)).toBe(true);
  });

  it('accepts the object form for machine-generated rules', () => {
    expect(parseNumericCondition({ gt: 0.5, lte: 0.9 }).test(0.7)).toBe(true);
    expect(parseNumericCondition({ gt: 0.5, lte: 0.9 }).test(0.95)).toBe(false);
  });

  it('refuses something that is not a comparison, with a usable message', () => {
    expect(() => parseNumericCondition('high')).toThrow(/not a comparison/);
    expect(() => parseNumericCondition('0.7..0.3')).toThrow(/starts above/);
    expect(() => parseNumericCondition({})).toThrow(/no comparison/);
  });

  it('compares floating point without tripping on representation', () => {
    expect(parseNumericCondition('==0.3').test(0.1 + 0.2)).toBe(true);
  });
});

describe('evaluateCondition', () => {
  it('ANDs every field', () => {
    expect(evaluateCondition({ has_speech: true, speech_ratio: '>0.4' }, facts())).toBe(true);
    expect(evaluateCondition({ has_speech: true, speech_ratio: '>0.9' }, facts())).toBe(false);
  });

  it('matches an editorial metric by name', () => {
    expect(evaluateCondition({ story_importance: '>0.4' }, facts())).toBe(true);
    expect(
      evaluateCondition({ story_importance: '>0.9' }, facts({ metrics: { ...NEUTRAL_METRICS, story_importance: 0.95 } })),
    ).toBe(true);
  });

  it('matches an editorial flag through its probability suffix', () => {
    const withFlag = facts({ flags: { ...NEUTRAL_FLAGS, establishing_shot: 0.85 } });
    expect(evaluateCondition({ establishing_shot_probability: '>0.7' }, withFlag)).toBe(true);
    expect(evaluateCondition({ establishing_shot_probability: '>0.9' }, withFlag)).toBe(false);
  });

  it('matches a role or an event type against one value or a list', () => {
    expect(evaluateCondition({ narrative_role: 'context' }, facts())).toBe(true);
    expect(evaluateCondition({ narrative_role: ['payoff', 'context'] }, facts())).toBe(true);
    expect(evaluateCondition({ event_type: 'meal' }, facts())).toBe(false);
  });

  it('matches an affect axis, treating an absent axis as zero', () => {
    const excited = facts({ affect: { excitement: 0.9 } });
    expect(evaluateCondition({ affect: { excitement: '>0.8' } }, excited)).toBe(true);
    expect(evaluateCondition({ affect: { sadness: '<0.1' } }, excited)).toBe(true);
  });

  it('matches text the way the index does, including Japanese', () => {
    expect(evaluateCondition({ mentions: 'USJ' }, facts())).toBe(true);
    expect(evaluateCondition({ mentions: '入口' }, facts())).toBe(true);
    expect(evaluateCondition({ mentions: ['ramen', '到着'] }, facts())).toBe(true);
    expect(evaluateCondition({ mentions: 'ramen' }, facts())).toBe(false);
  });

  it('matches people and places by id', () => {
    expect(evaluateCondition({ involves_person: 'partner' }, facts())).toBe(true);
    expect(evaluateCondition({ involves_person: 'stranger' }, facts())).toBe(false);
    expect(evaluateCondition({ at_place: ['USJ', 'Osaka'] }, facts())).toBe(true);
  });

  it('nests with all_of, any_of and not', () => {
    const f = facts();
    expect(evaluateCondition({ any_of: [{ event_type: 'meal' }, { event_type: 'moment' }] }, f)).toBe(true);
    expect(evaluateCondition({ all_of: [{ has_speech: true }, { event_type: 'meal' }] }, f)).toBe(false);
    expect(evaluateCondition({ not: { event_type: 'meal' } }, f)).toBe(true);
  });

  it('rejects a misspelled field instead of silently never firing', () => {
    // A rule that quietly does nothing is the most frustrating way for a skill
    // to be wrong: the file looks right and the edit ignores it.
    expect(() => evaluateCondition({ stroy_importance: '>0.5' }, facts())).toThrow(/not something a rule can test/);
    expect(() => evaluateCondition({ establishing_shot: '>0.5' }, facts())).toThrow(/not something a rule can test/);
  });

  it('is true for an empty condition, which matches everything', () => {
    expect(evaluateCondition({}, facts())).toBe(true);
  });
});
