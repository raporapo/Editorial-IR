import { describe, expect, it, vi } from 'vitest';
import {
  OpenAiCompatibleContextModel,
  OpenAiCompatibleTextEmbedding,
  buildPrompt,
} from '../src/index.js';
import type { DescribeParams } from '@editorial-ir/contracts';
import type { TextEmbeddingModel } from '../src/index.js';

/**
 * The paths that run when somebody configures a model.
 *
 * Everything else in this project is free and local; this is the code that
 * spends their money and, on a remote endpoint, sends their frames somewhere. It
 * had almost no coverage, which is the wrong way round: a parsing bug here is
 * discovered on a first API call, by a stranger, at cost.
 */
const params: DescribeParams = {
  event_id: 'evt_0001',
  frame_paths: [],
  transcript: ['やっと着いた！'],
  ocr: ['UNIVERSAL STUDIOS JAPAN'],
  audio_tags: ['crowd'],
  visual_labels: ['theme_park_gate'],
  user_context: { occasion: '交際1周年旅行' },
};

function reply(body: unknown, init: { status?: number } = {}) {
  return vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

/** The JSON body of a request the scripted endpoint received. */
function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
}

/** The headers of the nth request the scripted endpoint received. */
function headersOf(fetchImpl: ReturnType<typeof reply>, call = 0): Record<string, string> {
  return (fetchImpl.mock.calls[call]?.[1]?.headers ?? {}) as Record<string, string>;
}

function completion(
  content: unknown,
  usage?: { prompt_tokens: number; completion_tokens: number },
) {
  return {
    choices: [{ message: { content: JSON.stringify(content) } }],
    ...(usage ? { usage } : {}),
  };
}

const answer = {
  description: '二人がUSJ入口に到着し喜んでいる',
  event_type: 'arrival',
  entities: { people: [], places: ['USJ'], objects: [], topics: ['arrival'] },
  affect: { excitement: 0.9 },
  confidence: 0.8,
};

