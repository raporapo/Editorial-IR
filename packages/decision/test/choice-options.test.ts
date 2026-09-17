import { describe, expect, it } from 'vitest';
import { matchOption } from '../src/backends/local-system-one.js';

/**
 * A choice is a question with a closed set of answers.
 *
 * A 1B model answered the narrative-role question with `opening_candidate`,
 * `establishing_shot` and `ending_candidate` — plausible words, none of them
 * roles; it had blended the role question with the boolean flags asked
 * alongside it. Those went into the IR unchecked, and `oea analyze` finished by
 * writing a file that failed its own schema when the next command read it.
 */
const ROLES = [
  { value: 'setup' },
  { value: 'context' },
  { value: 'build_up' },
  { value: 'payoff' },
  { value: 'ending' },
  { value: 'filler' },
];

describe('an answer to a closed question', () => {
  it('is accepted when it names an option', () => {
    expect(matchOption('payoff', ROLES)).toBe('payoff');
  });

  it('tolerates the model’s formatting', () => {
    // Case and whitespace are how it typed the answer, not which answer it gave.
    expect(matchOption('  Payoff  ', ROLES)).toBe('payoff');
    expect(matchOption('BUILD_UP', ROLES)).toBe('build_up');
  });

  it('comes back as the option’s own spelling, not the model’s', () => {
    // Otherwise the IR carries whichever capitalisation the model happened to
    // use, and everything comparing roles by string stops matching.
    expect(matchOption('Setup', ROLES)).toBe('setup');
  });

  it('is rejected when it is a word that is not on the list', () => {
    // The three the model actually invented.
    expect(matchOption('opening_candidate', ROLES)).toBeUndefined();
    expect(matchOption('establishing_shot', ROLES)).toBeUndefined();
    expect(matchOption('ending_candidate', ROLES)).toBeUndefined();
  });

  it('is not fuzzy-matched to the nearest thing', () => {
    // `ending_candidate` shares a prefix with `ending`, and guessing that they
    // mean the same thing is how a wrong answer becomes a confident one.
    expect(matchOption('ending_cand', ROLES)).toBeUndefined();
    expect(matchOption('pay', ROLES)).toBeUndefined();
  });

  it('is rejected when it is not a string at all', () => {
    expect(matchOption(undefined, ROLES)).toBeUndefined();
    expect(matchOption(3, ROLES)).toBeUndefined();
    expect(matchOption(['payoff'], ROLES)).toBeUndefined();
    expect(matchOption('', ROLES)).toBeUndefined();
    expect(matchOption('   ', ROLES)).toBeUndefined();
  });
});
