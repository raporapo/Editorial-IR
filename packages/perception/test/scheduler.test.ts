import { describe, expect, it } from 'vitest';
import { ModelScheduler } from '../src/index.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe('ModelScheduler', () => {
  it('keeps one slot resident by default', async () => {
    const evicted: string[] = [];
    const scheduler = new ModelScheduler({ onEvict: (slot) => void evicted.push(slot) });

    await scheduler.withModel('speech', async () => tick());
    await scheduler.withModel('visual', async () => tick());

    expect(evicted).toEqual(['speech']);
    expect(scheduler.residentSlots).toEqual(['visual']);
  });

  it('does not reload for consecutive work in the same slot', async () => {
    const evicted: string[] = [];
    const scheduler = new ModelScheduler({ onEvict: (slot) => void evicted.push(slot) });

    for (let i = 0; i < 5; i++) {
      await scheduler.withModel('speech', async () => tick());
    }

    expect(evicted).toEqual([]);
  });

  it('serialises work in different slots instead of loading both', async () => {
    const scheduler = new ModelScheduler();
    const order: string[] = [];

    const speech = scheduler.withModel('speech', async () => {
      order.push('speech:start');
      await tick();
      await tick();
      order.push('speech:end');
    });
    const visual = scheduler.withModel('visual', async () => {
      order.push('visual:start');
      await tick();
      order.push('visual:end');
    });

    await Promise.all([speech, visual]);
    expect(order).toEqual(['speech:start', 'speech:end', 'visual:start', 'visual:end']);
  });

  it('releases the lease when the work throws', async () => {
    const scheduler = new ModelScheduler();
    await expect(
      scheduler.withModel('speech', async () => {
        throw new Error('model blew up');
      }),
    ).rejects.toThrow('model blew up');

    // The next lease must still be grantable.
    await expect(scheduler.withModel('visual', async () => 'ok')).resolves.toBe('ok');
  });

  it('honours a higher concurrency when the hardware allows it', async () => {
    const evicted: string[] = [];
    const scheduler = new ModelScheduler({ concurrency: 2, onEvict: (s) => void evicted.push(s) });

    await scheduler.withModel('speech', async () => tick());
    await scheduler.withModel('visual', async () => tick());
    expect(evicted).toEqual([]);

    await scheduler.withModel('context', async () => tick());
    expect(evicted).toEqual(['speech']);
  });
});
