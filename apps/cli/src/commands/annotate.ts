import {
  NARRATIVE_ROLES,
  newId,
  parseTimecode,
  type AnnotationAnchor,
  type NarrativeRole,
  type UserAnnotation,
} from '@editorial-ir/contracts';
import { EditorialError } from '@editorial-ir/contracts';
import type { ProjectStore } from '@editorial-ir/core';
import { openProject } from '../project.js';
import { heading, note, success, table, warn } from '../ui.js';

export interface AnnotateArgs {
  target?: string;
  kind?: string;
  value?: string;
  project?: string;
  list?: boolean;
  clear?: boolean;
}

/**
 * Recording what the user knows.
 *
 * Annotations are stored beside the model's output rather than applied over it,
 * so removing one restores the model's opinion instead of losing it. They are
 * also the only thing in the system that outranks every rule and every model.
 */
export function runAnnotate(args: AnnotateArgs): number {
  const store = openProject(args.project);
  const existing = store.readAnnotations();

  if (args.list) {
    if (existing.length === 0) {
      note('no annotations yet');
      return 0;
    }
    heading('annotations');
    table(existing.map((a) => [a.id, a.type, describeTarget(a), a.note ?? '']));
    return 0;
  }

  if (args.clear) {
    store.writeAnnotations([]);
    success(`removed ${existing.length} annotation(s)`);
    return 0;
  }

  if (!args.target || !args.kind) {
    printUsage();
    return 1;
  }

  const annotation = anchored(buildAnnotation(args.target, args.kind, args.value), store);
  store.writeAnnotations([...existing, annotation]);

  success(`${annotation.type} on ${describeTarget(annotation)}`);
  note('Run "oea analyze" to fold it in, then "oea plan" again.');
  return 0;
}

/**
 * Records the footage the target named, so the correction cannot drift off it.
 *
 * `evt_0008` is the eighth event of the last analysis and nothing more, so any
 * split or merge earlier in the timeline renumbers everything after it and a
 * correction stored against an id lands on different material. On the worked
 * example a single `merge` moved an `essential` and a title onto a wordless
 * platform shot, and "this is the ending" onto a different moment, and nothing
 * was said about it: `oea explain` reported the wrong clip as locked while the
 * moment the user had actually marked was dropped from the cut.
 *
 * The id stays as written, for reading. What the compiler matches on is this.
 */
function anchored(annotation: UserAnnotation, store: ProjectStore): UserAnnotation {
  const target = annotation.target;
  if (target.kind !== 'event' && target.kind !== 'event_pair') return annotation;

  const ir = store.readIr();
  if (!ir) {
    // Nothing to resolve against yet. The id is all there is, and `oea analyze`
    // has to run before the correction can apply anyway.
    warn('  no analysis yet, so this is stored against the event id as written');
    note('  run "oea analyze" first if you want it pinned to the footage');
    return annotation;
  }

  const ids = target.kind === 'event' ? [target.event_id] : [target.event_a, target.event_b];
  const anchor: AnnotationAnchor[] = [];
  for (const id of ids) {
    const range = ir.events.find((event) => event.id === id)?.source_ranges[0];
    if (!range) {
      throw new EditorialError('not_found', `there is no event called "${id}" in this analysis`, {
        hint: 'oea timeline lists them',
      });
    }
    anchor.push({
      asset_id: range.asset_id,
      start_ms: range.source_in_ms,
      end_ms: range.source_out_ms,
    });
  }
  return { ...annotation, anchor };
}

function buildAnnotation(target: string, kind: string, value: string | undefined): UserAnnotation {
  const base = {
    id: newId('ann'),
    target: parseTarget(target),
    anchor: [],
    priority: 0,
    created_at: new Date().toISOString(),
  };

  switch (kind) {
    case 'essential':
    case 'exclude':
      return { ...base, type: kind };

    case 'importance':
      return { ...base, type: 'importance', value: unitScore(value, 'importance') };

    case 'continuity':
      // The only annotation about a pair rather than a moment: "these two
      // belong together" and "these two are not the same thing".
      if (base.target.kind !== 'event_pair') {
        throw new EditorialError(
          'invalid_input',
          'continuity is about two events, so it takes a pair: evt_0031..evt_0032',
        );
      }
      return { ...base, type: 'continuity', strength: unitScore(value, 'continuity') };

    case 'note':
      return { ...base, type: 'note', text: requireText(value, 'note', 'some text') };

    case 'rename':
      return { ...base, type: 'rename', title: requireText(value, 'rename', 'a title') };

    case 'label':
      return { ...base, type: 'label', labels: requireList(value, 'label', 'street, night') };

    case 'person':
      // Ids from background.people in context.yaml, so that "who is in this"
      // and "who are these people" are the same vocabulary.
      return { ...base, type: 'person', people: requireList(value, 'person', 'me, partner') };

    case 'mood':
      return { ...base, type: 'mood', mood: parseMood(value) };

    case 'role':
    case 'narrative_role': {
      // A closed vocabulary, so a typo is told to you now rather than stored and
      // quietly ignored.
      const role = requireText(value, 'role', `one of: ${NARRATIVE_ROLES.join(', ')}`);
      if (!(NARRATIVE_ROLES as readonly string[]).includes(role)) {
        throw new EditorialError('invalid_input', `"${role}" is not a narrative role`, {
          roles: NARRATIVE_ROLES,
        });
      }
      return { ...base, type: 'narrative_role', role: role as NarrativeRole };
    }

    case 'split':
      return {
        ...base,
        type: 'boundary',
        action: 'split',
        ...(value ? { at_ms: parseTimecode(value) } : {}),
      };

    case 'merge':
      return { ...base, type: 'boundary', action: 'merge_with_next' };

    default:
      throw new EditorialError('invalid_input', `"${kind}" is not a kind of annotation`, {
        kinds: KINDS.map((k) => k.name),
      });
  }
}

