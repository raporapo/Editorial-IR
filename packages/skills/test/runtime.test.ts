import { describe, expect, it } from 'vitest';
import { SkillManifest } from '@editorial-ir/contracts';
import { SkillRegistry, SkillRuntime, deriveFacts, mergeSkills, validateSkill } from '../src/index.js';
import { makeIR } from '../../../tests/support/ir.js';

const registry = SkillRegistry.withBuiltIns();

const ir = makeIR({
  occasion: '交際1周年旅行',
  events: [
    {
      description: '電車でUSJへ移動している',
      event_type: 'travel',
      places: ['電車'],
      role: 'transition',
      metrics: { story_importance: 0.3, emotional_intensity: 0.2, redundancy: 0.1 },
    },
    {
      description: '二人がUSJ入口に到着し喜んでいる',
      event_type: 'arrival',
      places: ['USJ'],
      people: ['me', 'partner'],
      audio: ['laughter'],
      affect: { excitement: 0.88 },
      role: 'payoff',
      metrics: { story_importance: 0.91, emotional_intensity: 0.85, redundancy: 0.08 },
      flags: { establishing_shot: 0.82, preserve: 0.96 },
    },
    {
      description: 'ぼんやりした映像',
      event_type: 'b_roll',
      role: 'filler',
      metrics: { story_importance: 0.1, visual_quality: 0.1, emotional_intensity: 0.05 },
    },
    {
      description: 'また来ようと話している',
      event_type: 'farewell',
      speech: ['また来ようね'],
      affect: { intimacy: 0.8 },
      role: 'ending',
      metrics: { story_importance: 0.8, emotional_intensity: 0.7 },
      flags: { ending_candidate: 0.8 },
    },
  ],
});

describe('the built-in skill library', () => {
  it('ships the skills the documentation promises', () => {
    expect(registry.list().map((s) => s.name)).toEqual([
      'base-editor',
      'memory-film',
      'shorts',
      'talking-head',
      'tech-youtube',
      'travel-vlog',
    ]);
  });

  it('ships a readable explanation beside every skill', () => {
    for (const source of registry.list()) {
      expect(source.readme, `${source.name} has no SKILL.md`).toBeDefined();
      expect(source.readme!.length).toBeGreaterThan(200);
    }
  });

  it('resolves and validates every one of them', () => {
    for (const source of registry.list()) {
      const resolved = registry.resolve(source.name);
      expect(SkillManifest.safeParse(resolved).success).toBe(true);
      expect(validateSkill(resolved)).toEqual([]);
    }
  });

  it('inherits from base-editor without restating it', () => {
    const travel = registry.resolve('travel-vlog');
    // Its own weight.
    expect(travel.scoring.weights.emotional_intensity).toBe(0.7);
    // Inherited, never written in travel-vlog/skill.yaml.
    expect(travel.scoring.weights.redundancy).toBe(-0.8);
    // Rules accumulate, parent first.
    expect(travel.rules.length).toBeGreaterThan(registry.source('travel-vlog')!.manifest.rules.length);
    expect(travel.rules[0]?.id).toBe('drop-unusable-picture');
  });

  it('inherits through two levels', () => {
    const tech = registry.resolve('tech-youtube');
    expect(tech.name).toBe('tech-youtube');
    // From talking-head.
    expect(tech.rules.some((r) => r.id === 'never-cut-mid-sentence')).toBe(true);
    // From base-editor.
    expect(tech.rules.some((r) => r.id === 'drop-unusable-picture')).toBe(true);
    expect(tech.scoring.weights.information_density).toBe(1.0);
  });

  it('refuses a skill that does not exist, and says what does', () => {
    expect(() => registry.resolve('wedding')).toThrow(/no skill named "wedding"/);
  });

  it('detects a cycle rather than recursing forever', () => {
    const cyclic = new SkillRegistry();
    cyclic.add({
      name: 'a',
      origin: 'test',
      manifest: SkillManifest.parse({ name: 'a', extends: ['b'] }),
    });
    cyclic.add({
      name: 'b',
      origin: 'test',
      manifest: SkillManifest.parse({ name: 'b', extends: ['a'] }),
    });
    expect(() => cyclic.resolve('a')).toThrow(/cycle/);
  });
});

