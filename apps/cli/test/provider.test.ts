import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rejectsResponseFormat } from '@editorial-ir/contracts';
import {
  GEMINI_BASE_URL,
  GEMINI_DEFAULTS,
  applyProviderPreset,
  confirmPresetModels,
  loadDotEnv,
  newestOfFamily,
} from '../src/provider.js';
import { main } from '../src/cli.js';

/**
 * One Gemini key standing for every model stage.
 *
 * What matters: it runs only when asked for, it never pairs its key with
 * another provider's URL, a stage the user configured keeps its own settings,
 * and a default model the key cannot reach is replaced by its newest sibling
 * rather than failing an hour into an analysis.
 */

const STAGES = ['OEA_VLM', 'OEA_DECISION', 'OEA_EMBED', 'OEA_AGENT'];

describe('applyProviderPreset', () => {
  it('fills every stage from one key', () => {
    const env: Record<string, string | undefined> = { OEA_GEMINI_API_KEY: 'k-123' };
    const preset = applyProviderPreset(env)!;
    expect(preset.keyFrom).toBe('OEA_GEMINI_API_KEY');
    for (const stage of STAGES) {
      expect(env[`${stage}_BASE_URL`]).toBe(GEMINI_BASE_URL);
      expect(env[`${stage}_API_KEY`]).toBe('k-123');
    }
    expect(env).toMatchObject({
      OEA_VLM_MODEL: GEMINI_DEFAULTS.describe,
      OEA_DECISION_MODEL: GEMINI_DEFAULTS.judge,
      OEA_EMBED_MODEL: GEMINI_DEFAULTS.embed,
      OEA_AGENT_MODEL: GEMINI_DEFAULTS.describe,
      // Every event described, and a model as the judge: standard quality.
      OEA_VLM_SCOPE: 'base',
      OEA_DECISION: 'local-system-one',
    });
  });

  it('does nothing for a generic key another tool put in the shell', () => {
    const env = { GEMINI_API_KEY: 'k-shell' };
    expect(applyProviderPreset(env)).toBeUndefined();
    expect(env).toEqual({ GEMINI_API_KEY: 'k-shell' });
  });

  it('uses the generic key when asked to by OEA_PROVIDER', () => {
    const env: Record<string, string | undefined> = {
      OEA_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'k-shell',
    };
    expect(applyProviderPreset(env)?.keyFrom).toBe('GEMINI_API_KEY');
    expect(env.OEA_DECISION_API_KEY).toBe('k-shell');
  });

  it('leaves a stage the user pointed elsewhere, and never sends it this key', () => {
    const env: Record<string, string | undefined> = {
      OEA_GEMINI_API_KEY: 'k-123',
      OEA_VLM_BASE_URL: 'http://localhost:11434/v1',
      OEA_VLM_MODEL: 'qwen2.5vl:7b',
    };
    const preset = applyProviderPreset(env)!;
    expect(preset.keptOwn).toEqual(['OEA_VLM']);
    expect(env.OEA_VLM_BASE_URL).toBe('http://localhost:11434/v1');
    expect(env.OEA_VLM_MODEL).toBe('qwen2.5vl:7b');
    expect(env.OEA_VLM_API_KEY).toBeUndefined();
    // Its scope is the user's to set: a local model already describes everything.
    expect(env.OEA_VLM_SCOPE).toBeUndefined();
    expect(env.OEA_DECISION_BASE_URL).toBe(GEMINI_BASE_URL);
  });

  it('takes the models the user names', () => {
    const env: Record<string, string | undefined> = {
      OEA_GEMINI_API_KEY: 'k-123',
      OEA_GEMINI_MODEL: 'gemini-9-flash',
      OEA_GEMINI_JUDGE_MODEL: 'gemini-9-flash',
    };
    const preset = applyProviderPreset(env)!;
    expect(preset.models.describe).toEqual({ model: 'gemini-9-flash', named: true });
    expect(env.OEA_DECISION_MODEL).toBe('gemini-9-flash');
    expect(env.OEA_EMBED_MODEL).toBe(GEMINI_DEFAULTS.embed);
  });

  it('keeps an explicit OEA_DECISION choice', () => {
    const env: Record<string, string | undefined> = {
      OEA_GEMINI_API_KEY: 'k-123',
      OEA_DECISION: 'heuristic',
    };
    applyProviderPreset(env);
    expect(env.OEA_DECISION).toBe('heuristic');
  });
});

describe('newestOfFamily', () => {
  const listed = [
    'gemini-2.5-flash',
    'gemini-3.6-flash',
    'gemini-3.10-flash-preview',
    'gemini-3.6-flash-image',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-embedding-001',
    'gemini-embedding-exp',
  ];

  it('takes the newest plain release of the same kind, never a preview or a variant', () => {
    expect(newestOfFamily('describe', listed)).toBe('gemini-3.6-flash');
    expect(newestOfFamily('judge', listed)).toBe('gemini-3.5-flash-lite');
    expect(newestOfFamily('embed', listed)).toBe('gemini-embedding-001');
  });

  it('compares versions as numbers, not text', () => {
    expect(newestOfFamily('describe', ['gemini-3.9-flash', 'gemini-3.10-flash'])).toBe(
      'gemini-3.10-flash',
    );
  });

  it('judges with the describing tier where there is no Flash-Lite', () => {
    expect(newestOfFamily('judge', ['gemini-3.6-flash'])).toBe('gemini-3.6-flash');
  });
});

