import { newId, parseTimecode, type UserAnnotation } from '@editorial-ir/contracts';
import { EditorialError } from '@editorial-ir/contracts';
import { openProject } from '../project.js';
import { heading, note, success, table } from '../ui.js';

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
    note('usage: oea annotate <event-id|timecode-range> <essential|exclude|importance|note|rename> [value]');
    return 1;
  }

  const annotation = buildAnnotation(args.target, args.kind, args.value);
  store.writeAnnotations([...existing, annotation]);

  success(`${annotation.type} on ${describeTarget(annotation)}`);
  note('Run "oea analyze" to fold it in, then "oea plan" again.');
  return 0;
}

function buildAnnotation(target: string, kind: string, value: string | undefined): UserAnnotation {
  const base = {
    id: newId('ann'),
    target: parseTarget(target),
    priority: 0,
    created_at: new Date().toISOString(),
  };

  switch (kind) {
    case 'essential':
    case 'exclude':
      return { ...base, type: kind } as UserAnnotation;
    case 'importance': {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0 || number > 1) {
        throw new EditorialError('invalid_input', 'importance takes a number between 0 and 1');
      }
      return { ...base, type: 'importance', value: number };
    }
    case 'note':
      if (!value) throw new EditorialError('invalid_input', 'note takes some text');
      return { ...base, type: 'note', text: value };
    case 'rename':
      if (!value) throw new EditorialError('invalid_input', 'rename takes a title');
      return { ...base, type: 'rename', title: value };
    default:
      throw new EditorialError('invalid_input', `"${kind}" is not a kind of annotation`, {
        kinds: ['essential', 'exclude', 'importance', 'note', 'rename'],
      });
  }
}

function parseTarget(target: string): UserAnnotation['target'] {
  if (target.startsWith('evt_')) return { kind: 'event', event_id: target };
  if (target.startsWith('asset_')) return { kind: 'asset', asset_id: target };
  if (target.includes('-')) {
    const [from, to] = target.split('-');
    return { kind: 'time_range', start_ms: parseTimecode(from ?? '0'), end_ms: parseTimecode(to ?? '0') };
  }
  throw new EditorialError('invalid_input', `"${target}" is not an event id, an asset id or a timecode range`, {
    examples: ['evt_0031', 'asset_001', '00:18:20-00:18:42'],
  });
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
