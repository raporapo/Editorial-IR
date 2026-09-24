import {
  EditorialError,
  extractJson,
  rejectsResponseFormat,
  responseFormatFor,
  schemaInstruction,
  weakerMode,
  type StructuredMode,
  expectedUnitValue,
  type BooleanRequest,
  type BooleanResult,
  type ChoiceRequest,
  type ChoiceResult,
  type EventState,
  type ScoreRequest,
  type ScoreResult,
} from '@editorial-ir/contracts';
import type {
  BatchAnswers,
  BatchRequest,
  DecisionBackendIdentity,
  EditorialDecisionModel,
} from '../types.js';
import { normalise, prune, scoreFromUnit } from '../distribution.js';

/**
 * A decision backend built on any model that speaks OpenAI chat completions with
 * structured output.
 *
 * "Local system one" describes how it is used rather than where it runs: small,
 * fast, structured judgements over an already-understood event, not a second
 * pass over the video. An 8B model on a laptop and a hosted model behind a key
 * are the same code, and both answer the same questions with the same defined
 * levels, so their outputs are directly comparable.
 *
 * It answers the entire question set in one call. Nineteen separate round trips
 * per event, each re-sending the same context, is how a project like this
 * becomes too expensive to use on an hour of footage.
 */
export interface LocalSystemOneOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  temperature?: number;
  timeoutMs?: number;
  remote?: boolean;
  baseConfidence?: number;
  /** USD per million tokens, for the cost report. */
  pricing?: { inputPerMillion: number; outputPerMillion: number };
  fetchImpl?: typeof fetch;
}

const LOCAL_HOST = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/;

export class LocalSystemOneBackend implements EditorialDecisionModel {
  readonly identity: DecisionBackendIdentity;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  /**
   * How this server wants to be asked for JSON. Discovered by trying, because
   * there is no capability endpoint, and remembered so the discovery is paid
   * once rather than on every event.
   */
  private mode: StructuredMode = 'json_schema';
  private readonly pricing: { inputPerMillion: number; outputPerMillion: number } | undefined;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(options: LocalSystemOneOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.temperature = options.temperature ?? 0;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.pricing = options.pricing;
    this.fetchImpl = options.fetchImpl;
    const remote = options.remote ?? !LOCAL_HOST.test(this.baseUrl);
    this.identity = {
      backend: 'local-system-one',
      model: options.model,
      locality: remote ? 'remote_api' : 'local',
      // Only the structured event state is sent, never frames or audio. That is
      // a meaningful privacy difference from the context model and is reported
      // as such.
      mediaLeavesDevice: false,
      baseConfidence: options.baseConfidence ?? 0.7,
      parameters: { base_url: this.baseUrl, model: options.model },
    };
  }

  async assessAll(state: EventState, request: BatchRequest): Promise<BatchAnswers> {
    const schema = batchSchema(request);
    const payload = await this.call(
      { questions: buildBatchQuestions(request), moment: buildMomentSection(state) },
      schema,
      'editorial_assessment',
    );

    const raw = payload.content as Record<string, unknown>;
    const scores: Record<string, ScoreResult> = {};
    for (const question of request.scores) {
      const level = raw[question.question_id];
      if (typeof level !== 'number') continue;
      const clamped = Math.min(question.levels.length - 1, Math.max(0, Math.round(level)));
      scores[question.question_id] = scoreFromUnit(
        clamped / (question.levels.length - 1),
        question.levels.length,
        // The model named one level, so the distribution should say so.
        0.85,
      );
    }

    const booleans: Record<string, BooleanResult> = {};
    for (const question of request.booleans) {
      const probability = raw[question.question_id];
      if (typeof probability !== 'number') continue;
      booleans[question.question_id] = { probability: Math.min(1, Math.max(0, probability)) };
    }

    let choice: ChoiceResult | undefined;
    if (request.choice) {
      const answer = raw[request.choice.question_id];
      // A choice is a question with a closed set of answers, and whatever the
      // model says, an answer outside that set is not one of them.
      //
      // This was taken on trust. A 1B model answered the narrative-role
      // question with `opening_candidate`, `establishing_shot` and
      // `ending_candidate` — plausible words, none of them roles; it had
      // blended the role question with the boolean flags asked alongside it.
      // They went into the IR unchecked, and `oea analyze` finished by writing
      // a file that failed its own schema when the next command read it back.
      // Ten minutes of work, and nothing to show for it but a corrupt project.
      const selected = matchOption(answer, request.choice.options);
      if (selected !== undefined) {
        // One structured answer carries no distribution, so a peaked one is
        // synthesised rather than claiming certainty the model never expressed.
        const probabilities = prune(
          normalise(
            Object.fromEntries(
              request.choice.options.map((o) => [o.value, o.value === selected ? 8 : 1]),
            ),
          ),
        );
        choice = { selected, probabilities };
      }
    }

    const rationale = typeof raw.rationale === 'string' ? raw.rationale : undefined;

    return {
      scores,
      booleans,
      ...(choice ? { choice } : {}),
      ...(rationale ? { rationale } : {}),
      ...(payload.inputTokens === undefined ? {} : { inputTokens: payload.inputTokens }),
      ...(payload.outputTokens === undefined ? {} : { outputTokens: payload.outputTokens }),
      costUsd: this.estimateCost(payload.inputTokens ?? 0, payload.outputTokens ?? 0),
    };
  }