/**
 * Every correction a user can make, and what each one is for.
 *
 * Kept as data rather than as a sentence in the usage line, because the list is
 * long enough that a wall of pipe-separated words stops being readable, and
 * because "what can I actually tell it" is the first question anyone asks.
 */
const KINDS = [
  { name: 'essential', takes: '', about: 'keep this, whatever anything scores it' },
  { name: 'exclude', takes: '', about: 'never use this' },
  { name: 'importance', takes: '<0..1>', about: 'how much this matters to the story' },
  { name: 'rename', takes: '<title>', about: 'what this moment is called' },
  { name: 'note', takes: '<text>', about: 'what you know that the footage cannot show' },
  { name: 'label', takes: '<a, b>', about: 'what is in shot, when it was missed' },
  { name: 'person', takes: '<ids>', about: 'who appears, by id from context.yaml' },
  { name: 'mood', takes: '<name=0.8>', about: 'how it actually felt' },
  { name: 'role', takes: '<role>', about: `one of: ${NARRATIVE_ROLES.join(', ')}` },
  { name: 'continuity', takes: '<0..1>', about: 'how well two events run together' },
  { name: 'split', takes: '[timecode]', about: 'this is really two moments' },
  { name: 'merge', takes: '', about: 'this and the next one are one moment' },
];

function printUsage(): void {
  note('usage: oea annotate <target> <kind> [value]');
  note('');
  note('targets: evt_0031   a moment');
  note('         evt_0031..evt_0032   a pair, for continuity');
  note('         00:18:20-00:18:42    a stretch of the capture timeline');
  note('         asset_001            a whole recording');
  note('');
  heading('kinds');
  table(KINDS.map((k) => [k.name, k.takes, k.about]));
  note('');
  note('Nothing here is ever overwritten by analysis. You outrank every model.');
}

function unitScore(value: string | undefined, kind: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new EditorialError('invalid_input', `${kind} takes a number between 0 and 1`, {
      given: value ?? '(nothing)',
    });
  }
  return number;
}

function requireText(value: string | undefined, kind: string, example: string): string {
  if (!value?.trim()) {
    throw new EditorialError('invalid_input', `${kind} takes ${example}`);
  }
  return value.trim();
}

function requireList(value: string | undefined, kind: string, example: string): string[] {
  const items = (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (items.length === 0) {
    throw new EditorialError(
      'invalid_input',
      `${kind} takes a comma-separated list, e.g. ${example}`,
    );
  }
  return items;
}

/**
 * "excitement=0.9, sadness=0" — named intensities, not one chosen emotion.
 *
 * Affect is a vector here on purpose: editing cares about how excited, not
 * about picking a label. Setting one to zero is how you say "this is not a sad
 * scene", which is the correction this exists for.
 */
function parseMood(value: string | undefined): Record<string, number> {
  const mood: Record<string, number> = {};
  for (const pair of (value ?? '').split(',')) {
    if (!pair.trim()) continue;
    const [name, amount] = pair.split('=');
    if (!name?.trim() || amount === undefined) {
      throw new EditorialError(
        'invalid_input',
        'mood takes names and intensities, e.g. "excitement=0.9, sadness=0"',
        { given: pair.trim() },
      );
    }
    mood[name.trim()] = unitScore(amount.trim(), `mood "${name.trim()}"`);
  }
  if (Object.keys(mood).length === 0) {
    throw new EditorialError(
      'invalid_input',
      'mood takes names and intensities, e.g. "excitement=0.9, sadness=0"',
    );
  }
  return mood;
}

function parseTarget(target: string): UserAnnotation['target'] {
  // A pair is written evt_0031..evt_0032. Two dots rather than one hyphen
  // because event ids contain no dots and timecodes contain no letters, which
  // keeps this unambiguous without a flag.
  if (target.includes('..')) {
    const [a, b] = target.split('..');
    if (!a?.startsWith('evt_') || !b?.startsWith('evt_')) {
      throw new EditorialError('invalid_input', `"${target}" is not a pair of event ids`, {
        example: 'evt_0031..evt_0032',
      });
    }
    return { kind: 'event_pair', event_a: a, event_b: b };
  }
  if (target.startsWith('evt_')) return { kind: 'event', event_id: target };
  if (target.startsWith('asset_')) return { kind: 'asset', asset_id: target };
  if (target.includes('-')) {
    const [from, to] = target.split('-');
    return {
      kind: 'time_range',
      start_ms: parseTimecode(from ?? '0'),
      end_ms: parseTimecode(to ?? '0'),
    };
  }
  throw new EditorialError(
    'invalid_input',
    `"${target}" is not an event id, an asset id or a timecode range`,
    {
      examples: ['evt_0031', 'asset_001', '00:18:20-00:18:42'],
    },
  );
}

function describeTarget(annotation: UserAnnotation): string {
  const target = annotation.target;
  switch (target.kind) {
    case 'event':
      return target.event_id;
    case 'asset':
      return target.asset_id;
    case 'event_pair':
      return `${target.event_a} and ${target.event_b}`;
    case 'time_range':
      return `${target.start_ms}ms to ${target.end_ms}ms`;
    default:
      return 'the project';
  }
}