describe('confirmPresetModels', () => {
  const listing = (ids: string[]) =>
    vi.fn(async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) })));

  it('moves a default the key cannot reach onto the newest of its family, and says so', async () => {
    const env: Record<string, string | undefined> = { OEA_GEMINI_API_KEY: 'k-123' };
    const preset = applyProviderPreset(env)!;
    const fetchImpl = listing([
      'models/gemini-3.6-flash',
      'models/gemini-3.5-flash-lite',
      'models/gemini-embedding-001',
    ]);
    const checked = await confirmPresetModels(preset, env, fetchImpl);
    expect(env.OEA_VLM_MODEL).toBe('gemini-3.6-flash');
    expect(env.OEA_AGENT_MODEL).toBe('gemini-3.6-flash');
    expect(env.OEA_DECISION_MODEL).toBe(GEMINI_DEFAULTS.judge);
    expect(checked.notes).toEqual([
      `${GEMINI_DEFAULTS.describe} is not available to this key; using gemini-3.6-flash for descriptions`,
    ]);
    // The key goes where the preset sends it, and nowhere else.
    expect(fetchImpl).toHaveBeenCalledWith(
      `${GEMINI_BASE_URL}/models`,
      expect.objectContaining({ headers: { authorization: 'Bearer k-123' } }),
    );
  });

  it('never replaces a model the user named', async () => {
    const env: Record<string, string | undefined> = {
      OEA_GEMINI_API_KEY: 'k-123',
      OEA_GEMINI_MODEL: 'gemini-private-flash',
    };
    const preset = applyProviderPreset(env)!;
    const checked = await confirmPresetModels(preset, env, listing(['gemini-3.6-flash']));
    expect(env.OEA_VLM_MODEL).toBe('gemini-private-flash');
    expect(checked.notes[0]).toMatch(/gemini-private-flash is not in the models/);
  });

  it('stops everything on a refused key, with the provider’s own words', async () => {
    const env: Record<string, string | undefined> = { OEA_GEMINI_API_KEY: 'k-bad' };
    const preset = applyProviderPreset(env)!;
    const refused = vi.fn(
      async () =>
        new Response('{"error":{"message":"API key not valid."}}', {
          status: 400,
        }),
    );
    const checked = await confirmPresetModels(preset, env, refused);
    expect(checked.refused).toMatch(/refused the key in OEA_GEMINI_API_KEY \(400\).*not valid/);
    // The key itself is never in a message.
    expect(checked.refused).not.toContain('k-bad');
  });

  it('carries on with the defaults when the list cannot be read', async () => {
    const env: Record<string, string | undefined> = { OEA_GEMINI_API_KEY: 'k-123' };
    const preset = applyProviderPreset(env)!;
    const offline = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    const checked = await confirmPresetModels(preset, env, offline);
    expect(checked.refused).toBeUndefined();
    expect(checked.notes[0]).toMatch(/could not reach Gemini/);
    expect(env.OEA_VLM_MODEL).toBe(GEMINI_DEFAULTS.describe);
  });
});

describe('loadDotEnv', () => {
  it('reads .env where the environment has nothing, and never overrides it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oea-dotenv-'));
    writeFileSync(
      join(dir, '.env'),
      '# a comment\nOEA_GEMINI_API_KEY=k-file\nOEA_GEMINI_MODEL=\nOEA_DECISION=heuristic\n',
    );
    const env: Record<string, string | undefined> = { OEA_DECISION: 'local-system-one' };
    expect(loadDotEnv(env, dir)).toEqual(['OEA_GEMINI_API_KEY']);
    expect(env.OEA_GEMINI_API_KEY).toBe('k-file');
    expect(env.OEA_DECISION).toBe('local-system-one');
    // An empty line in the template is not a setting.
    expect('OEA_GEMINI_MODEL' in env).toBe(false);
  });

  it('is nothing where there is no .env', () => {
    expect(loadDotEnv({}, mkdtempSync(join(tmpdir(), 'oea-dotenv-')))).toEqual([]);
  });
});

describe('Gemini’s way of refusing a schema', () => {
  it('is recognised, so the request is retried in a simpler shape', () => {
    const body =
      '{"error":{"code":400,"message":"Invalid JSON payload received. Unknown name ' +
      '\\"additionalProperties\\" at \'generation_config.response_schema\'"}}';
    expect(rejectsResponseFormat(400, body)).toBe(true);
    // And a refusal that is not about the shape still is not.
    expect(rejectsResponseFormat(400, '{"error":{"message":"API key not valid."}}')).toBe(false);
  });
});

describe('oea, with a key Gemini refuses', () => {
  const saved: Record<string, string | undefined> = {};
  const names = [
    'OEA_GEMINI_API_KEY',
    ...STAGES.flatMap((s) => [`${s}_BASE_URL`, `${s}_MODEL`, `${s}_API_KEY`]),
    'OEA_VLM_SCOPE',
    'OEA_DECISION',
  ];
  beforeEach(() => {
    for (const name of names) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it('stops before the analysis, rather than failing every event', async () => {
    process.env.OEA_GEMINI_API_KEY = 'k-bad';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response('{"error":{"message":"API key not valid."}}', { status: 400 }),
      ),
    );
    const errors: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      errors.push(String(chunk));
      return true;
    });
    expect(await main(['analyze', '--project', join(tmpdir(), 'no-such-project')])).toBe(1);
    expect(errors.join('')).toMatch(/Gemini refused the key/);
  });
});