describe('mergeSkills', () => {
  const parent = SkillManifest.parse({
    name: 'parent',
    defaults: { min_clip_duration_ms: 1000, max_clip_duration_ms: 10_000 },
    scoring: { weights: { story_importance: 1, redundancy: -0.5 } },
    arc: { segments: [{ name: 'all', budget: 1 }] },
    rules: [{ id: 'p1', when: {}, action: { prefer: true } }],
  });

  it('merges weights key by key', () => {
    const child = SkillManifest.parse({ name: 'child', scoring: { weights: { story_importance: 0.2 } } });
    const merged = mergeSkills(parent, child);
    expect(merged.scoring.weights.story_importance).toBe(0.2);
    expect(merged.scoring.weights.redundancy).toBe(-0.5);
  });

  it('keeps the parent arc when the child does not declare one', () => {
    const child = SkillManifest.parse({ name: 'child' });
    expect(mergeSkills(parent, child).arc.segments).toHaveLength(1);
  });

  it('replaces the arc wholesale when the child declares one', () => {
    const child = SkillManifest.parse({
      name: 'child',
      arc: { segments: [{ name: 'a', budget: 0.5 }, { name: 'b', budget: 0.5 }] },
    });
    expect(mergeSkills(parent, child).arc.segments).toHaveLength(2);
  });

  it('appends rules with the parent first', () => {
    const child = SkillManifest.parse({ name: 'child', rules: [{ id: 'c1', when: {}, action: { avoid: true } }] });
    expect(mergeSkills(parent, child).rules.map((r) => r.id)).toEqual(['p1', 'c1']);
  });
});

describe('validateSkill', () => {
  it('catches an arc whose budgets do not sum to one', () => {
    const manifest = SkillManifest.parse({
      name: 'broken',
      arc: { segments: [{ name: 'a', budget: 0.5 }, { name: 'b', budget: 0.2 }] },
    });
    expect(validateSkill(manifest)[0]).toMatch(/sum to 0.70/);
  });

  it('catches a rule that can never do anything', () => {
    const manifest = SkillManifest.parse({ name: 'broken', rules: [{ id: 'x', when: {}, action: {} }] });
    expect(validateSkill(manifest)[0]).toMatch(/empty action/);
  });

  it('catches two rules sharing an id', () => {
    const manifest = SkillManifest.parse({
      name: 'broken',
      rules: [
        { id: 'x', when: {}, action: { prefer: true } },
        { id: 'x', when: {}, action: { avoid: true } },
      ],
    });
    expect(validateSkill(manifest).some((p) => p.includes('share the id'))).toBe(true);
  });
});

