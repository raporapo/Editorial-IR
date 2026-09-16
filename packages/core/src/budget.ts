import { EditorialError } from '@editorial-ir/contracts';

/**
 * Deciding what is worth spending a model on.
 *
 * Running a vision-language model over every event of an hour of footage is
 * both the obvious design and the one that makes the tool too expensive to use.
 * The alternative is not "use a worse model" but "use the good model where it
 * changes the answer": most events are unambiguous, and the cheap layer already
 * knows which ones it is unsure about.
 */
export interface EscalationCandidate {
  id: string;
  /** How much a better answer here would be worth, higher first. */
  value: number;
  /** Estimated cost of escalating this one, in USD. */
  costUsd: number;
}

export interface EscalationPolicy {
  /** Never escalate more than this many items. */
  maxItems?: number;
  /** Never spend more than this in total. */
  maxCostUsd?: number;
  /** Never escalate an item valued below this. */
  minValue?: number;
  /** Always escalate at least this many, budget permitting, so a run is never entirely cheap. */
  minItems?: number;
}

export interface EscalationDecision {
  selected: string[];
  skipped: string[];
  estimatedCostUsd: number;
  /** Why the selection stopped where it did. */
  limitedBy: 'value' | 'count' | 'cost' | 'nothing';
}

/**
 * Picks what to escalate, most valuable first, within both limits.
 *
 * Ties break by id so that the same project escalates the same events on every
 * run — a budget that spends itself somewhere different each time makes a
 * regression impossible to reproduce.
 */
export function selectForEscalation(
  candidates: readonly EscalationCandidate[],
  policy: EscalationPolicy = {},
): EscalationDecision {
  const ordered = [...candidates].sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));

  const maxItems = policy.maxItems ?? Infinity;
  const maxCost = policy.maxCostUsd ?? Infinity;
  const minValue = policy.minValue ?? -Infinity;
  const minItems = policy.minItems ?? 0;

  const selected: string[] = [];
  const skipped: string[] = [];
  let spent = 0;
  let limitedBy: EscalationDecision['limitedBy'] = 'nothing';

  for (const candidate of ordered) {
    const mustTake = selected.length < minItems;
    if (!mustTake && candidate.value < minValue) {
      skipped.push(candidate.id);
      limitedBy = 'value';
      continue;
    }
    if (selected.length >= maxItems) {
      skipped.push(candidate.id);
      limitedBy = 'count';
      continue;
    }
    if (spent + candidate.costUsd > maxCost) {
      skipped.push(candidate.id);
      limitedBy = 'cost';
      continue;
    }
    selected.push(candidate.id);
    spent += candidate.costUsd;
  }

  return {
    selected,
    skipped,
    estimatedCostUsd: Math.round(spent * 1_000_000) / 1_000_000,
    limitedBy,
  };
}

/**
 * A running total that stops the run rather than surprising the user.
 *
 * A pipeline that can spend money must have a number it will not exceed, and it
 * must fail loudly at that number: discovering the limit on an invoice is not an
 * acceptable way to learn it.
 */
export class CostBudget {
  private spent = 0;

  constructor(private readonly limitUsd = Infinity) {}

  get spentUsd(): number {
    return Math.round(this.spent * 1_000_000) / 1_000_000;
  }

  get remainingUsd(): number {
    return this.limitUsd === Infinity ? Infinity : Math.max(0, this.limitUsd - this.spent);
  }

  canAfford(costUsd: number): boolean {
    return this.spent + costUsd <= this.limitUsd;
  }

  spend(costUsd: number, what: string): void {
    if (!this.canAfford(costUsd)) {
      throw new EditorialError(
        'budget_exceeded',
        `the cost limit of $${this.limitUsd} would be exceeded by ${what}`,
        { limit_usd: this.limitUsd, spent_usd: this.spentUsd, requested_usd: costUsd },
      );
    }
    this.spent += costUsd;
  }
}
