import { describe, expect, it, vi } from 'vitest';
import { SkillRegistry } from '@editorial-ir/skills';
import { AgentToolkit, LlmEditingAgent } from '../src/index.js';
import { makeIR } from '../../../tests/support/ir.js';

/**
 * The agent is tested against a scripted model.
 *
 * What matters is not what a particular model says; it is that whatever it says
 * goes through the planner and the validator, and that the user's instructions
 * survive it.
 */
const ir = makeIR({
  occasion: '交際1周年旅行',
  targetDurationMs: 60_000,
  events: [
    { description: '出発', event_type: 'departure', metrics: { story_importance: 0.4 } },
    { description: 'ラーメンを食べている', event_type: 'meal', metrics: { story_importance: 0.5 } },
    { description: 'もう一杯ラーメン', event_type: 'meal', metrics: { story_importance: 0.45 } },
    {
      description: '夜景',
      event_type: 'moment',
      metrics: { story_importance: 0.7 },
      affect: { intimacy: 0.9 },
    },
    { description: 'また来ようね', event_type: 'farewell', metrics: { story_importance: 0.8 } },
  ],
});

const skill = SkillRegistry.withBuiltIns().resolve('travel-vlog');

/** The JSON body of the first request the scripted model received. */
function requestBody(fetchImpl: { mock: { calls: unknown[][] } }): string {
  const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
  return typeof init?.body === 'string' ? init.body : '{}';
}

/** A model that makes the given tool calls, one response per turn. */
function scriptedModel(turns: { name: string; args: unknown }[][]) {
  let turn = 0;
  return vi.fn(async () => {
    const calls = turns[turn++] ?? [];
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              tool_calls: calls.map((call, index) => ({
                id: `call_${turn}_${index}`,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              })),
            },
          },
        ],
        usage: { prompt_tokens: 500, completion_tokens: 40 },
      }),
      { status: 200 },
    );
  });
}

function makeAgent(turns: { name: string; args: unknown }[][]) {
  const fetchImpl = scriptedModel(turns);
  const agent = new LlmEditingAgent(new AgentToolkit(ir), {
    baseUrl: 'http://localhost:11434/v1',
    model: 'test',
    fetchImpl: fetchImpl,
  });
  return { agent, fetchImpl };
}

describe('LlmEditingAgent', () => {
  it('looks before it proposes, and the proposal shapes the cut', async () => {
    const { agent } = makeAgent([
      [{ name: 'list_events', args: { limit: 10 } }],
      [
        {
          name: 'propose_edit',
          args: {
            keep: ['evt_0004', 'evt_0005'],
            drop: ['evt_0003'],
            emphasise: [{ event_id: 'evt_0004', reason: 'the night view is what this is about' }],
            reasoning: 'One meal is enough; the ending is the night view.',
          },
        },
      ],
    ]);

    const result = await agent.plan({
      instruction: 'a minute, ending on the night view',
      skill,
      targetDurationMs: 60_000,
    });

    expect(result.steps.map((step) => step.tool)).toEqual(['list_events']);
    expect(result.proposal.reasoning).toContain('One meal');

    const events = result.plan.tracks.video.map((operation) => operation.event_id);
    expect(events).toContain('evt_0004');
    expect(events).toContain('evt_0005');
    // The second bowl of ramen is out, because the agent said so.
    expect(events).not.toContain('evt_0003');
  });

  it('produces a plan that validates, whatever the model asked for', async () => {
    const { agent } = makeAgent([
      [
        {
          name: 'propose_edit',
          args: {
            // Nonsense: ids that do not exist, and everything at once.
            keep: ['evt_9999', 'evt_0001', 'evt_0002', 'evt_0003', 'evt_0004', 'evt_0005'],
            drop: ['evt_8888'],
            emphasise: [],
            reasoning: 'keep it all',
          },
        },
      ],
    ]);

    const result = await agent.plan({ instruction: 'everything', skill, targetDurationMs: 60_000 });
    expect(result.plan.tracks.video.length).toBeGreaterThan(0);
    // The planner still owns feasibility.
    expect(result.plan.stats.duration_error_ms).toBeLessThan(60_000);
  });

  it('cannot drop an event the user marked essential', async () => {
    const withEssential = makeIR({
      targetDurationMs: 60_000,
      events: [
        { description: '出発', metrics: { story_importance: 0.4 } },
        { description: 'どうでもいい映像', essential: true, metrics: { story_importance: 0.05 } },
        { description: 'また来ようね', metrics: { story_importance: 0.8 } },
      ],
    });

    const fetchImpl = scriptedModel([
      [
        {
          name: 'propose_edit',
          args: { keep: [], drop: ['evt_0002'], emphasise: [], reasoning: 'boring' },
        },
      ],
    ]);
    const agent = new LlmEditingAgent(new AgentToolkit(withEssential), {
      baseUrl: 'http://localhost:11434/v1',
      model: 'test',
      fetchImpl: fetchImpl,
    });

    const result = await agent.plan({ instruction: 'a minute', skill, targetDurationMs: 60_000 });
    // The user outranks the agent, and the validator would have caught it anyway.
    expect(result.plan.tracks.video.map((o) => o.event_id)).toContain('evt_0002');
  });

  it('falls back to the deterministic plan when the model never proposes', async () => {
    const { agent, fetchImpl } = makeAgent([
      [{ name: 'list_chapters', args: {} }],
      [{ name: 'list_chapters', args: {} }],
      [{ name: 'list_chapters', args: {} }],
    ]);

    const result = await agent.plan({
      instruction: 'a minute',
      skill,
      targetDurationMs: 60_000,
    });

    // A worse answer than the agent's, and a much better one than none.
    expect(result.plan.tracks.video.length).toBeGreaterThan(0);
    expect(result.proposal.reasoning).toContain('did not converge');
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('does not offer the model the planning tools', async () => {
    const { agent, fetchImpl } = makeAgent([
      [{ name: 'propose_edit', args: { keep: [], drop: [], emphasise: [], reasoning: '' } }],
    ]);
    await agent.plan({ instruction: 'x', skill, targetDurationMs: 60_000 });

    const body = JSON.parse(requestBody(fetchImpl));
    const offered = body.tools.map((tool: { function: { name: string } }) => tool.function.name);
    expect(offered).toContain('search');
    expect(offered).toContain('propose_edit');
    // Planning and validation are the planner's job, not the model's.
    expect(offered).not.toContain('create_edit_plan');
    expect(offered).not.toContain('validate_edit_plan');
  });

  it('tells the model what the user said, in their words', async () => {
    const { agent, fetchImpl } = makeAgent([
      [{ name: 'propose_edit', args: { keep: [], drop: [], emphasise: [], reasoning: '' } }],
    ]);
    await agent.plan({
      instruction: '食事は全部見せる必要はない',
      skill,
      targetDurationMs: 60_000,
    });

    const body = JSON.parse(requestBody(fetchImpl));
    const opening = body.messages[1].content;
    expect(opening).toContain('食事は全部見せる必要はない');
    expect(opening).toContain('交際1周年旅行');
  });
});