  async score(state: EventState, request: ScoreRequest): Promise<ScoreResult> {
    const answers = await this.assessAll(state, { scores: [request], booleans: [] });
    const result = answers.scores[request.question_id];
    if (!result)
      throw new EditorialError('decision_failed', `no answer for "${request.question_id}"`);
    return result;
  }

  async booleanProbability(state: EventState, request: BooleanRequest): Promise<BooleanResult> {
    const answers = await this.assessAll(state, { scores: [], booleans: [request] });
    const result = answers.booleans[request.question_id];
    if (!result)
      throw new EditorialError('decision_failed', `no answer for "${request.question_id}"`);
    return result;
  }

  async choice(state: EventState, request: ChoiceRequest): Promise<ChoiceResult> {
    const answers = await this.assessAll(state, { scores: [], booleans: [], choice: request });
    if (!answers.choice)
      throw new EditorialError('decision_failed', `no answer for "${request.question_id}"`);
    return answers.choice;
  }

  estimateCost(inputTokens: number, outputTokens: number): number {
    if (!this.pricing) return 0;
    return (
      (inputTokens * this.pricing.inputPerMillion + outputTokens * this.pricing.outputPerMillion) /
      1_000_000
    );
  }

  private async call(
    prompt: { questions: string; moment: string },
    schema: Record<string, unknown>,
    schemaName: string,
  ): Promise<{ content: unknown; inputTokens?: number; outputTokens?: number }> {
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
            {
              role: 'user',
              // Everything that is the same for every event first, the event
              // last. The question set is about 95% of this prompt and never
              // changes within a run, and providers cache a repeated prefix —
              // but only a prefix: with the event first, no two requests shared
              // more than the system line, and every judgement paid full price
              // for the same 1,400 tokens of questions.
              content:
                this.mode === 'json_schema'
                  ? `${prompt.questions}\n\n${prompt.moment}`
                  : `${prompt.questions}\n\n${schemaInstruction(schema)}\n\n${prompt.moment}`,
            },
          ],
          ...responseFormatFor(this.mode, schemaName, schema),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = (await response.text()).slice(0, 500);
        // The server does not know how the question was asked, rather than
        // being unable to answer it. Ask a simpler way, once per step, and
        // remember — llama.cpp rejects `json_schema` with a 500, so without
        // this the local path fails on one of the commonest local servers.
        const weaker = rejectsResponseFormat(response.status, body)
          ? weakerMode(this.mode)
          : undefined;
        if (weaker) {
          this.mode = weaker;
          clearTimeout(timer);
          return this.call(prompt, schema, schemaName);
        }
        throw new EditorialError('decision_failed', `decision model returned ${response.status}`, {
          status: response.status,
          body,
        });
      }

      const payload = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = payload.choices?.[0]?.message?.content;
      if (!text) throw new EditorialError('decision_failed', 'decision model returned no content');

      const content = extractJson(text);
      if (content === undefined) {
        throw new EditorialError('decision_failed', 'decision model did not return JSON', {
          content: text.slice(0, 300),
        });
      }
      {
        return {
          content,
          ...(payload.usage?.prompt_tokens === undefined
            ? {}
            : { inputTokens: payload.usage.prompt_tokens }),
          ...(payload.usage?.completion_tokens === undefined
            ? {}
            : { outputTokens: payload.usage.completion_tokens }),
        };
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

const SYSTEM_PROMPT = [
  'You judge how useful one moment of video is to an edit.',
  'You are given a structured description of the moment, not the video itself.',
  'Answer only with the requested fields.',
  'Each scale has written levels: pick the level whose description fits, not a number that feels right.',
  'Background the user supplied is knowledge you do not have. Weigh it; never contradict it.',
].join(' ');

/**
 * Exported so the prompt is reviewable and testable rather than only observable in logs.
 *
 * The questions come before the moment, and that order is the cost of the
 * stage: see {@link buildBatchQuestions}.
 */
export function buildBatchPrompt(state: EventState, request: BatchRequest): string {
  return `${buildBatchQuestions(request)}\n\n${buildMomentSection(state)}`;
}

/** The moment being judged: the only part of the prompt that changes between events. */
export function buildMomentSection(state: EventState): string {
  return ['## The moment', JSON.stringify(compactState(state), null, 2)].join('\n\n');
}

/**
 * The questions, identical for every event of a run.
 *
 * Measured, judgement sends twelve times the input tokens description does
 * (1,564 against 133 per event), and nearly all of it is this constant text.
 * Put first, it is a prefix a provider can cache and a local server can reuse
 * its computation for; put after the event, as it was, it was paid for in full
 * on every call.
 */
export function buildBatchQuestions(request: BatchRequest): string {
  const sections: string[] = ['Answer every question below about the moment described at the end.'];

  if (request.scores.length > 0) {
    sections.push('## Scales');
    for (const question of request.scores) {
      const levels = question.levels
        .map((l) => `  ${l.level} = ${l.label}: ${l.description}`)
        .join('\n');
      sections.push(`${question.question_id}: ${question.question}\n${levels}`);
    }
  }

  if (request.booleans.length > 0) {
    sections.push('## Statements (answer with a probability between 0 and 1)');
    for (const question of request.booleans) {
      sections.push(`${question.question_id}: ${question.statement}`);
    }
  }

  if (request.choice) {
    sections.push('## Choice');
    const options = request.choice.options.map((o) => `  ${o.value}: ${o.description}`).join('\n');
    sections.push(`${request.choice.question_id}: ${request.choice.question}\n${options}`);
  }

  return sections.join('\n\n');
}

/** Drops empty fields so a small model is not paying attention to blanks. */
function compactState(state: EventState): Record<string, unknown> {
  const compact: Record<string, unknown> = {
    duration_seconds: Math.round(state.duration_ms / 100) / 10,
    position_in_project: Math.round(state.relative_position * 100) / 100,
    description: state.semantic.description,
    event_type: state.semantic.event_type,
  };
  if (state.observed.speech.length > 0) compact.speech = state.observed.speech;
  if (state.observed.visual_labels.length > 0) compact.visible = state.observed.visual_labels;
  if (state.observed.ocr.length > 0) compact.text_on_screen = state.observed.ocr;
  if (state.observed.audio.length > 0) compact.sound = state.observed.audio;
  if (Object.keys(state.semantic.affect).length > 0) compact.affect = state.semantic.affect;
  if (state.semantic.entities.people.length > 0) compact.people = state.semantic.entities.people;
  if (state.semantic.entities.places.length > 0) compact.places = state.semantic.entities.places;
  if (state.previous_event) compact.previous_event = state.previous_event.description;
  if (state.next_event) compact.next_event = state.next_event.description;
  if (state.max_similarity_to_others !== undefined) {
    compact.similarity_to_other_moments = state.max_similarity_to_others;
  }
  const user: Record<string, unknown> = {};
  if (state.user_context.occasion) user.occasion = state.user_context.occasion;
  if (state.user_context.goal) user.goal = state.user_context.goal;
  if (state.user_context.tone.length > 0) user.tone = state.user_context.tone;
  if (state.user_context.notes.length > 0) user.notes = state.user_context.notes;
  if (state.user_context.essential) user.the_user_marked_this_essential = true;
  if (Object.keys(user).length > 0) compact.user_background = user;
  return compact;
}

/** Builds a strict JSON schema covering exactly the questions being asked. */
export function batchSchema(request: BatchRequest): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const question of request.scores) {
    properties[question.question_id] = {
      type: 'integer',
      minimum: 0,
      maximum: question.levels.length - 1,
      description: question.question,
    };
    required.push(question.question_id);
  }
  for (const question of request.booleans) {
    properties[question.question_id] = {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: question.statement,
    };
    required.push(question.question_id);
  }
  if (request.choice) {
    properties[request.choice.question_id] = {
      type: 'string',
      enum: request.choice.options.map((o) => o.value),
      description: request.choice.question,
    };
    required.push(request.choice.question_id);
  }
  properties.rationale = { type: 'string', description: 'One sentence explaining the judgement.' };
  required.push('rationale');

  return { type: 'object', properties, required, additionalProperties: false };
}

export { expectedUnitValue };

/**
 * The offered option a model's answer actually names, if any.
 *
 * Tolerant about spelling and nothing else: case and surrounding whitespace are
 * the model's formatting, while a word that is not on the list is a different
 * answer to a different question. Returning nothing leaves the caller with no
 * choice for this event, which the fallback already handles — and which is a
 * great deal better than writing it down.
 */
export function matchOption(
  answer: unknown,
  options: readonly { value: string }[],
): string | undefined {
  if (typeof answer !== 'string') return undefined;
  const cleaned = answer.trim().toLowerCase();
  if (cleaned.length === 0) return undefined;
  return options.find((option) => option.value.toLowerCase() === cleaned)?.value;
}
