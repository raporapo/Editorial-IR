import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IR_VERSION, ProjectContext, newId } from '@editorial-ir/contracts';
import { FileProjectStore, MemoryCache } from '../src/index.js';
import { makeIR } from '../../../tests/support/ir.js';

/**
 * Where a project lives.
 *
 * Plain files, in formats a person can open. The thing this project asks users
 * to trust is a representation of their own footage, and a representation they
 * cannot look at is one they have to take on faith.
 */
function makeStore() {
  const root = mkdtempSync(join(tmpdir(), 'editorial-ir-store-'));
  const store = new FileProjectStore(root, new MemoryCache());
  const now = '2026-05-17T09:00:00.000Z';
  const project = {
    id: newId('prj'),
    title: 'Test',
    status: 'created' as const,
    ir_version: IR_VERSION,
    created_at: now,
    updated_at: now,
  };
  store.initialise(project, ProjectContext.parse({ project_id: project.id, updated_at: now }));
  return { store, project, root };
}

describe('FileProjectStore', () => {
  it('knows whether a project is there', () => {
    const root = mkdtempSync(join(tmpdir(), 'editorial-ir-empty-'));
    expect(new FileProjectStore(root).exists()).toBe(false);
    expect(makeStore().store.exists()).toBe(true);
  });

  it('round-trips the project and the context', () => {
    const { store, project } = makeStore();
    expect(store.readProject().id).toBe(project.id);

    const context = store.readContext();
    store.writeContext({
      ...context,
      background: { ...context.background, occasion: '交際1周年旅行' },
    });
    expect(store.readContext().background.occasion).toBe('交際1周年旅行');
  });

  it('writes the context as YAML a person can edit, with an explanation at the top', () => {
    const { store } = makeStore();
    const text = readFileSync(store.paths.context, 'utf8');
    expect(text.startsWith('#')).toBe(true);
    expect(text).toContain('outranks');
    expect(text).toContain('project_id:');
  });

  it('round-trips annotations and assets', () => {
    const { store } = makeStore();
    expect(store.readAnnotations()).toEqual([]);

    store.writeAnnotations([
      {
        id: 'ann_0001',
        type: 'essential',
        target: { kind: 'event', event_id: 'evt_0001' },
        anchor: [],
        priority: 0,
        created_at: '2026-05-17T09:00:00.000Z',
      },
    ]);
    expect(store.readAnnotations()).toHaveLength(1);
  });

  it('refuses a file that does not match its schema, rather than half-reading it', () => {
    const { store } = makeStore();
    writeFileSync(store.paths.annotations, JSON.stringify([{ id: 'ann_1', type: 'nonsense' }]));
    expect(() => store.readAnnotations()).toThrow(/failed validation/);
  });

  it('says what to do when there is no project', () => {
    const root = mkdtempSync(join(tmpdir(), 'editorial-ir-none-'));
    expect(() => new FileProjectStore(root).readProject()).toThrow(/oea init/);
  });

  it('returns nothing rather than failing for work that has not happened yet', () => {
    const { store } = makeStore();
    expect(store.readIr()).toBeUndefined();
    expect(store.readObservations()).toBeUndefined();
    expect(store.readEmbeddings()).toBeUndefined();
    expect(store.listPlans()).toEqual([]);
    expect(store.latestPlan()).toBeUndefined();
  });

  it('keeps plans and finds the latest by when it was made', () => {
    const { store, project } = makeStore();
    const base = {
      edit_plan_version: '0.1.0',
      project_id: project.id,
      ir_fingerprint: 'f',
      skill: { name: 's', version: '1' },
      sequence: {
        name: 's',
        target_duration_ms: 1000,
        tolerance_ms: 0,
        width: 1920,
        height: 1080,
        frame_rate: 30,
        frame_rate_num: 30,
        frame_rate_den: 1,
        sample_rate: 48_000,
      },
      tracks: { video: [], audio: [], text: [] },
      intent: { tone: [] },
      rationale: [],
      model_runs: [],
      stats: {
        operation_count: 0,
        total_duration_ms: 0,
        duration_error_ms: 0,
        compression_ratio: 0,
        events_selected: 0,
        events_available: 0,
        mean_importance: 0,
        mean_continuity: 0,
      },
    };

    store.writePlan({ ...base, id: 'plan_first', created_at: '2026-05-17T09:00:00.000Z' });
    store.writePlan({ ...base, id: 'plan_second', created_at: '2026-05-17T10:00:00.000Z' });

    expect(store.listPlans().sort()).toEqual(['plan_first', 'plan_second']);
    expect(store.latestPlan()?.id).toBe('plan_second');
    expect(store.readPlan('plan_first')?.id).toBe('plan_first');
    expect(store.readPlan('plan_missing')).toBeUndefined();
  });

  it('leaves no half-written file behind', () => {
    const { store } = makeStore();
    // Everything is written beside and renamed, so an interrupted compile cannot
    // leave an IR that parses as valid but is half of one.
    const before = readFileSync(store.paths.project, 'utf8');
    store.writeProject({ ...store.readProject(), title: 'Renamed' });
    const after = readFileSync(store.paths.project, 'utf8');
    expect(before).not.toBe(after);
    expect(JSON.parse(after).title).toBe('Renamed');
  });
});

/**
 * A document from a version this one cannot read.
 *
 * "Below 1.0.0 the minor is treated as the breaking segment, and a document
 * from an incompatible version is rejected rather than read hopefully" is what
 * the documentation promises, and nothing did it. Almost every field in these
 * schemas is optional or defaulted, so an older document parses without
 * complaint and produces something subtly wrong — the worst of the three
 * outcomes.
 */
describe('a document from another version', () => {
  it('is refused rather than read hopefully', () => {
    const { store } = makeStore();
    const ir = makeIR({ events: [{ description: '出発' }] });
    // Derived from the current version rather than written down. A literal here
    // stopped testing anything the day IR_VERSION caught up with it: the file
    // said "another version" while naming this one, and the assertion passed
    // for the opposite reason.
    const [major, minor] = IR_VERSION.split('.');
    const otherVersion = `${major}.${Number(minor) + 1}.0`;
    store.writeIr({ ...ir, ir_version: otherVersion });
    expect(() => store.readIr()).toThrow(new RegExp(`written by version ${otherVersion}`));
  });

  it('is read when the version is one this can handle', () => {
    const { store } = makeStore();
    const ir = makeIR({ events: [{ description: '出発' }] });
    store.writeIr(ir);
    expect(store.readIr()?.events).toHaveLength(1);
  });

  it('refuses a plan the same way', () => {
    const { store } = makeStore();
    const plan = {
      edit_plan_version: '0.9.0',
      id: 'plan_x',
      project_id: 'prj_test',
      created_at: '2026-05-17T09:00:00.000Z',
      ir_fingerprint: 'f',
      skill: { name: 's', version: '1' },
      sequence: {
        name: 's',
        target_duration_ms: 1000,
        tolerance_ms: 0,
        width: 1920,
        height: 1080,
        frame_rate: 30,
        frame_rate_num: 30,
        frame_rate_den: 1,
        sample_rate: 48_000,
      },
      tracks: { video: [], audio: [], text: [] },
      intent: { tone: [] },
      rationale: [],
      model_runs: [],
      stats: {
        operation_count: 0,
        total_duration_ms: 0,
        duration_error_ms: 0,
        compression_ratio: 0,
        events_selected: 0,
        events_available: 0,
        mean_importance: 0,
        mean_continuity: 0,
      },
    };
    store.writePlan(plan);
    expect(() => store.readPlan('plan_x')).toThrow(/written by version 0\.9\.0/);
  });
});
