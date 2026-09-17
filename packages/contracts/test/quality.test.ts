import { describe, expect, it } from 'vitest';
import {
  DECISIVE_STAGES,
  analysisQuality,
  describeStandIn,
  tierFor,
  type StandIn,
} from '../src/quality.js';
import { EditorialIR } from '../src/ir.js';
import { makeIR } from '../../../tests/support/ir.js';

/**
 * The tier is the one number a benchmark must not be able to fake.
 *
 * Everything else in the IR describes the footage; this describes the analysis,
 * and it exists because a rules-only IR and a model-backed one are
 * indistinguishable on disk. The tests below are about the ways a stage could
 * get away with not being counted.
 */
const standIn = (over: Partial<StandIn> = {}): StandIn => ({
  stage: 'judgement',
  used: 'rules',
  instead_of: 'a decision model',
  reason: 'not_configured',
  ...over,
});

describe('the analysis tier', () => {
  it('is standard only when nothing decisive stood in', () => {
    expect(tierFor([])).toBe('standard');
  });

  it('is offline_minimal when a decisive stage had no model', () => {
    expect(tierFor([standIn()])).toBe('offline_minimal');
  });

  it('is degraded when every decisive stand-in was a model that broke', () => {
    expect(tierFor([standIn({ reason: 'failed_during_run' })])).toBe('degraded');
  });

  it('is offline_minimal when one stage broke and another was never configured', () => {
    // The pessimistic reading, deliberately. "Some of it was configured" is not
    // a defence when the run still came out partly guessed.
    expect(
      tierFor([
        standIn({ reason: 'failed_during_run' }),
        standIn({ stage: 'description', reason: 'not_configured' }),
      ]),
    ).toBe('offline_minimal');
  });

  it('stays standard when only an undecisive stage stood in', () => {
    // Silent footage has no transcript, and saying so is not a degradation.
    // If this ever starts failing, something has been added to DECISIVE_STAGES
    // and the change deserves to be noticed rather than absorbed.
    expect(tierFor([standIn({ stage: 'transcription' })])).toBe('standard');
    expect(tierFor([standIn({ stage: 'visual_embedding' })])).toBe('standard');
    expect(tierFor([standIn({ stage: 'audio_events' })])).toBe('standard');
  });

  it('counts every decisive stage, so none can be quietly dropped', () => {
    for (const stage of DECISIVE_STAGES) {
      expect(tierFor([standIn({ stage })])).not.toBe('standard');
    }
  });

  it('keeps the stand-ins beside the tier rather than collapsing to it', () => {
    // A tier with no list is an accusation with no evidence: the user cannot
    // act on "offline_minimal" alone.
    const quality = analysisQuality([standIn()]);
    expect(quality.tier).toBe('offline_minimal');
    expect(quality.stand_ins).toHaveLength(1);
    expect(quality.stand_ins[0]?.instead_of).toBe('a decision model');
  });

  it('does not alias the caller’s array', () => {
    const list = [standIn()];
    const quality = analysisQuality(list);
    list.push(standIn({ stage: 'description' }));
    expect(quality.stand_ins).toHaveLength(1);
  });
});

describe('an IR without a tier', () => {
  it('fails to load rather than being assumed good', () => {
    // The whole point of the field. A document that cannot say how it was made
    // must not parse into one that looks like it was made well.
    const { quality: _quality, ...withoutQuality } = makeIR({ events: [{ description: '出発' }] });
    expect(EditorialIR.safeParse(withoutQuality).success).toBe(false);
  });

  it('cannot claim a tier that contradicts its own stand-ins', () => {
    // Not enforced by the schema — `tierFor` is the only way to produce one, and
    // this records that a hand-built claim is not checked, so a future writer
    // knows the derivation is the guarantee rather than validation.
    expect(tierFor([standIn()])).not.toBe('standard');
  });
});

describe('describing a stand-in', () => {
  it('says what ran, what should have, and whose fault it is', () => {
    expect(describeStandIn(standIn())).toContain('rules instead of a decision model');
    expect(describeStandIn(standIn())).toContain('nothing configured');
    expect(describeStandIn(standIn({ reason: 'requested' }))).toContain('asked for');
    expect(describeStandIn(standIn({ reason: 'unavailable' }))).toContain('unreachable');
    expect(describeStandIn(standIn({ reason: 'failed_during_run' }))).toContain('partway');
  });
});
