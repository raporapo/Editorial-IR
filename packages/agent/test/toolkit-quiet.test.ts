import { describe, expect, it } from 'vitest';
import { AGENT_TOOL_DEFINITIONS, AgentToolkit } from '../src/index.js';
import { makeIR } from '../../../tests/support/ir.js';

/**
 * What the editing agent is told about stretches the analysis did not spend on.
 *
 * The mask decides that a still, silent event is described and judged by rules
 * rather than by a model. The agent is the next thing that would pay for it: a
 * contact sheet of a camera left running is nine pictures of one frame.
 */
describe('an event summary', () => {
  const ir = makeIR({ events: [{ description: 'a static shot' }, { description: 'a walk' }] });
  ir.events[0]!.observed.inactive_ratio = 0.92;
  const toolkit = new AgentToolkit(ir);

  it('says how much of an event was still and silent', () => {
    expect(toolkit.getEvent('evt_0001')!.inactive_ratio).toBe(0.92);
  });

  it('says nothing about it for an event that was never quiet', () => {
    expect(toolkit.getEvent('evt_0002')).not.toHaveProperty('inactive_ratio');
  });

  it('is what the tool that costs money tells the agent to read before calling it', () => {
    const look = AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === 'look_at_event')!;
    expect(look.description).toContain('inactive_ratio');
  });
});
