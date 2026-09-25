import { describe, expect, it } from 'vitest';
import {
  SkillManifest,
  type SkillManifest as Skill,
  type VideoOperation,
} from '@editorial-ir/contracts';
import { compileProject } from '@editorial-ir/core';
import { HeuristicDecisionBackend } from '@editorial-ir/decision';
import { SkillRegistry } from '@editorial-ir/skills';
import { planEdit } from '@editorial-ir/agent';
import { makeIR } from './support/ir.js';
import { exampleSuite, makeExampleProject } from './support/project.js';

/**
 * Where each chapter begins in the finished cut.
 *
 * Chapters exist in capture time, and the plan carried an empty `markers` list
 * whatever the IR knew about them, so an editor opening the export had no idea
 * where the harbour ended and the lighthouse began.
 */

const registry = SkillRegistry.withBuiltIns();

/** A skill that ranks by importance alone, so each test decides what matters. */
function skill(fields: Record<string, unknown> = {}): Skill {
  return SkillManifest.parse({
    name: 'probe',
    scoring: { weights: { story_importance: 1 } },
    ...fields,
  });
}

function main(plan: { tracks: { video: VideoOperation[] } }): VideoOperation[] {
  return plan.tracks.video;
}

describe('chapters in the finished cut', () => {
  const ir = () => {
    const built = makeIR({
      events: [
        { start_ms: 0, duration_ms: 6000, chapter_id: 'chp_001', speech: ['one'] },
        { start_ms: 10_000, duration_ms: 6000, chapter_id: 'chp_001', speech: ['two'] },
        { start_ms: 20_000, duration_ms: 6000, chapter_id: 'chp_002', speech: ['three'] },
      ],
    });
    built.chapters = [
      {
        id: 'chp_001',
        start_ms: 0,
        end_ms: 16_000,
        title: { value: 'Morning', provenance: 'inferred', confidence: 0.5 },
        event_ids: ['evt_0001', 'evt_0002'],
        provenance: 'inferred',
      },
      {
        id: 'chp_002',
        start_ms: 20_000,
        end_ms: 26_000,
        title: { value: 'Evening', provenance: 'inferred', confidence: 0.5 },
        event_ids: ['evt_0003'],
        provenance: 'inferred',
      },
    ];
    return built;
  };

  it('marks where each chapter begins, by name, in timeline order', () => {
    const plan = planEdit({ ir: ir(), skill: skill(), targetDurationMs: 18_000 });
    const third = main(plan).find((o) => o.event_id === 'evt_0003')!;
    expect(plan.markers).toEqual([
      { timeline_ms: 0, name: 'Morning', kind: 'chapter', event_id: 'evt_0001' },
      {
        timeline_ms: third.timeline_start_ms,
        name: 'Evening',
        kind: 'chapter',
        event_id: 'evt_0003',
      },
    ]);
  });

  it('marks the worked example’s chapters where they begin in its three-minute cut', async () => {
    const store = await makeExampleProject();
    const { ir, observations } = await compileProject({
      store,
      suite: exampleSuite(),
      decision: new HeuristicDecisionBackend(),
    });
    const plan = planEdit({
      ir,
      skill: registry.resolve('travel-vlog'),
      targetDurationMs: 180_000,
      observations,
    });
    const starts = new Set(main(plan).map((o) => o.timeline_start_ms));
    const titles = new Set(ir.chapters.map((c) => c.title.value));
    expect(plan.markers.length).toBeGreaterThan(1);
    expect(plan.markers[0]!.timeline_ms).toBe(0);
    for (const [i, marker] of plan.markers.entries()) {
      expect(starts.has(marker.timeline_ms)).toBe(true);
      expect(titles.has(marker.name)).toBe(true);
      if (i > 0) expect(marker.timeline_ms).toBeGreaterThan(plan.markers[i - 1]!.timeline_ms);
    }
  }, 60_000);

  /** One six-second spoken event per chapter, the chapters named in order. */
  const chaptered = (titles: string[]) => {
    const built = makeIR({
      events: titles.map((_, i) => ({
        start_ms: i * 10_000,
        duration_ms: 6000,
        chapter_id: `chp_00${i + 1}`,
        speech: [`line ${i + 1}`],
      })),
    });
    built.chapters = titles.map((title, i) => ({
      id: `chp_00${i + 1}`,
      start_ms: i * 10_000,
      end_ms: i * 10_000 + 6000,
      title: { value: title, provenance: 'inferred' as const, confidence: 0.5 },
      event_ids: [`evt_000${i + 1}`],
      provenance: 'inferred' as const,
    }));
    return built;
  };

  it('marks two chapters of the same name in a row once', () => {
    // The IR keeps two visits to one place apart; a viewer of the cut sees one.
    // The worked example marked "USJ" at 0:00 and again at 0:17.
    const plan = planEdit({
      ir: chaptered(['USJ', 'USJ', 'Night']),
      skill: skill(),
      targetDurationMs: 18_000,
    });
    expect(new Set(main(plan).map((o) => o.event_id)).size).toBe(3);
    expect(plan.markers.map((m) => [m.timeline_ms, m.name])).toEqual([
      [0, 'USJ'],
      [main(plan).find((o) => o.event_id === 'evt_0003')!.timeline_start_ms, 'Night'],
    ]);
  });

  it('writes none when the chapters it spans all have one name', () => {
    // The probe's edited programme offline: two chapters, both named "no speech
    // or on-screen text", and one marker of that at 0:00 says nothing.
    const plan = planEdit({
      ir: chaptered(['no speech or on-screen text', 'no speech or on-screen text']),
      skill: skill(),
      targetDurationMs: 12_000,
    });
    expect(new Set(main(plan).map((o) => o.event_id)).size).toBe(2);
    expect(plan.markers).toEqual([]);
  });

  it('writes none for a cut inside one chapter', () => {
    const plan = planEdit({
      ir: ir(),
      skill: skill(),
      targetDurationMs: 12_000,
      overrides: { drop: ['evt_0003'] },
    });
    expect(plan.markers).toEqual([]);
  });
});
