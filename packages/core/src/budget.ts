import { compareText, EditorialError } from '@editorial-ir/contracts';

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
  const ordered = [...candidates].sort((a, b) => b.value - a.value || compareText(a.id, b.id));

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
 * A selection with some candidates left out, and what leaving them out changed.
 *
 * Leaving out still, silent events was never counted, because nothing measured
 * the selection that would have been made with them in. It is the same pure
 * function run twice over the same candidates, so the answer is as reproducible
 * as the selection itself.
 *
 * - `leftOutPicked`: left-out candidates the full selection would have taken —
 *   looks that would have been spent on nothing.
 * - `redirected`: candidates taken only because those were left out. Under a
 *   count or cost limit the look is not saved but moved, to an event with
 *   something in it; with no limit it is saved.
 */
export function selectLeavingOut(
  candidates: readonly EscalationCandidate[],
  leftOut: ReadonlySet<string>,
  policy: EscalationPolicy = {},
): { decision: EscalationDecision; leftOutPicked: string[]; redirected: string[] } {
  const decision = selectForEscalation(
    candidates.filter((candidate) => !leftOut.has(candidate.id)),
    policy,
  );
  if (leftOut.size === 0) return { decision, leftOutPicked: [], redirected: [] };
  const everything = new Set(selectForEscalation(candidates, policy).selected);
  return {
    decision,
    leftOutPicked: [...everything].filter((id) => leftOut.has(id)),
    redirected: decision.selected.filter((id) => !everything.has(id)),
  };
}

/**
 * An escalation policy that cannot spend more than the budget has left.
 *
 * The base pass now spends from the same budget, first. An escalation still
 * selected against the whole limit would pick looks the budget can no longer
 * pay for — and its `spend` throws, out of the compile.
 */
export function withinBudget(policy: EscalationPolicy, budget?: CostBudget): EscalationPolicy {
  if (!budget || budget.remainingUsd === Infinity) return policy;
  return { ...policy, maxCostUsd: Math.min(policy.maxCostUsd ?? Infinity, budget.remainingUsd) };
}

/**
 * Tokens per character of prompt, and tokens per answer, as this run's own calls
 * measured them — so a call that was not made can be priced by its own size.
 *
 * The mean of the calls that were made was used instead, and it answered the
 * wrong question: the events not asked about are the still, silent ones, whose
 * prompts carry no transcript and no on-screen text, so they were priced at the
 * size of the talkative events that were asked about. And a run whose every
 * call came from the cache estimated nothing at all.
 *
 * Answers served from the cache count as measurements: the tokens recorded on
 * them were measured when they were first asked, of the same model, on the same
 * kind of prompt.
 */
export class TokenRate {
  private chars = 0;
  private input = 0;
  private output = 0;
  private calls = 0;

  observe(promptChars: number, inputTokens?: number, outputTokens?: number): void {
    // A backend that reports no usage measured nothing, and nothing is
    // estimated from it.
    if (inputTokens === undefined || promptChars <= 0) return;
    this.chars += promptChars;
    this.input += inputTokens;
    this.output += outputTokens ?? 0;
    this.calls++;
  }

  /** Tokens a call with a prompt this size would have used. Zero when nothing was measured. */
  estimate(promptChars: number): number {
    if (this.calls === 0 || this.chars === 0) return 0;
    return Math.round((promptChars * this.input) / this.chars + this.output / this.calls);
  }
}

/** The size of what a model is shown, for {@link TokenRate}. */
export function promptChars(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
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

  /**
   * Records money already spent.
   *
   * A call's price is sometimes known only once it has answered — a backend that
   * prices by the tokens it was sent. Refusing to record it then would leave the
   * total lower than the invoice; recording it is what makes the next
   * `canAfford` say no.
   */
  charge(costUsd: number): void {
    this.spent += costUsd;
  }

  get limit(): number {
    return this.limitUsd;
  }
}
