import { describe, expect, it } from 'vitest';
import { HeuristicContextModel } from '@editorial-ir/perception';
import { describeKey } from '../src/context-builder.js';

/**
 * What a cached description is keyed on.
 *
 * Measured with a model endpoint that logged every request: an active stretch
 * was never shown to the model, because its words matched the frozen minute
 * before it (neither had any) and the key said nothing about the pictures
 * beyond "with frames". It was handed the frozen minute's description.
 */
const model = new HeuristicContextModel();

function params(framePaths: string[]) {
  return {
    event_id: 'evt_0001',
    frame_paths: framePaths,
    transcript: [],
    ocr: [],
    audio_tags: [],
    visual_labels: [],
    user_context: {},
  };
}

describe('describeKey', () => {
  it('tells apart two events with the same words and different pictures', () => {
    const frozen = describeKey(model, params(['/p/.oea/work/c7b2484d1eba/frames/00000031.jpg']));
    const active = describeKey(model, params(['/p/.oea/work/c7b2484d1eba/frames/00000101.jpg']));
    expect(frozen).not.toEqual(active);
  });

  it('is the same key when the project moves', () => {
    const here = describeKey(
      model,
      params(['/home/a/trip/.oea/work/c7b2484d1eba/frames/00000031.jpg']),
    );
    const there = describeKey(
      model,
      params(['/mnt/b/trip/.oea/work/c7b2484d1eba/frames/00000031.jpg']),
    );
    expect(here).toEqual(there);
  });

  it('ignores the event id, which segmentation renumbers', () => {
    expect(describeKey(model, { ...params([]), event_id: 'evt_0009' })).toEqual(
      describeKey(model, params([])),
    );
  });
});
