import { describe, expect, it } from 'vitest';
import {
  EditPlan,
  EditorialIR,
  SCHEMA_NAMES,
  SCHEMA_REGISTRY,
  SkillManifest,
  UserAnnotation,
  EditorialError,
  parseOrThrow,
  toJsonSchema,
  toJsonSchemaBundle,
} from '../src/index.js';

describe('JSON Schema export', () => {
  it('exports every registered schema', () => {
    expect(SCHEMA_NAMES.length).toBeGreaterThan(30);
    for (const name of SCHEMA_NAMES) {
      const json = toJsonSchema(name);
      expect(json.$id).toContain(name);
      expect(typeof json).toBe('object');
    }
  });

  it('bundles the whole contract into one document', () => {
    const bundle = toJsonSchemaBundle() as { $defs: Record<string, unknown> };
    expect(Object.keys(bundle.$defs).sort()).toEqual([...SCHEMA_NAMES].sort());
  });

  it('is deterministic, so a schema change is a reviewable diff', () => {
    expect(JSON.stringify(toJsonSchemaBundle())).toBe(JSON.stringify(toJsonSchemaBundle()));
  });

  it('rejects unknown keys everywhere, so a typo in a hand-written file is caught', () => {
    const json = toJsonSchema('SkillManifest') as { additionalProperties?: boolean };
    expect(json.additionalProperties).toBe(false);
  });
});

describe('strictness', () => {
  it('rejects an unknown field in a skill manifest', () => {
    const result = SkillManifest.safeParse({ name: 'demo', rulez: [] });
    expect(result.success).toBe(false);
  });

  it('fills defaults so a minimal manifest is usable', () => {
    const skill = SkillManifest.parse({ name: 'demo' });
    expect(skill.defaults.min_clip_duration_ms).toBeGreaterThan(0);
    expect(skill.arc.ordering).toBe('chronological');
    expect(skill.scoring.duplicate_penalty).toBeGreaterThan(0);
    expect(skill.rules).toEqual([]);
  });

  it('enforces kebab-case skill names', () => {
    expect(SkillManifest.safeParse({ name: 'Travel Vlog' }).success).toBe(false);
    expect(SkillManifest.safeParse({ name: 'travel-vlog' }).success).toBe(true);
  });
});

describe('user annotations', () => {
  const base = { id: 'ann_0001', created_at: '2026-09-16T00:00:00.000Z', priority: 0 };

  it('accepts an essential time range', () => {
    const a = UserAnnotation.parse({
      ...base,
      type: 'essential',
      target: { kind: 'time_range', start_ms: 1_100_000, end_ms: 1_122_000 },
    });
    expect(a.type).toBe('essential');
  });

  it('accepts a continuity link between two events', () => {
    const a = UserAnnotation.parse({
      ...base,
      type: 'continuity',
      strength: 0.95,
      target: { kind: 'event_pair', event_a: 'evt_0007', event_b: 'evt_0008' },
    });
    expect(a.type === 'continuity' && a.strength).toBe(0.95);
  });

  it('rejects a payload that does not match its type', () => {
    expect(
      UserAnnotation.safeParse({ ...base, type: 'importance', target: { kind: 'project' } }).success,
    ).toBe(false);
  });
});

describe('parseOrThrow', () => {
  it('throws a coded error with a readable message', () => {
    try {
      parseOrThrow(SkillManifest, { name: 'Bad Name' }, 'skill manifest');
      expect.unreachable();
    } catch (error) {
      expect(EditorialError.is(error)).toBe(true);
      const e = error as EditorialError;
      expect(e.code).toBe('schema_violation');
      expect(e.message).toContain('skill manifest');
      expect(e.toJSON().error.code).toBe('schema_violation');
    }
  });
});

describe('documents', () => {
  it('registers the documents the product is built around', () => {
    expect(SCHEMA_REGISTRY.EditorialIR).toBe(EditorialIR);
    expect(SCHEMA_REGISTRY.EditPlan).toBe(EditPlan);
  });
});
