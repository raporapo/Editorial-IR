import {
  EditorialError,
  type EditPlan,
  type ObservationTimeline,
  type SkillManifest,
} from '@editorial-ir/contracts';
import { AGENT_TOOL_DEFINITIONS, type AgentToolkit } from './toolkit.js';
import type { PlanOverrides } from './planner.js';

/**
 * A model-driven editing agent.
 *
 * It does not write the cut. It reads the Editorial IR through the same toolkit
 * anything else would use — list, search, inspect, compare — and then says which
 * moments matter for *this* request and which do not. The deterministic planner
 * turns that into a plan, and the validator checks it.
 *
 * That division is the point. A language model is good at "the meals do not all
 * need to be shown, and the thing about the year going quickly is the ending"
 * and bad at "and the result must be 180 seconds plus or minus 15 with no two
 * clips sharing a frame". Asking it to do both produces a plan that is usually
 * feasible, and the planner produces one that always is.
 *
 * Nothing here is required. The deterministic planner is the default path and
 * every test runs on it; this is what you reach for when a request has intent in
 * it that a skill file cannot express.
 */
export interface LlmAgentOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Most tool round trips before giving up and planning with what it has. */
  maxSteps?: number;
  temperature?: number;
  timeoutMs?: number;
  /** Called for each tool the model uses, for showing work. */
  onStep?: (step: AgentStep) => void;
  fetchImpl?: typeof fetch;
}

export interface AgentStep {
  index: number;
  tool: string;
  arguments: Record<string, unknown>;
  /** A short description of what came back, not the whole payload. */
  summary: string;
}

export interface AgentRequest {
  /** What the user asked for, in their words. */
  instruction: string;
  skill: SkillManifest;
  targetDurationMs: number;
  observations?: ObservationTimeline;
}

export interface AgentResult {
  plan: EditPlan;
  /** What the agent decided, and why. */
  proposal: EditProposal;
  steps: AgentStep[];
  inputTokens: number;
  outputTokens: number;
}

export interface EditProposal {
  keep: string[];
  drop: string[];
  emphasise: { event_id: string; reason: string }[];
  reasoning: string;
}

const PROPOSE = 'propose_edit';

const PROPOSE_TOOL = {
  name: PROPOSE,
  description:
    'Say which moments matter for this request and which do not. The planner decides the final ' +
    'lengths and keeps the piece on target; you decide what it is about.',
  parameters: {
    type: 'object',
    properties: {
      keep: {
        type: 'array',
        items: { type: 'string' },
        description: 'Event ids that should survive into the cut if at all possible.',
      },
      drop: {
        type: 'array',
        items: { type: 'string' },
        description: 'Event ids that should not appear, even though the skill would take them.',
      },
      emphasise: {
        type: 'array',
        description: 'Moments worth more time than their score suggests, with a reason.',
        items: {
          type: 'object',
          properties: { event_id: { type: 'string' }, reason: { type: 'string' } },
          required: ['event_id', 'reason'],
          additionalProperties: false,
        },
      },
      reasoning: { type: 'string', description: 'Two or three sentences on the shape you chose.' },
    },
    required: ['keep', 'drop', 'emphasise', 'reasoning'],
    additionalProperties: false,
  },
} as const;

const SYSTEM_PROMPT = [
  'You are choosing what goes into an edit, from an analysis of the footage.',
  'You cannot see the video. You can list events, search them, look closer at one, and compare several.',
  'Work coarsely first: read the chapters, then the events, and only inspect one when the summary was not enough.',
  'You are not deciding lengths or order. A planner does that, keeps the piece on target and honours what',
  'the user marked essential. Your job is which moments this particular request is about.',
  'When you know, call propose_edit. Do not call it before you have looked.',
].join(' ');

export class LlmEditingAgent {
  constructor(
    private readonly toolkit: AgentToolkit,
    private readonly options: LlmAgentOptions,
  ) {}