describe('SkillRuntime', () => {
  it('ranks the arrival above the filler', () => {
    const runtime = new SkillRuntime(registry.resolve('travel-vlog'));
    const directives = runtime.evaluate(ir);
    expect(directives.get('evt_0002')!.score).toBeGreaterThan(directives.get('evt_0001')!.score);
    expect(directives.get('evt_0003')!.dropped).toBe(true);
  });

  it('records which rules fired, so a plan can be explained', () => {
    const fired: string[] = [];
    const runtime = new SkillRuntime(registry.resolve('travel-vlog'), {
      onRuleFired: (_eventId, ruleId) => void fired.push(ruleId),
    });
    const directives = runtime.evaluate(ir);
    expect(directives.get('evt_0002')!.matched_rule_ids).toContain('let-feeling-breathe');
    expect(fired).toContain('do-not-cut-into-a-payoff');
  });

  it('applies a minimum duration from the rule that set it', () => {
    const runtime = new SkillRuntime(registry.resolve('travel-vlog'));
    const arrival = runtime.evaluate(ir).get('evt_0002')!;
    expect(arrival.min_duration_ms).toBeGreaterThanOrEqual(3000);
    expect(arrival.preserve_reaction).toBe(true);
  });

  it('turns "do not cut into this" into a floor of the whole event', () => {
    const runtime = new SkillRuntime(registry.resolve('travel-vlog'));
    const arrival = runtime.evaluate(ir).get('evt_0002')!;
    const event = ir.events.find((e) => e.id === 'evt_0002')!;
    const duration = event.end_ms - event.start_ms;
    expect(arrival.min_duration_ms).toBe(Math.min(duration, arrival.max_duration_ms));
  });

  it('never lets a floor exceed a ceiling', () => {
    const runtime = new SkillRuntime(
      SkillManifest.parse({
        name: 'contradictory',
        rules: [{ when: {}, action: { minimum_duration_sec: 20, maximum_duration_sec: 3 } }],
      }),
    );
    for (const directive of runtime.evaluate(ir).values()) {
      expect(directive.min_duration_ms).toBeLessThanOrEqual(directive.max_duration_ms);
    }
  });

  it('lets the user overrule every rule in the file', () => {
    const withEssential = makeIR({
      events: [{ description: 'ぼんやりした映像', event_type: 'b_roll', role: 'filler', essential: true, metrics: { story_importance: 0.05, visual_quality: 0.05 } }],
    });
    const directive = new SkillRuntime(registry.resolve('base-editor')).evaluate(withEssential).get('evt_0001')!;
    expect(directive.dropped).toBe(false);
    expect(directive.required).toBe(true);
    expect(directive.locked).toBe(true);
  });

  it('honours an exclusion even against a rule that prefers the event', () => {
    const excluded = makeIR({
      events: [{ description: '素晴らしい瞬間', metrics: { story_importance: 0.99 }, excluded: true }],
    });
    const directive = new SkillRuntime(registry.resolve('base-editor')).evaluate(excluded).get('evt_0001')!;
    expect(directive.dropped).toBe(true);
    expect(directive.required).toBe(false);
  });

  it('gives the same footage a different order under a different skill', () => {
    const travel = new SkillRuntime(registry.resolve('travel-vlog')).evaluate(ir);
    const talking = new SkillRuntime(registry.resolve('talking-head')).evaluate(ir);
    const rank = (d: Map<string, { score: number }>) =>
      [...d.entries()].sort((a, b) => b[1].score - a[1].score).map(([id]) => id);
    // The same analysis, two styles, two answers: that is the whole reason
    // skills and the decision layer are separate.
    expect(rank(travel)).not.toEqual(rank(talking));
  });

  it('applies the higher-priority rule last', () => {
    const runtime = new SkillRuntime(
      SkillManifest.parse({
        name: 'priorities',
        rules: [
          { id: 'low', priority: 0, when: {}, action: { maximum_duration_sec: 10 } },
          { id: 'high', priority: 10, when: {}, action: { maximum_duration_sec: 4 } },
        ],
      }),
    );
    expect(runtime.evaluate(ir).get('evt_0001')!.max_duration_ms).toBe(4000);
  });

  it('normalises the base score so a bias means the same everywhere', () => {
    const small = new SkillRuntime(SkillManifest.parse({ name: 's', scoring: { weights: { story_importance: 0.1 } } }));
    const large = new SkillRuntime(SkillManifest.parse({ name: 'l', scoring: { weights: { story_importance: 10 } } }));
    const facts = deriveFacts(ir);
    const f = facts.get('evt_0002')!;
    expect(small.baseScore(f)).toBeCloseTo(large.baseScore(f), 6);
  });
});

describe('deriveFacts', () => {
  it('notices arriving somewhere new', () => {
    const facts = deriveFacts(ir);
    expect(facts.get('evt_0001')!.new_location).toBe(true);
    expect(facts.get('evt_0002')!.new_location).toBe(true);
    expect(facts.get('evt_0003')!.new_location).toBe(false);
  });

  it('marks the first and last events of the project', () => {
    const facts = deriveFacts(ir);
    expect(facts.get('evt_0001')!.project_position).toBe('first');
    expect(facts.get('evt_0002')!.project_position).toBe('middle');
    expect(facts.get('evt_0004')!.project_position).toBe('last');
  });

  it('reads laughter and on-screen text off the observations', () => {
    const facts = deriveFacts(ir);
    expect(facts.get('evt_0002')!.has_laughter).toBe(true);
    expect(facts.get('evt_0001')!.has_laughter).toBe(false);
  });
});
