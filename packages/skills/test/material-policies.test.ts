import { describe, expect, it } from 'vitest';
import {
  SkillManifest,
  type EditorialIR,
  type MaterialKind,
  type SkillDirective,
} from '@editorial-ir/contracts';
import { SkillRegistry, SkillRuntime } from '../src/index.js';
import { makeIR, type EventSpec } from '../../../tests/support/ir.js';

/**
 * What a skill says about material that is not raw camera footage.
 *
 * The contract has carried `keep_whole`, `remove_silences` and `material` since
 * this wave began, and a skill that used them validated and then did nothing.
 * These pin what each now does, and what the shipped skills do with them.
 */
const registry = SkillRegistry.withBuiltIns();

function withMaterial(kind: MaterialKind | undefined, spec: EventSpec): EditorialIR {
  const ir = makeIR({ events: [spec] });
  if (kind) {
    ir.materials = [
      {
        asset_id: 'asset_001',
        kind,
        confidence: 0.9,
        provenance: 'inferred',
        evidence: [],
        signals: {},
      },
    ];
  }
  return ir;
}

function directive(skill: SkillManifest, ir: EditorialIR): SkillDirective {
  return new SkillRuntime(skill).evaluate(ir).get(ir.events[0]!.id)!;
}

const plain = (defaults: Record<string, unknown> = {}, rules: unknown[] = []) =>
  SkillManifest.parse({ name: 'plain', defaults, rules });

describe('keeping a clip whole', () => {
  const clip = (kind: MaterialKind | undefined, duration_ms = 5000) =>
    withMaterial(kind, { duration_ms, speech: ['Goodbye from the beach'] });

  it('keeps a clip the user trimmed whole when it fits the clip limits', () => {
    expect(directive(plain(), clip('clip')).keep_whole).toBe(true);
  });

  it('trims one longer than the skill lets a clip be, rather than being overruled by it', () => {
    expect(directive(plain({ max_clip_duration_ms: 4000 }), clip('clip', 6000)).keep_whole).toBe(
      false,
    );
  });

  it('keeps it whole under a rule that caps this kind of moment shorter', () => {
    // travel-vlog caps a wordless b-roll moment at four seconds. Measured on the
    // probe's folder of phone clips, that cut two of eight short, one of them
    // mid-sentence; the user's own trim is the stronger statement.
    const quiet = withMaterial('clip', { duration_ms: 4500, flags: { b_roll_candidate: 0.9 } });
    const result = directive(registry.resolve('travel-vlog'), quiet);
    expect(result.max_duration_ms).toBe(4000);
    expect(result.keep_whole).toBe(true);
  });

  it('leaves camera footage and unclassified material to be trimmed', () => {
    expect(directive(plain(), clip('raw')).keep_whole).toBe(false);
    expect(directive(plain(), clip(undefined)).keep_whole).toBe(false);
  });

  it('does what the skill says when it says always or never', () => {
    expect(directive(plain({ keep_whole: 'always' }), clip('raw')).keep_whole).toBe(true);
    expect(directive(plain({ keep_whole: 'never' }), clip('clip')).keep_whole).toBe(false);
  });

  it('lets a rule trim a clip the default would keep whole', () => {
    const skill = plain({}, [
      { id: 'trim-long-takes', when: { duration_ms: '>4000' }, action: { keep_whole: false } },
    ]);
    expect(directive(skill, clip('clip', 5000)).keep_whole).toBe(false);
    expect(directive(skill, clip('clip', 3000)).keep_whole).toBe(true);
  });

  it('lets a rule keep an event whole whatever the default says', () => {
    const skill = plain({ keep_whole: 'never' }, [
      { id: 'whole', when: { has_speech: true }, action: { keep_whole: true } },
    ]);
    expect(directive(skill, clip('raw')).keep_whole).toBe(true);
  });
});

describe('taking pauses out', () => {
  const talk = withMaterial('raw', { speech: ['so the thing is'] });

  it('is off unless a skill asks', () => {
    expect(directive(plain(), talk).remove_silences).toBe(false);
    expect(directive(plain({ remove_silences: true }), talk).remove_silences).toBe(true);
  });

  it('can be switched off by a rule for the moments it names, and a yes outranks a no', () => {
    const skill = plain({ remove_silences: true }, [
      {
        id: 'never-tighten-the-vows',
        when: { mentions: 'I do' },
        action: { remove_silences: false },
      },
    ]);
    const vows = withMaterial('raw', { speech: ['I do'] });
    expect(directive(skill, vows).remove_silences).toBe(false);
    expect(directive(skill, talk).remove_silences).toBe(true);

    const both = plain({}, [
      { id: 'no', priority: 1, when: { has_speech: true }, action: { remove_silences: false } },
      { id: 'yes', when: { has_speech: true }, action: { remove_silences: true } },
    ]);
    expect(directive(both, talk).remove_silences).toBe(true);
  });

  it('is on for talking-head and what extends it, and off for a travel vlog', () => {
    expect(directive(registry.resolve('talking-head'), talk).remove_silences).toBe(true);
    expect(directive(registry.resolve('tech-youtube'), talk).remove_silences).toBe(true);
    expect(directive(registry.resolve('travel-vlog'), talk).remove_silences).toBe(false);
  });
});