  async plan(request: AgentRequest): Promise<AgentResult> {
    const steps: AgentStep[] = [];
    const messages: unknown[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: this.openingMessage(request) },
    ];

    const tools = [...AGENT_TOOL_DEFINITIONS, PROPOSE_TOOL]
      // The planning tools are the planner's job, not the model's.
      .filter((tool) => tool.name !== 'create_edit_plan' && tool.name !== 'validate_edit_plan')
      .map((tool) => ({ type: 'function', function: tool }));

    let inputTokens = 0;
    let outputTokens = 0;
    const maxSteps = this.options.maxSteps ?? 12;

    for (let step = 0; step < maxSteps; step++) {
      const response = await this.call(messages, tools);
      inputTokens += response.inputTokens;
      outputTokens += response.outputTokens;

      const calls = response.toolCalls;
      if (calls.length === 0) {
        // A model that stops calling tools without proposing has run out of
        // ideas; planning with what it found beats failing the request.
        break;
      }

      messages.push(response.message);

      for (const call of calls) {
        if (call.name === PROPOSE) {
          const proposal = parseProposal(call.arguments);
          return {
            plan: this.build(request, proposal),
            proposal,
            steps,
            inputTokens,
            outputTokens,
          };
        }

        const result = await this.runTool(call.name, call.arguments);
        const entry: AgentStep = {
          index: steps.length,
          tool: call.name,
          arguments: call.arguments,
          summary: summarise(result),
        };
        steps.push(entry);
        this.options.onStep?.(entry);

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result).slice(0, 12_000),
        });
      }
    }

    // Out of steps without a proposal: fall back to the deterministic plan,
    // which is a worse answer than the agent's and a much better one than none.
    const empty: EditProposal = {
      keep: [],
      drop: [],
      emphasise: [],
      reasoning: 'the agent did not converge',
    };
    return { plan: this.build(request, empty), proposal: empty, steps, inputTokens, outputTokens };
  }

  private build(request: AgentRequest, proposal: EditProposal): EditPlan {
    // Models invent event ids. The planner refuses one it does not recognise,
    // and rightly so for a person typing a command — but here that would throw
    // away a whole run of tool calls over one bad character in one id. Drop the
    // ids that do not exist and plan with the rest.
    const real = new Set(this.toolkit.listEvents().map((event) => event.id));
    const exists = (id: string): boolean => real.has(id);
    const emphasise = proposal.emphasise.filter((item) => exists(item.event_id));

    const overrides: PlanOverrides = {
      require: proposal.keep.filter(exists),
      drop: proposal.drop.filter(exists),
      boost: Object.fromEntries(emphasise.map((item) => [item.event_id, 0.25])),
      reasons: Object.fromEntries(emphasise.map((item) => [item.event_id, item.reason])),
    };

    const plan = this.toolkit.createEditPlan({
      skill: request.skill,
      targetDurationMs: request.targetDurationMs,
      ...(request.observations ? { observations: request.observations } : {}),
      overrides,
    });

    // Whatever the model asked for, the result goes through the same gate as
    // everything else.
    const report = this.toolkit.validateEditPlan(plan);
    if (!report.ok) {
      throw new EditorialError('plan_invalid', 'the plan the agent asked for did not validate', {
        issues: report.issues
          .filter((issue) => issue.severity === 'error')
          .map((issue) => issue.message),
      });
    }
    return plan;
  }

  private openingMessage(request: AgentRequest): string {
    const context = this.toolkit.getProjectContext();
    const chapters = this.toolkit.listChapters();

    return [
      `The user asked: ${request.instruction}`,
      '',
      `Target length: ${Math.round(request.targetDurationMs / 1000)} seconds.`,
      `Style: ${request.skill.name} — ${request.skill.description}`,
      '',
      'What they told us about the footage:',
      JSON.stringify(
        {
          title: context.title,
          occasion: context.background.occasion,
          people: context.background.people.map((person) => `${person.id} (${person.role ?? ''})`),
          tone: context.editing_goal.tone,
          instruction: context.editing_goal.instruction,
        },
        null,
        2,
      ),
      '',
      `${context.event_count} events in ${chapters.length} chapters:`,
      ...chapters.map(
        (chapter) => `  ${chapter.id} ${chapter.title.value} — ${chapter.event_ids.length} events`,
      ),
    ].join('\n');
  }

  private async runTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'get_project_context':
        return this.toolkit.getProjectContext();
      case 'list_chapters':
        return this.toolkit.listChapters();
      case 'list_events':
        return this.toolkit.listEvents({ limit: 60, ...(args as object) });
      case 'inspect_event':
        return this.toolkit.inspectEvent(
          String(args.eventId),
          (args.detail as 'summary' | 'detailed' | 'full') ?? 'detailed',
        );
      case 'get_neighbours':
        return this.toolkit.getNeighbours(String(args.eventId));
      case 'compare_events':
        return this.toolkit.compareEvents((args.eventIds as string[]) ?? []);
      case 'search': {
        const query = typeof args.query === 'string' ? args.query : '';
        const limit = typeof args.limit === 'number' ? args.limit : 8;
        const aspect = args.aspect;
        if (typeof aspect === 'string' && aspect !== 'any') {
          switch (aspect) {
            case 'visual':
              return this.toolkit.searchVisual(query, limit);
            case 'speech':
              return this.toolkit.searchSpeech(query, limit);
            case 'event':
              return this.toolkit.searchEvent(query, limit);
            case 'context':
              return this.toolkit.searchContext(query, limit);
            case 'mood':
              return this.toolkit.searchMood(query, limit);
            default:
              break;
          }
        }
        return this.toolkit.search(query, limit);
      }
      default:
        return { error: `there is no tool called ${name}` };
    }
  }

  private async call(
    messages: unknown[],
    tools: unknown[],
  ): Promise<{
    message: unknown;
    toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[];
    inputTokens: number;
    outputTokens: number;
  }> {
    const doFetch = this.options.fetchImpl ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 120_000);

    try {
      const response = await doFetch(
        `${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: this.options.model,
            temperature: this.options.temperature ?? 0,
            messages,
            tools,
            tool_choice: 'auto',
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new EditorialError('decision_failed', `the agent model returned ${response.status}`, {
          body: (await response.text()).slice(0, 500),
        });
      }

      const payload = (await response.json()) as {
        choices?: {
          message?: {
            tool_calls?: { id: string; function?: { name?: string; arguments?: string } }[];
          };
        }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const message = payload.choices?.[0]?.message ?? {};
      const toolCalls = (message.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function?.name ?? '',
        arguments: safeParse(call.function?.arguments),
      }));

      return {
        message,
        toolCalls,
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseProposal(args: Record<string, unknown>): EditProposal {
  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

  const emphasise = Array.isArray(args.emphasise)
    ? args.emphasise
        .filter((item): item is { event_id: string; reason: string } => {
          return (
            typeof item === 'object' &&
            item !== null &&
            typeof (item as { event_id?: unknown }).event_id === 'string'
          );
        })
        .map((item) => ({ event_id: item.event_id, reason: String(item.reason ?? '') }))
    : [];

  return {
    keep: list(args.keep),
    drop: list(args.drop),
    emphasise,
    reasoning: typeof args.reasoning === 'string' ? args.reasoning : '',
  };
}

function safeParse(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A short description of a tool result, for showing the agent's working. */
function summarise(result: unknown): string {
  if (Array.isArray(result)) return `${result.length} item(s)`;
  if (result && typeof result === 'object') {
    const id =
      (result as { id?: unknown; event_id?: unknown }).id ??
      (result as { event_id?: unknown }).event_id;
    return typeof id === 'string' ? id : `${Object.keys(result).length} field(s)`;
  }
  return String(result);
}