describe('the context model over an OpenAI-compatible endpoint', () => {
  it('asks for JSON against a schema, at temperature zero', async () => {
    // Free-form prose would have to be parsed out of a paragraph, and a model
    // that answers differently each time cannot be cached or compared.
    const fetchImpl = reply(completion(answer));
    const model = new OpenAiCompatibleContextModel({
      baseUrl: 'http://localhost:1234/v1',
      model: 'test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await model.describe(params);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://localhost:1234/v1/chat/completions');
    const body = bodyOf(init);
    expect(body.temperature).toBe(0);
    expect(body.response_format).toMatchObject({ type: 'json_schema' });
  });

  it('sends the key only when there is one', async () => {
    const withKey = reply(completion(answer));
    await new OpenAiCompatibleContextModel({
      baseUrl: 'https://api.example.com/v1',
      model: 'test',
      apiKey: 'sk-secret',
      fetchImpl: withKey as unknown as typeof fetch,
    }).describe(params);
    expect(headersOf(withKey).authorization).toBe('Bearer sk-secret');

    const without = reply(completion(answer));
    await new OpenAiCompatibleContextModel({
      baseUrl: 'http://localhost:1234/v1',
      model: 'test',
      fetchImpl: without as unknown as typeof fetch,
    }).describe(params);
    expect(headersOf(without).authorization).toBeUndefined();
  });

  it('says frames leave the machine for a remote endpoint, and not for a local one', () => {
    // The privacy report is built from this, and it is inferred from the URL
    // rather than declared — so it is worth checking that the inference is right
    // for the hosts people actually use.
    const remote = (baseUrl: string) =>
      new OpenAiCompatibleContextModel({ baseUrl, model: 'test' }).identity;

    for (const local of [
      'http://localhost:1234/v1',
      'http://127.0.0.1:8080/v1',
      'http://[::1]:11434/v1',
    ]) {
      expect(remote(local).mediaLeavesDevice).toBe(false);
      expect(remote(local).locality).toBe('local');
    }
    for (const away of [
      'https://api.openai.com/v1',
      'https://example.com/v1',
      'http://10.0.0.2/v1',
    ]) {
      expect(remote(away).mediaLeavesDevice).toBe(true);
      expect(remote(away).locality).toBe('remote_api');
    }
  });

  it('believes an explicit answer over the URL', () => {
    // A tunnel or a reverse proxy to a hosted model looks local and is not.
    const identity = new OpenAiCompatibleContextModel({
      baseUrl: 'http://localhost:9999/v1',
      model: 'test',
      remote: true,
    }).identity;
    expect(identity.mediaLeavesDevice).toBe(true);
  });

  it('reports the status when the endpoint refuses', async () => {
    const fetchImpl = reply('over quota', { status: 429 });
    const model = new OpenAiCompatibleContextModel({
      baseUrl: 'https://api.example.com/v1',
      model: 'test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(model.describe(params)).rejects.toThrow(/429/);
  });

  it('says so when the model answers with prose instead of JSON', async () => {
    const fetchImpl = reply({ choices: [{ message: { content: 'Sure! Here is the event:' } }] });
    const model = new OpenAiCompatibleContextModel({
      baseUrl: 'https://api.example.com/v1',
      model: 'test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(model.describe(params)).rejects.toThrow(/did not return JSON/);
  });

  it('says so when the JSON is not the shape that was asked for', async () => {
    // A description is the one thing this call exists to produce.
    const fetchImpl = reply(completion({ event_type: 'arrival', confidence: 0.9 }));
    const model = new OpenAiCompatibleContextModel({
      baseUrl: 'https://api.example.com/v1',
      model: 'test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(model.describe(params)).rejects.toThrow(/did not match the schema/);
  });

  it('fills in the rest rather than rejecting a good description over a missing field', async () => {
    // Deliberate leniency, and worth pinning down: throwing away a usable
    // description because the model omitted `entities` would be the worse
    // failure. A missing confidence becomes a middling one rather than a
    // confident one — the escalation policy ranks on it, and a silence must not
    // read as certainty.
    const fetchImpl = reply(completion({ description: '二人が到着した' }));
    const model = new OpenAiCompatibleContextModel({
      baseUrl: 'https://api.example.com/v1',
      model: 'test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await model.describe(params);
    expect(result.description).toBe('二人が到着した');
    expect(result.confidence).toBeLessThanOrEqual(0.5);
    expect(result.entities.people).toEqual([]);
  });

  it('says so when the reply carries no content at all', async () => {
    const fetchImpl = reply({ choices: [] });
    const model = new OpenAiCompatibleContextModel({
      baseUrl: 'https://api.example.com/v1',
      model: 'test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(model.describe(params)).rejects.toThrow(/no content/);
  });

  it('carries the token counts through, so a run can be costed', async () => {
    const fetchImpl = reply(completion(answer, { prompt_tokens: 1200, completion_tokens: 80 }));
    const model = new OpenAiCompatibleContextModel({
      baseUrl: 'https://api.example.com/v1',
      model: 'test',
      pricing: { inputPerMillion: 0.3, outputPerMillion: 1.2 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await model.describe(params);
    expect(result.input_tokens).toBe(1200);
    expect(result.output_tokens).toBe(80);
    expect(model.estimateCost(1200, 80)).toBeCloseTo((1200 * 0.3 + 80 * 1.2) / 1_000_000, 12);
  });

  it('costs nothing when no prices were configured, rather than guessing', async () => {
    const model = new OpenAiCompatibleContextModel({ baseUrl: 'https://x/v1', model: 'test' });
    expect(model.estimateCost(1_000_000, 1_000_000)).toBe(0);
  });

  it('keeps confidence and affect inside the range the contract promises', async () => {
    const fetchImpl = reply(
      completion({ ...answer, confidence: 3, affect: { excitement: 9, calm: -2 } }),
    );
    const model = new OpenAiCompatibleContextModel({
      baseUrl: 'https://api.example.com/v1',
      model: 'test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await model.describe(params);
    expect(result.confidence).toBe(1);
    for (const value of Object.values(result.affect)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe('buildPrompt', () => {
  it('puts the user’s background in, and says it outranks the pictures', () => {
    const prompt = buildPrompt(params);
    expect(prompt).toContain('交際1周年旅行');
    expect(prompt).toContain('やっと着いた！');
    expect(prompt).toContain('UNIVERSAL STUDIOS JAPAN');
  });

  it('leaves out the sections there is nothing to say for', () => {
    const bare = buildPrompt({ ...params, ocr: [], audio_tags: [], user_context: {} });
    expect(bare).not.toContain('Text on screen');
    expect(bare).not.toContain('Background');
  });
});

describe('the text embedding over an OpenAI-compatible endpoint', () => {
  it('learns its width from the first answer, since providers do not all declare it', async () => {
    const fetchImpl = reply({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    const model = new OpenAiCompatibleTextEmbedding({
      baseUrl: 'http://localhost:1234/v1',
      model: 'embed',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(model.dim).toBe(0);
    const vectors = await model.embed(['一つ']);
    expect(vectors[0]).toHaveLength(3);
    expect(model.dim).toBe(3);
  });

  it('splits a long list into batches rather than one enormous request', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = bodyOf(init) as unknown as { input: string[] };
      return new Response(JSON.stringify({ data: body.input.map(() => ({ embedding: [1, 0] })) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const model = new OpenAiCompatibleTextEmbedding({
      baseUrl: 'http://localhost:1234/v1',
      model: 'embed',
      batchSize: 4,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const vectors = await model.embed(Array.from({ length: 10 }, (_, i) => `text ${i}`));
    expect(vectors).toHaveLength(10);
    expect(fetchImpl.mock.calls.length).toBe(3);
  });

  it('asks for nothing when given nothing', async () => {
    const fetchImpl = reply({ data: [] });
    const model = new OpenAiCompatibleTextEmbedding({
      baseUrl: 'http://localhost:1234/v1',
      model: 'embed',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await model.embed([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports the status when the endpoint refuses', async () => {
    const fetchImpl = reply('nope', { status: 401 });
    const model = new OpenAiCompatibleTextEmbedding({
      baseUrl: 'https://api.example.com/v1',
      model: 'embed',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(model.embed(['x'])).rejects.toThrow(/401/);
  });

  it('is not lexical, so retrieval keeps its zero-overlap matches', () => {
    // The opposite of the hashing encoder: finding "night view" for 夜景 with
    // nothing in common is the entire reason to configure one of these.
    const model: TextEmbeddingModel = new OpenAiCompatibleTextEmbedding({
      baseUrl: 'https://x/v1',
      model: 'embed',
    });
    expect(model.lexical).toBeUndefined();
  });
});
