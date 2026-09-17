/**
 * Asking a chat model for JSON, on servers that disagree about how to ask.
 *
 * "OpenAI-compatible" describes the URL and the message shape. It does not
 * describe structured output, and that is where the compatibility runs out.
 *
 * Measured against llama.cpp's own server, which is one of the most common ways
 * to run a model locally:
 *
 *     {'loc': ('body', 'response_format', 'type'),
 *      'msg': "Input should be 'text' or 'json_object'", 'input': 'json_schema'}
 *
 * — an HTTP 500 on every call. So the path this project documents as the way to
 * run without a hosted provider did not work on llama.cpp at all: every
 * description fell back to a template and every judgement to the rules.
 *
 * The three modes, in order of how much they give:
 *
 * - `json_schema` constrains generation to the schema. OpenAI, vLLM, LM Studio
 *   and recent Ollama.
 * - `json_object` guarantees syntactically valid JSON and nothing about its
 *   shape, so the schema has to go in the prompt and the result has to be
 *   validated. llama.cpp, older Ollama.
 * - `none` for servers that reject `response_format` outright; ask in the
 *   prompt and hope, which is what a small model will half-do anyway.
 *
 * Which one a server supports is discovered by trying, once, and remembering.
 * There is no capability endpoint to ask.
 */

export const STRUCTURED_MODES = ['json_schema', 'json_object', 'none'] as const;
export type StructuredMode = (typeof STRUCTURED_MODES)[number];

/** The `response_format` for a mode, or nothing when the server wants none. */
export function responseFormatFor(
  mode: StructuredMode,
  name: string,
  schema: unknown,
): Record<string, unknown> | undefined {
  if (mode === 'json_schema') {
    return {
      response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
    };
  }
  if (mode === 'json_object') return { response_format: { type: 'json_object' } };
  return undefined;
}

/**
 * The next mode to try, or nothing when there is nothing left.
 *
 * Downgrades one step at a time rather than jumping to `none`, because the
 * middle mode is a real guarantee — valid JSON — and giving it up because the
 * strictest one was refused would throw away the thing most small servers
 * actually support.
 */
export function weakerMode(mode: StructuredMode): StructuredMode | undefined {
  if (mode === 'json_schema') return 'json_object';
  if (mode === 'json_object') return 'none';
  return undefined;
}

/**
 * Whether a failure is the server rejecting how the question was asked.
 *
 * Deliberately narrow. A timeout, a refusal, a model that is simply wrong — all
 * of those must keep failing, because retrying them with a weaker request just
 * gets a worse answer more slowly. What is being matched here is a server
 * saying it does not know this parameter.
 */
export function rejectsResponseFormat(status: number, body: string): boolean {
  // A 500 counts, unfortunately: llama.cpp answers a validation error with one.
  if (status !== 400 && status !== 404 && status !== 422 && status !== 500) return false;
  const text = body.toLowerCase();
  if (!text.includes('response_format') && !text.includes('json_schema')) return false;
  return (
    text.includes('json_schema') ||
    text.includes('response_format') ||
    text.includes('not supported') ||
    text.includes('unsupported')
  );
}

/**
 * The schema, written into the prompt, for the modes that cannot enforce it.
 *
 * Only worth adding when the server is not constraining generation — under
 * `json_schema` it is duplication that costs context and buys nothing.
 */
export function schemaInstruction(schema: unknown): string {
  return [
    'Answer with a single JSON object and nothing else.',
    'No markdown fence, no explanation, no text before or after it.',
    'It must match this JSON Schema exactly:',
    JSON.stringify(schema),
  ].join('\n');
}

/**
 * JSON out of a reply that may be wrapped in prose or a code fence.
 *
 * Needed for the weaker modes: a small model told to answer in JSON will often
 * answer in JSON inside a ```json block, or with a sentence in front of it.
 * Returns undefined rather than throwing, so the caller decides whether a
 * failure here costs the stage.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) candidates.push(fence[1].trim());

  // The outermost braces, for a reply with commentary around the object.
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === 'object') return parsed;
    } catch {
      continue;
    }
  }
  return undefined;
}
