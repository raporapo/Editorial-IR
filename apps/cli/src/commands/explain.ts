import { assessmentFor, formatTimecode, type EditorialIR } from '@editorial-ir/contracts';
import { AgentToolkit } from '@editorial-ir/agent';
import { openProject } from '../project.js';
import { requireIr } from '../ir.js';
import { bar, colour, detail, heading, line, note, table } from '../ui.js';

export interface ExplainArgs {
  target: string;
  project?: string;
  json?: boolean;
}

/**
 * Why a moment was kept or cut.
 *
 * The first question anyone asks about an automatic edit, and the one a system
 * that cannot answer it does not deserve to be trusted with. Everything here is
 * recorded at the time the decision was made, not reconstructed afterwards.
 */
export function runExplain(args: ExplainArgs): number {
  const store = openProject(args.project);
  const ir = requireIr(store);
  const toolkit = new AgentToolkit(ir);

  const event = ir.events.find((e) => e.id === args.target);
  if (!event) {
    note(`no event called ${args.target}`);
    return 1;
  }

  const assessment = assessmentFor(ir, event.id);
  const detailed = toolkit.inspectEvent(event.id, 'full');

  if (args.json) {
    line(JSON.stringify(detailed, null, 2));
    return 0;
  }

  heading(
    `${event.id}  ${formatTimecode(event.start_ms, false)} - ${formatTimecode(event.end_ms, false)}`,
  );
  line(`  ${event.description.value}`);
  line();

  detail('kind', event.event_type.value);
  detail('role', assessment?.narrative_role.selected ?? 'unknown');
  detail('from', event.source_ranges.map((r) => r.asset_id).join(', '));
  detail(
    'boundaries',
    `${event.segmentation.method}, confidence ${event.segmentation.boundary_confidence.toFixed(2)}`,
  );
  detail(
    'understood by',
    `${event.description.provenance}, confidence ${event.confidence.toFixed(2)}`,
  );

  if (assessment) {
    heading('how it was judged');
    table(
      Object.entries(assessment.metrics)
        .sort((a, b) => b[1] - a[1])
        .map(([metric, value]) => [metric.padEnd(22), bar(value, 12), value.toFixed(2)]),
    );

    const flags = Object.entries(assessment.flags).filter(([, value]) => value > 0.55);
    if (flags.length > 0) {
      heading('what it is');
      for (const [flag, value] of flags.sort((a, b) => b[1] - a[1])) {
        note(`  ${flag} (${value.toFixed(2)})`);
      }
    }
    if (assessment.rationale) {
      heading('in the model’s words');
      note(`  ${assessment.rationale}`);
    }
  }

  // "Because you told me" is the most important answer this command can give,
  // and the easiest one to leave out: a correction that applied silently looks
  // exactly like a correction that did not.
  const corrections: [string, string][] = [];
  if (event.knowledge.essential) corrections.push(['essential', 'keep it, whatever it scores']);
  if (event.knowledge.excluded) corrections.push(['excluded', 'never use it']);
  if (event.knowledge.importance_override !== undefined) {
    corrections.push(['importance', event.knowledge.importance_override.toFixed(2)]);
  }
  if (event.knowledge.narrative_role_override) {
    corrections.push(['role', event.knowledge.narrative_role_override]);
  }
  if (event.title?.provenance === 'user_provided') {
    corrections.push(['called', event.title.value]);
  }
  if (event.affect.provenance === 'user_provided') {
    corrections.push([
      'mood',
      Object.entries(event.affect.value)
        .map(([name, amount]) => `${name} ${amount}`)
        .join(', '),
    ]);
  }
  if (event.entities.provenance === 'user_provided') {
    corrections.push(['people', event.entities.value.people.join(', ') || '(none)']);
  }
  for (const noteText of event.knowledge.notes) corrections.push(['note', noteText]);

  if (corrections.length > 0) {
    heading('what you said');
    for (const [label, value] of corrections) detail(label, value);
    if (assessment && history(ir, event.id) > 0) {
      note('  The model’s own answer is kept; remove the annotation and it comes back.');
    }
  }

  const plan = store.latestPlan();
  if (plan) {
    const entries = plan.rationale.filter((r) => r.event_id === event.id);
    if (entries.length > 0) {
      heading('in the latest plan');
      for (const entry of entries) {
        const label =
          entry.decision === 'dropped' || entry.decision === 'excluded'
            ? colour.red(entry.decision)
            : colour.green(entry.decision);
        note(`  ${label}: ${entry.reason}`);
        if (entry.skill_rule_ids.length > 0) note(`    rules: ${entry.skill_rule_ids.join(', ')}`);
        // The author's own vocabulary for this clip. A skill can write `tag:
        // [sponsor]` and this is where it comes back.
        if (entry.tags.length > 0) note(`    tags: ${entry.tags.join(', ')}`);
      }
    }
  }

  const relations = toolkit.relationsFor(event.id).slice(0, 6);
  if (relations.length > 0) {
    heading('related');
    table(relations.map((r) => [r.type.padEnd(16), r.other, r.strength.toFixed(2)]));
  }

  return 0;
}

/** How many earlier assessments are kept beside the current one. */
function history(ir: EditorialIR, eventId: string): number {
  return ir.editorial.find((entry) => entry.event_id === eventId)?.history.length ?? 0;
}
