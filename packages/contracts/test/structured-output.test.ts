import { describe, expect, it } from 'vitest';
import {
  extractJson,
  rejectsResponseFormat,
  responseFormatFor,
  schemaInstruction,
  weakerMode,
} from '../src/structured-output.js';

/**
 * Asking a chat model for JSON on servers that disagree about how to ask.
 *
 * The literal failure this exists for, from llama.cpp's own server:
 *
 *     {'loc': ('body', 'response_format', 'type'),
 *      'msg': "Input should be 'text' or 'json_object'", 'input': 'json_schema'}
 *
 * — HTTP 500, on every call, which made the documented local path produce a
 * template for every description and the rules for every judgement.
 */
const LLAMA_CPP_BODY =
  `{"error":{"message":"1 validation error:\\n  {'type': 'literal_error', ` +
  `'loc': ('body', 'response_format', 'type'), 'msg': \\"Input should be 'text' ` +
  `or 'json_object'\\", 'input': 'json_schema'}","type":"internal_server_error"}}`;

describe('deciding how to ask', () => {
  it('asks for a schema first, because that is the only mode that constrains generation', () => {
    const format = responseFormatFor('json_schema', 'semantic_event', { type: 'object' });
    expect(format).toEqual({
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'semantic_event', strict: true, schema: { type: 'object' } },
      },
    });
  });

  it('falls to json_object before giving up, because that is a real guarantee', () => {
    expect(weakerMode('json_schema')).toBe('json_object');
    expect(responseFormatFor('json_object', 'x', {})).toEqual({
      response_format: { type: 'json_object' },
    });
  });

  it('sends no response_format at all once there is nothing left to ask for', () => {
    expect(weakerMode('json_object')).toBe('none');
    expect(responseFormatFor('none', 'x', {})).toBeUndefined();
    expect(weakerMode('none')).toBeUndefined();
  });
});

describe('recognising a server that rejects the question', () => {
  it('recognises llama.cpp, verbatim', () => {
    expect(rejectsResponseFormat(500, LLAMA_CPP_BODY)).toBe(true);
  });

  it('recognises a plain 400 that names the parameter', () => {
    expect(rejectsResponseFormat(400, 'response_format is not supported')).toBe(true);
    expect(rejectsResponseFormat(422, "unknown field 'json_schema'")).toBe(true);
  });

  it('does not downgrade on a failure that is about the answer', () => {
    // This is the part that matters. Retrying a timeout, a rate limit or a
    // refusal with a weaker request just gets a worse answer more slowly, and
    // permanently, since the mode is remembered.
    expect(rejectsResponseFormat(429, 'rate limit exceeded')).toBe(false);
    expect(rejectsResponseFormat(500, 'internal error')).toBe(false);
    expect(rejectsResponseFormat(503, 'response_format')).toBe(false);
    expect(rejectsResponseFormat(200, 'response_format')).toBe(false);
    expect(rejectsResponseFormat(400, 'context length exceeded')).toBe(false);
  });
});

describe('reading JSON back out', () => {
  it('reads a plain object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('reads one inside a code fence, which is what a small model does', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('reads one with a sentence in front of it', () => {
    expect(extractJson('Sure! Here is the object:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
  });

  it('returns nothing rather than throwing, so the caller decides', () => {
    expect(extractJson('I am afraid I cannot do that')).toBeUndefined();
    expect(extractJson('')).toBeUndefined();
  });

  it('does not accept a bare scalar as an object', () => {
    // `JSON.parse("4")` succeeds, and a 4 is not an answer.
    expect(extractJson('4')).toBeUndefined();
    expect(extractJson('"hello"')).toBeUndefined();
    expect(extractJson('null')).toBeUndefined();
  });

  it('puts the schema in the prompt for the modes that cannot enforce it', () => {
    const instruction = schemaInstruction({ type: 'object', required: ['description'] });
    expect(instruction).toContain('single JSON object');
    expect(instruction).toContain('"description"');
  });
});