describe('the base rules, by material', () => {
  // Wordless, and the heuristic is sure it is b-roll.
  const quiet = (kind: MaterialKind | undefined) =>
    withMaterial(kind, { flags: { b_roll_candidate: 0.9 }, metrics: { story_importance: 0.5 } });

  it('mute a wordless shot of camera footage, as they always did', () => {
    expect(directive(registry.resolve('travel-vlog'), quiet('raw')).as_b_roll).toBe(true);
    expect(directive(registry.resolve('travel-vlog'), quiet(undefined)).as_b_roll).toBe(true);
  });

  it('keep the sound of an edited programme, which is its music bed', () => {
    // Measured: the exported cut of the probe's edited programme was silent.
    expect(directive(registry.resolve('travel-vlog'), quiet('edited')).as_b_roll).toBe(false);
  });

  it('never make a sound file into picture with no sound', () => {
    expect(directive(registry.resolve('travel-vlog'), quiet('audio_only')).as_b_roll).toBe(false);
  });

  it('do not drop a sound file for having no picture worth watching', () => {
    const podcast = withMaterial('audio_only', {
      speech: ['welcome back'],
      metrics: { visual_quality: 0.05 },
    });
    expect(directive(registry.resolve('base-editor'), podcast).dropped).toBe(false);
    const blurred = withMaterial('raw', { metrics: { visual_quality: 0.05 } });
    expect(directive(registry.resolve('base-editor'), blurred).dropped).toBe(true);
  });
});

describe('cut-down', () => {
  const skill = registry.resolve('cut-down');

  it('snaps to the programme’s cuts, whatever the material was classified as', () => {
    expect(skill.defaults.snap_to_cuts).toBe('always');
  });

  it('keeps the sound and the length of a wordless shot, which in a programme is most of them', () => {
    // Measured on the probe's edited programme: with the base rule's four-second
    // cap on every wordless moment, a 30-second cut-down came in at 14.5 s.
    const quiet = withMaterial('raw', { flags: { b_roll_candidate: 0.9 } });
    const result = directive(skill, quiet);
    expect(result.as_b_roll).toBe(false);
    expect(result.max_duration_ms).toBe(skill.defaults.max_clip_duration_ms);
    expect(result.tags).toContain('programme-sound');
  });

  it('prefers the moment that opens each section', () => {
    const ir = makeIR({
      events: [
        { chapter_id: 'chp_001', description: 'title card' },
        { chapter_id: 'chp_001', description: 'what it introduces' },
      ],
    });
    const directives = new SkillRuntime(skill).evaluate(ir);
    const opener = directives.get('evt_0001')!;
    const next = directives.get('evt_0002')!;
    expect(opener.matched_rule_ids).toContain('open-each-section-on-its-card');
    expect(opener.score).toBeGreaterThan(next.score);
  });
});

describe('clip-reel', () => {
  const skill = registry.resolve('clip-reel');
  // Offline, every hand-picked clip was described the same way, called filler
  // and a duplicate of the rest.
  const chosen = (kind: MaterialKind, duration_ms = 8000) =>
    withMaterial(kind, {
      duration_ms,
      role: 'filler',
      metrics: { story_importance: 0.175, redundancy: 1 },
      flags: { b_roll_candidate: 0.9, contains_dead_air: 0.9 },
    });

  it('keeps every clip the user chose, whole and with its sound', () => {
    const result = directive(skill, chosen('clip'));
    expect(result.dropped).toBe(false);
    expect(result.prefer_higher_quality_only).toBe(false);
    expect(result.keep_whole).toBe(true);
    expect(result.as_b_roll).toBe(false);
  });

  it('still treats a raw recording in the same folder as footage', () => {
    const result = directive(skill, chosen('raw', 600_000));
    expect(result.dropped).toBe(true);
    expect(result.keep_whole).toBe(false);
  });
});
