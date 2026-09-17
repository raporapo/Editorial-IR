import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { z } from 'zod';
import {
  DescribeResult,
  EditorialError,
  extractJson,
  rejectsResponseFormat,
  responseFormatFor,
  schemaInstruction,
  weakerMode,
  type DescribeParams,
  type StructuredMode,
} from '@editorial-ir/contracts';
import type { ContextModel, ModelIdentity } from '../types.js';

/**
 * A vision-language model reached over the OpenAI chat-completions shape.
 *
 * One implementation covers both deployment stories, which is the whole point:
 * point it at `api.openai.com` and it is the bring-your-own-key path; point it
 * at `localhost:11434` or a vLLM server and it is the fully local path with a
 * 4B-class model inside a 16 GB card. The pipeline cannot tell the difference,
 * and no code path is privileged.
 *
 * Structured output is requested through a JSON schema. A model that returns
 * prose where a schema was requested is a failed call, not something to parse
 * hopefully with a regular expression.
 */
export interface OpenAiCompatibleContextOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Frames to attach. More frames cost more and rarely help past four. */
  maxFrames?: number;
  timeoutMs?: number;
  temperature?: number;
  remote?: boolean;
  /** Cost per million input/output tokens, for the run's cost report. */
  pricing?: { inputPerMillion: number; outputPerMillion: number };
  fetchImpl?: typeof fetch;
}

const LOCAL_HOST = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/;

/** The shape the model must return. Mirrors DescribeResult minus the bookkeeping. */
const DESCRIBE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    description: {
      type: 'string',
      description: 'One sentence describing what happens in this event.',
    },
    event_type: {
      type: 'string',
      description: 'A short lowercase kind such as arrival, meal, travel, reaction, explanation.',
    },
    title: { type: 'string', description: 'A short display title, at most six words.' },
    entities: {
      type: 'object',
      properties: {
        people: { type: 'array', items: { type: 'string' } },
        places: { type: 'array', items: { type: 'string' } },
        objects: { type: 'array', items: { type: 'string' } },
        topics: { type: 'array', items: { type: 'string' } },
      },
      required: ['people', 'places', 'objects', 'topics'],
      additionalProperties: false,
    },
    affect: {
      type: 'object',
      description: 'Named affect intensities between 0 and 1.',
      additionalProperties: { type: 'number' },
    },
    confidence: { type: 'number', description: 'How confident you are, between 0 and 1.' },
  },
  required: ['description', 'event_type', 'title', 'entities', 'affect', 'confidence'],
  additionalProperties: false,
} as const;

const ModelOutput = z.object({
  // Non-empty, because an empty one is not an answer.
  //
  // A small model on a real run returned well-formed JSON with
  // `"description": ""` for nine events out of eleven. Every layer accepted it:
  // the JSON parsed, the schema passed, the stage reported success, and the IR
  // came out claiming a full-strength analysis with nine blank descriptions in
  // it. Rejecting it here turns a silent hole into a stage failure, which the
  // compiler already knows how to fall back from and to report.
  description: z.string().trim().min(1),
  event_type: z.string().default(''),
  title: z.string().optional(),
  entities: z
    .object({
      people: z.array(z.string()).default([]),
      places: z.array(z.string()).default([]),
      objects: z.array(z.string()).default([]),
      topics: z.array(z.string()).default([]),
    })
    .prefault({}),
  affect: z.record(z.string(), z.number()).default({}),
  confidence: z.number().default(0.5),
});

export class OpenAiCompatibleContextModel implements ContextModel {
  readonly identity: ModelIdentity;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly maxFrames: number;
  private readonly timeoutMs: number;
  /** How this server wants to be asked for JSON. Discovered once, then kept. */
  private mode: StructuredMode = 'json_schema';
  private readonly temperature: number;
  private readonly pricing: { inputPerMillion: number; outputPerMillion: number } | undefined;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(options: OpenAiCompatibleContextOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.maxFrames = options.maxFrames ?? 4;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.temperature = options.temperature ?? 0;
    this.pricing = options.pricing;
    this.fetchImpl = options.fetchImpl;
    const remote = options.remote ?? !LOCAL_HOST.test(this.baseUrl);
    this.identity = {
      backend: 'openai-compatible',
      model: options.model,
      locality: remote ? 'remote_api' : 'local',
      // Frames are sent as images. On a remote endpoint that is media leaving
      // the machine, and the user is told so rather than finding out later.
      mediaLeavesDevice: remote,
      parameters: { base_url: this.baseUrl, model: options.model, max_frames: this.maxFrames },
    };
  }

