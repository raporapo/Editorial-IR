import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EditorialError } from '@editorial-ir/contracts';
import { missingModels, resolveBackends } from '../src/backends.js';
import { HeuristicDecisionBackend } from '@editorial-ir/decision';
import { HashingTextEmbedding, createLocalSuite } from '@editorial-ir/perception';

/**
 * The gate that stops a rules-only analysis from being mistaken for a real one.
 *
 * These tests all turn on one property: a backend declares itself a stand-in,
 * and nothing here is allowed to decide that on its behalf. If someone adds a
 * fourth stand-in and forgets to declare it, `missingModels` will not see it and
 * the whole mechanism silently stops working — which is why the first test below
 * asks the backends themselves rather than asserting a count.
 */
const MODEL_VARS = [
  'OEA_PERCEPTION',
  'OEA_DECISION',
  'OEA_VLM_BASE_URL',
  'OEA_VLM_MODEL',
  'OEA_VLM_SCOPE',
  'OEA_VLM_API_KEY',
  'OEA_DECISION_BASE_URL',
  'OEA_DECISION_MODEL',
  'OEA_EMBED_BASE_URL',
  'OEA_EMBED_MODEL',
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(MODEL_VARS.map((k) => [k, process.env[k]]));
  for (const key of MODEL_VARS) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('what counts as a missing model', () => {
  it('is asked of the backends, not of the environment', () => {
    const suite = { ...createLocalSuite(), text: new HashingTextEmbedding() };
    const missing = missingModels(suite, new HeuristicDecisionBackend());
    expect(missing.map((m) => m.stage).sort()).toEqual([
      'description',
      'judgement',
      'text_embedding',
    ]);
  });

  it('gives every missing stage something the user can actually do', () => {
    const suite = { ...createLocalSuite(), text: new HashingTextEmbedding() };
    for (const item of missingModels(suite, new HeuristicDecisionBackend())) {
      // A gate that says "no" without saying "instead, do this" is a gate people
      // work around by deleting it.
      expect(item.remedy).toMatch(/OEA_|install/);
      expect(item.using.length).toBeGreaterThan(0);
    }
  });
});

describe('standard mode', () => {
  it('refuses when a decisive stage would guess', async () => {
    await expect(resolveBackends({ perception: 'local' })).rejects.toThrow(
      /standard quality needs a model/,
    );
  });

  it('names every missing stage, and the escape hatch', async () => {
    const error = await resolveBackends({ perception: 'local' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EditorialError);
    const message = (error as EditorialError).message;
    expect(message).toContain('description');
    expect(message).toContain('judgement');
    expect(message).toContain('text_embedding');
    expect(message).toContain('--offline-minimal');
  });

  it('is the default, so nobody reaches it by accident', async () => {
    // No `mode` passed at all.
    await expect(resolveBackends({ perception: 'local' })).rejects.toThrow();
  });
});

describe('offline-minimal mode', () => {
  it('resolves, and reports what will stand in rather than hiding it', async () => {
    const backends = await resolveBackends({ perception: 'local', mode: 'offline-minimal' });
    try {
      expect(backends.missing.length).toBeGreaterThan(0);
      expect(backends.standInReason).toBe('requested');
    } finally {
      await backends.close();
    }
  });

  it('still uses a model that is configured', async () => {
    // The mode decides whether to refuse, never whether to use what is there.
    // Without this, re-analysing an offline project would keep ignoring models
    // the user had since set up.
    process.env.OEA_EMBED_BASE_URL = 'http://127.0.0.1:9/v1';
    process.env.OEA_EMBED_MODEL = 'some-embedding';
    const backends = await resolveBackends({ perception: 'local', mode: 'offline-minimal' });
    try {
      expect(backends.missing.map((m) => m.stage)).not.toContain('text_embedding');
    } finally {
      await backends.close();
    }
  });
});

describe('where a vision model is pointed', () => {
  it('describes every event when it runs on this machine', async () => {
    process.env.OEA_VLM_BASE_URL = 'http://127.0.0.1:11434/v1';
    process.env.OEA_VLM_MODEL = 'a-local-vlm';
    const backends = await resolveBackends({ perception: 'local', mode: 'offline-minimal' });
    try {
      expect(backends.missing.map((m) => m.stage)).not.toContain('description');
      expect(backends.description.join('\n')).toContain('on every event');
    } finally {
      await backends.close();
    }
  });

  it('waits for the events that earn it when it costs money', async () => {
    // A hosted endpoint on every event of a one-hour project is a bill nobody
    // asked for, so the base pass keeps the rules and description stays listed
    // as a stand-in. That is the honest answer, not a bug.
    process.env.OEA_VLM_BASE_URL = 'https://api.example.com/v1';
    process.env.OEA_VLM_MODEL = 'a-hosted-vlm';
    const backends = await resolveBackends({ perception: 'local', mode: 'offline-minimal' });
    try {
      expect(backends.missing.map((m) => m.stage)).toContain('description');
      expect(backends.escalationContext).toBeDefined();
      expect(backends.description.join('\n')).toContain('OEA_VLM_SCOPE=base');
    } finally {
      await backends.close();
    }
  });

  it('can be told to spend, which is the only way a hosted setup reaches standard', async () => {
    process.env.OEA_VLM_BASE_URL = 'https://api.example.com/v1';
    process.env.OEA_VLM_MODEL = 'a-hosted-vlm';
    process.env.OEA_VLM_SCOPE = 'base';
    const backends = await resolveBackends({ perception: 'local', mode: 'offline-minimal' });
    try {
      expect(backends.missing.map((m) => m.stage)).not.toContain('description');
    } finally {
      await backends.close();
    }
  });

  it('rejects a scope it does not understand instead of picking one', async () => {
    process.env.OEA_VLM_BASE_URL = 'https://api.example.com/v1';
    process.env.OEA_VLM_MODEL = 'a-hosted-vlm';
    process.env.OEA_VLM_SCOPE = 'sometimes';
    await expect(resolveBackends({ perception: 'local', mode: 'offline-minimal' })).rejects.toThrow(
      /OEA_VLM_SCOPE/,
    );
  });
});
