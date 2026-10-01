import { describe, expect, it } from 'vitest';
import { ProjectContext, type SemanticEvent } from '@editorial-ir/contracts';
import { buildEventState } from '@editorial-ir/core';
import { narrativeRoleWeights } from '@editorial-ir/decision';
import { aspectText } from '@editorial-ir/index';
import { deriveFacts } from '@editorial-ir/skills';
import { AgentToolkit } from '@editorial-ir/agent';
import { makeEvent, makeIR } from './support/ir.js';

/**
 * Burned-in subtitles, everywhere that reads what was said.
 *
 * Subtitles used to be part of `ocr`, so everything downstream saw them as text
 * on the screen. Once they were told apart from scene text they went to the
 * describer and nowhere else: the judge saw a subtitled montage with a music bed
 * as nothing said and nothing shown, which is the rules' definition of filler;
 * tech-youtube's `drop-silence` dropped it as dead air; "where they say the rain
 * started" could not find it; and the editing agent was shown an event with no
 * words in it. Each of those read `ocr` and nothing else.
 */
const said = ['We got to the harbour just before dawn', 'Then the rain started'];

function subtitled(subtitles: string[] | undefined): SemanticEvent {
  const event = makeEvent({ id: 'evt_0001', description: 'boats in a harbour' }, 0);
  return subtitles ? { ...event, observed: { ...event.observed, subtitles } } : event;
}

const context = ProjectContext.parse({
  project_id: 'prj_test',
  updated_at: '2026-09-24T00:00:00.000Z',
});

describe('burned-in subtitles', () => {
  it('reach the judge as what was said, so a subtitled montage is not filler', () => {
    const withWords = buildEventState(subtitled(said), undefined, undefined, 0.5, { context });
    const without = buildEventState(subtitled(undefined), undefined, undefined, 0.5, { context });
    expect(withWords.observed.speech).toEqual(said);
    expect(narrativeRoleWeights(without).filler).toBeGreaterThan(0.4);
    expect(narrativeRoleWeights(withWords).filler).toBeLessThan(0.2);
  });

  it('count as text on the screen for skill rules, and as words a rule can mention', () => {
    const facts = (event: SemanticEvent) =>
      deriveFacts({ ...makeIR({ events: [{}] }), events: [event] }).get('evt_0001')!;
    expect(facts(subtitled(undefined)).has_text_on_screen).toBe(false);
    expect(facts(subtitled(said)).has_text_on_screen).toBe(true);
    expect(facts(subtitled(said)).text).toContain('rain started');
  });

  it('are searched as speech', () => {
    expect(aspectText(subtitled(undefined), 'speech')).toBe('');
    expect(aspectText(subtitled(said), 'speech')).toContain('Then the rain started');
  });

  it('are shown to the editing agent, and not invented for an event without them', () => {
    const inspect = (event: SemanticEvent) =>
      new AgentToolkit({ ...makeIR({ events: [{}] }), events: [event] }).inspectEvent('evt_0001');
    expect(inspect(subtitled(said))?.subtitles).toEqual(said);
    expect(inspect(subtitled(undefined))).not.toHaveProperty('subtitles');
  });
});
