import { EditorialError, mentionsAny, type NumericCondition } from '@editorial-ir/contracts';
import type { EventFacts } from './facts.js';

/**
 * The comparator language a Skill rule is written in.
 *
 * `">0.7"` rather than `{ operator: 'gt', value: 0.7 }`, because the people who
 * will write these files are editors describing their own taste, and a rule file
 * they cannot read at a glance is a rule file they will not write.
 *
 * Accepted: `">0.7"`, `">=0.7"`, `"<0.2"`, `"<=0.2"`, `"==0.5"`, `"!=0.5"`,
 * `"0.3..0.7"` (inclusive), a bare number (exact), and `{ gt: 0.7 }` for
 * machine-generated rules.
 */
export interface ParsedComparator {
  test(value: number): boolean;
  describe(): string;
}

const EPSILON = 1e-9;

export function parseNumericCondition(condition: NumericCondition): ParsedComparator {
  if (typeof condition === 'number') {
    return {
      test: (value) => Math.abs(value - condition) < EPSILON,
      describe: () => `== ${condition}`,
    };
  }

  if (typeof condition === 'object') {
    const clauses: ((value: number) => boolean)[] = [];
    const parts: string[] = [];
    if (condition.gt !== undefined) {
      const bound = condition.gt;
      clauses.push((v) => v > bound);
      parts.push(`> ${bound}`);
    }
    if (condition.gte !== undefined) {
      const bound = condition.gte;
      clauses.push((v) => v >= bound);
      parts.push(`>= ${bound}`);
    }
    if (condition.lt !== undefined) {
      const bound = condition.lt;
      clauses.push((v) => v < bound);
      parts.push(`< ${bound}`);
    }
    if (condition.lte !== undefined) {
      const bound = condition.lte;
      clauses.push((v) => v <= bound);
      parts.push(`<= ${bound}`);
    }
    if (condition.eq !== undefined) {
      const bound = condition.eq;
      clauses.push((v) => Math.abs(v - bound) < EPSILON);
      parts.push(`== ${bound}`);
    }
    if (condition.ne !== undefined) {
      const bound = condition.ne;
      clauses.push((v) => Math.abs(v - bound) >= EPSILON);
      parts.push(`!= ${bound}`);
    }
    if (clauses.length === 0) {
      throw new EditorialError('skill_error', 'a numeric condition object has no comparison in it');
    }
    return { test: (value) => clauses.every((c) => c(value)), describe: () => parts.join(' and ') };
  }

  const text = condition.trim();

  const range = /^(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)$/.exec(text);
  if (range) {
    const low = Number(range[1]);
    const high = Number(range[2]);
    if (low > high) {
      throw new EditorialError('skill_error', `range "${text}" starts above where it ends`);
    }
    return {
      test: (value) => value >= low && value <= high,
      describe: () => `in [${low}, ${high}]`,
    };
  }

  const comparison = /^(>=|<=|==|!=|>|<)\s*(-?\d+(?:\.\d+)?)$/.exec(text);
  if (!comparison) {
    throw new EditorialError(
      'skill_error',
      `"${condition}" is not a comparison. Write something like ">0.7", "<=0.2" or "0.3..0.7".`,
    );
  }
  const operator = comparison[1];
  const bound = Number(comparison[2]);
  switch (operator) {
    case '>':
      return { test: (v) => v > bound, describe: () => `> ${bound}` };
    case '>=':
      return { test: (v) => v >= bound, describe: () => `>= ${bound}` };
    case '<':
      return { test: (v) => v < bound, describe: () => `< ${bound}` };
    case '<=':
      return { test: (v) => v <= bound, describe: () => `<= ${bound}` };
    case '==':
      return { test: (v) => Math.abs(v - bound) < EPSILON, describe: () => `== ${bound}` };
    default:
      return { test: (v) => Math.abs(v - bound) >= EPSILON, describe: () => `!= ${bound}` };
  }
}

/* -------------------------------------------------------------------------- */
/* Condition evaluation                                                        */
/* -------------------------------------------------------------------------- */

/** Fields that compare a number held directly on the facts. */
const NUMERIC_FACTS = new Set([
  'duration_ms',
  'speech_ratio',
  'silence_ratio',
  'shot_count',
  'motion',
]);

/** Fields that compare a boolean held directly on the facts. */
const BOOLEAN_FACTS = new Set([
  'new_location',
  'new_person',
  'has_speech',
  'has_music',
  'has_laughter',
  'has_text_on_screen',
  'is_user_essential',
  'is_user_excluded',
]);

/**
 * Evaluates one condition against one event.
 *
 * Every field is ANDed. An unknown field is an error rather than a silent false:
 * a rule that never fires because of a typo is the single most frustrating way
 * for a Skill to be wrong, since the file looks correct and the edit simply
 * ignores it.
 */
export function evaluateCondition(condition: Record<string, unknown>, facts: EventFacts): boolean {
  for (const [field, expected] of Object.entries(condition)) {
    if (expected === undefined) continue;

    switch (field) {
      case 'all_of':
        if (!(expected as Record<string, unknown>[]).every((c) => evaluateCondition(c, facts)))
          return false;
        continue;
      case 'any_of':
        if (!(expected as Record<string, unknown>[]).some((c) => evaluateCondition(c, facts)))
          return false;
        continue;
      case 'not':
        if (evaluateCondition(expected as Record<string, unknown>, facts)) return false;
        continue;
      case 'narrative_role':
        if (!matchesString(facts.narrative_role, expected)) return false;
        continue;
      case 'event_type':
        if (!matchesString(facts.event_type, expected)) return false;
        continue;
      case 'chapter_position':
        if (facts.chapter_position !== expected) return false;
        continue;
      case 'project_position':
        if (facts.project_position !== expected) return false;
        continue;
      case 'mentions':
        if (!mentionsAny(facts.text, toList(expected))) return false;
        continue;
      case 'involves_person':
        if (!toList(expected).some((p) => facts.people.includes(p))) return false;
        continue;
      case 'at_place':
        if (!toList(expected).some((p) => facts.places.includes(p))) return false;
        continue;
      case 'affect': {
        const axes = expected as Record<string, NumericCondition>;
        for (const [axis, comparison] of Object.entries(axes)) {
          if (!parseNumericCondition(comparison).test(facts.affect[axis] ?? 0)) return false;
        }
        continue;
      }
      default:
        break;
    }

    if (BOOLEAN_FACTS.has(field)) {
      if (Boolean(facts[field as keyof EventFacts]) !== Boolean(expected)) return false;
      continue;
    }

    if (NUMERIC_FACTS.has(field)) {
      const value = facts[field as keyof EventFacts];
      if (typeof value !== 'number') return false;
      if (!parseNumericCondition(expected as NumericCondition).test(value)) return false;
      continue;
    }

    if (field in facts.metrics) {
      const value = facts.metrics[field as keyof typeof facts.metrics];
      if (!parseNumericCondition(expected as NumericCondition).test(value)) return false;
      continue;
    }

    if (field.endsWith('_probability')) {
      const flag = field.slice(0, -'_probability'.length);
      if (flag in facts.flags) {
        const value = facts.flags[flag as keyof typeof facts.flags];
        if (!parseNumericCondition(expected as NumericCondition).test(value)) return false;
        continue;
      }
    }

    throw new EditorialError('skill_error', `"${field}" is not something a rule can test`, {
      field,
      hint: 'Check the field list in docs/skills.md; editorial flags are tested as "<flag>_probability".',
    });
  }

  return true;
}

function matchesString(actual: string, expected: unknown): boolean {
  return toList(expected).includes(actual);
}

function toList(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}
