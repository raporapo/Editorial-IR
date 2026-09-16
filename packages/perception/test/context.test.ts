import { describe, expect, it } from 'vitest';
import {
  buildPrompt,
  createFixtureSuite,
  describeFromObservations,
  inferAffect,
  inferEventType,
  keywordsOf,
} from '../src/index.js';

const empty = {
  event_id: 'evt_0001',
  frame_paths: [],
  transcript: [],
  ocr: [],
  audio_tags: [],
  visual_labels: [],
  user_context: {},
};

describe('inferEventType', () => {
  it('recognises the same event in Japanese and English', () => {
    expect(inferEventType(['やっと着いた！'], [], [])).toBe('arrival');
    expect(inferEventType(['we finally arrived'], [], [])).toBe('arrival');
    expect(inferEventType(['このラーメン美味しい'], [], [])).toBe('meal');
    expect(inferEventType(['this ramen is delicious'], [], [])).toBe('meal');
  });

  it('falls back to b_roll when nobody says anything', () => {
    expect(inferEventType([], [], ['crowd'])).toBe('b_roll');
  });

  it('reads laughter as a reaction', () => {
    expect(inferEventType([], [], ['laughter'])).toBe('reaction');
  });
});

describe('inferAffect', () => {
  it('reads laughter as humour rather than inventing a story', () => {
    const affect = inferAffect([], ['laughter']);
    expect(affect.humour).toBeGreaterThan(0.5);
    expect(affect.excitement).toBeUndefined();
  });

  it('keeps every intensity inside [0,1]', () => {
    const affect = inferAffect(['すごい！最高！'], ['laughter', 'cheering', 'crowd']);
    for (const value of Object.values(affect)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe('keywordsOf', () => {
  it('drops single characters and ranks by frequency', () => {
    expect(keywordsOf(['ramen ramen bowl a'], [], 2)).toEqual(['ramen', 'bowl']);
  });
});

describe('describeFromObservations', () => {
  it('reports low confidence, which is what drives escalation', () => {
    const withSpeech = describeFromObservations({ ...empty, transcript: ['やっと着いた'] });
    const withoutSpeech = describeFromObservations(empty);
    expect(withSpeech.confidence).toBeLessThan(0.5);
    expect(withoutSpeech.confidence).toBeLessThan(withSpeech.confidence);
  });

  it('says plainly when there is nothing to describe', () => {
    expect(describeFromObservations(empty).description).toContain('no speech');
  });

  it('describes what was seen when nothing was said', () => {
    const result = describeFromObservations({ ...empty, visual_labels: ['night_view', 'city_lights'] });
    expect(result.description).toContain('night_view');
    // Better than nothing, still not an understanding.
    expect(result.confidence).toBeLessThan(0.35);
  });

  it('includes on-screen text, which is often the only place a name appears', () => {
    const result = describeFromObservations({ ...empty, ocr: ['UNIVERSAL STUDIOS JAPAN'] });
    expect(result.description).toContain('UNIVERSAL STUDIOS JAPAN');
  });

  it('truncates rather than emitting a paragraph', () => {
    const long = 'あ'.repeat(500);
    expect(describeFromObservations({ ...empty, transcript: [long] }).description.length).toBeLessThanOrEqual(140);
  });
});

describe('buildPrompt', () => {
  it('passes user background through verbatim and tells the model not to contradict it', () => {
    const prompt = buildPrompt({
      ...empty,
      user_context: { occasion: '交際1周年旅行' },
      transcript: ['やっと着いた'],
    });
    expect(prompt).toContain('交際1周年旅行');
    expect(prompt).toContain('やっと着いた');
  });

  it('gives the neighbours so the model can tell arrival from departure', () => {
    const prompt = buildPrompt({ ...empty, previous_summary: 'on the train', next_summary: 'walking in' });
    expect(prompt).toContain('Previous event: on the train');
    expect(prompt).toContain('Next event: walking in');
  });
});

describe('createFixtureSuite', () => {
  const fixture = {
    assets: {
      'a.mov': {
        probe: { duration_ms: 5000, metadata: {} },
        detect_shots: { shots: [{ start_ms: 0, end_ms: 5000, representative_frame_ms: 1000 }] },
      },
    },
    describe: {},
  };

  it('replays what the fixture holds', async () => {
    const suite = createFixtureSuite(fixture);
    expect((await suite.probe.probe('/anywhere/a.mov')).duration_ms).toBe(5000);
    expect((await suite.shots!.detectShots({ path: 'a.mov', threshold: 0.3, min_shot_ms: 800 })).shots).toHaveLength(1);
  });

  it('matches on the file name, so a fixture survives being moved', async () => {
    const suite = createFixtureSuite(fixture);
    await expect(suite.probe.probe('/some/other/place/a.mov')).resolves.toBeDefined();
  });

  it('says which assets it knows about when asked for one it does not', async () => {
    const suite = createFixtureSuite(fixture);
    await expect(suite.probe.probe('/x/missing.mov')).rejects.toThrow(/no entry for "missing.mov"/);
  });

  it('only advertises what the fixture actually carries', () => {
    const suite = createFixtureSuite(fixture);
    expect(suite.context).toBeUndefined();
    expect(suite.shots).toBeDefined();
    // No transcript in this fixture, so no speech model is offered. A suite that
    // claimed one and then failed would defeat the compiler's ability to degrade.
    expect(suite.speech).toBeUndefined();
    expect(suite.visual).toBeUndefined();
  });
});