  async describe(params: DescribeParams): Promise<DescribeResult> {
    const doFetch = this.fetchImpl ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await doFetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          temperature: this.temperature,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: this.userContent(params) },
            // Under the weaker modes the server is not constraining generation,
            // so the shape has to be asked for in words. Under `json_schema` it
            // would be duplication that costs context and buys nothing.
            ...(this.mode === 'json_schema'
              ? []
              : [{ role: 'user' as const, content: schemaInstruction(DESCRIBE_JSON_SCHEMA) }]),
          ],
          ...responseFormatFor(this.mode, 'semantic_event', DESCRIBE_JSON_SCHEMA),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = (await response.text()).slice(0, 500);
        // The server rejecting *how* it was asked, rather than failing to
        // answer. llama.cpp answers `json_schema` with a 500 and a validation
        // error naming the parameter, which made every description on the
        // commonest local server fall back to a template.
        const weaker = rejectsResponseFormat(response.status, body)
          ? weakerMode(this.mode)
          : undefined;
        if (weaker) {
          this.mode = weaker;
          clearTimeout(timer);
          return this.describe(params);
        }
        throw new EditorialError('perception_failed', `context model returned ${response.status}`, {
          status: response.status,
          body,
        });
      }

      const payload = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) {
        throw new EditorialError('perception_failed', 'context model returned no content');
      }

      const raw = extractJson(content);
      if (raw === undefined) {
        throw new EditorialError('perception_failed', 'context model did not return JSON', {
          content: content.slice(0, 300),
        });
      }

      const parsed = ModelOutput.safeParse(raw);
      if (!parsed.success) {
        throw new EditorialError(
          'perception_failed',
          'context model output did not match the schema',
          {
            issues: parsed.error.issues.slice(0, 5).map((i) => i.message),
          },
        );
      }

      return DescribeResult.parse({
        model: this.model,
        ...parsed.data,
        affect: clampAffect(parsed.data.affect),
        confidence: Math.min(1, Math.max(0, parsed.data.confidence)),
        ...(payload.usage?.prompt_tokens === undefined
          ? {}
          : { input_tokens: payload.usage.prompt_tokens }),
        ...(payload.usage?.completion_tokens === undefined
          ? {}
          : { output_tokens: payload.usage.completion_tokens }),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Estimated USD cost for one call, given token counts. */
  estimateCost(inputTokens = 0, outputTokens = 0): number {
    if (!this.pricing) return 0;
    return (
      (inputTokens * this.pricing.inputPerMillion + outputTokens * this.pricing.outputPerMillion) /
      1_000_000
    );
  }

  private userContent(params: DescribeParams): unknown[] {
    const content: unknown[] = [{ type: 'text', text: buildPrompt(params) }];
    for (const path of params.frame_paths.slice(0, this.maxFrames)) {
      content.push({ type: 'image_url', image_url: { url: toDataUrl(path) } });
    }
    return content;
  }
}

const SYSTEM_PROMPT = [
  'You describe one moment from a video so that an editor can reason about it later.',
  'Say what is happening, not what it means for the edit; another layer judges that.',
  'The user background you are given is knowledge you do not have. Use it, and never contradict it.',
  'If the frames and the background disagree, describe the frames and leave the background alone.',
  'Answer in the language of the transcript.',
].join(' ');

/** Exported so the prompt can be reviewed and tested rather than only observed in logs. */
export function buildPrompt(params: DescribeParams): string {
  const sections: string[] = [];
  if (Object.keys(params.user_context).length > 0) {
    sections.push(`Background the user provided:\n${JSON.stringify(params.user_context, null, 2)}`);
  }
  if (params.previous_summary) sections.push(`Previous event: ${params.previous_summary}`);
  if (params.transcript.length > 0) sections.push(`Speech:\n${params.transcript.join('\n')}`);
  if (params.ocr.length > 0) sections.push(`Text on screen:\n${params.ocr.join('\n')}`);
  if (params.audio_tags.length > 0) sections.push(`Sound: ${params.audio_tags.join(', ')}`);
  if (params.next_summary) sections.push(`Next event: ${params.next_summary}`);
  sections.push('Describe this event.');
  return sections.join('\n\n');
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export function toDataUrl(path: string): string {
  const mime = MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? 'image/jpeg';
  return `data:${mime};base64,${readFileSync(path).toString('base64')}`;
}

function clampAffect(affect: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(affect)) {
    if (Number.isFinite(value)) out[key] = Math.min(1, Math.max(0, value));
  }
  return out;
}
