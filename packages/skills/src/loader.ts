import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  EditorialError,
  SkillDefaults,
  SkillManifest,
  SkillRule,
  parseOrThrow,
  type SkillManifest as SkillManifestType,
  type SkillRule as SkillRuleType,
} from '@editorial-ir/contracts';

/**
 * Loading and composing skills.
 *
 * Skills live on disk as YAML next to a README, not compiled into the package,
 * because the point of the format is that an editor can copy one, change three
 * numbers and have their own. A skill you cannot open is a configuration file
 * pretending to be a contribution.
 */

/** Where the skills shipped with this package live. */
export const BUILT_IN_SKILL_DIR = fileURLToPath(new URL('../library', import.meta.url));

export interface SkillSource {
  name: string;
  /** The manifest as written, before `extends` is resolved. */
  manifest: SkillManifestType;
  /**
   * The same file as a plain object, holding only the keys it actually wrote.
   *
   * Inheritance needs this. Once the schema has been applied, `defaults` and
   * `constraints` carry every key — the ones the author wrote and the ones the
   * schema filled in — and the two are indistinguishable, so merging a child
   * over a parent overwrites the parent with defaults the child never asked
   * for. The fragment is what the author said; the manifest is what it means.
   *
   * A source registered from a manifest in code rather than from a file may
   * leave this out: handing over a parsed manifest is saying every value in it.
   */
  declared?: SkillFragment;
  /** Where it came from, for error messages. */
  origin: string;
  /** Contents of the skill's README, when it has one. */
  readme?: string;
}

/** A skill file as written: the keys its author put in it, and nothing else. */
export type SkillFragment = Record<string, unknown>;

export function parseSkill(text: string, origin: string): SkillManifestType {
  return parseOrThrow(SkillManifest, readSkillFragment(text, origin), `skill manifest ${origin}`);
}

/** Reads a skill file into the object its author wrote, without applying the schema. */
export function readSkillFragment(text: string, origin: string): SkillFragment {
  let raw: unknown;
  try {
    raw = origin.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
  } catch (error) {
    throw new EditorialError(
      'skill_error',
      `${origin} is not valid ${origin.endsWith('.json') ? 'JSON' : 'YAML'}`,
      {
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new EditorialError('skill_error', `${origin} is not a skill manifest`);
  }
  return raw as SkillFragment;
}

export function loadSkillFile(path: string): SkillSource {
  if (!existsSync(path)) {
    throw new EditorialError('not_found', `no skill file at ${path}`);
  }
  const declared = readSkillFragment(readFileSync(path, 'utf8'), path);
  const manifest = parseOrThrow(SkillManifest, declared, `skill manifest ${path}`);
  const readmePath = join(path, '..', 'SKILL.md');
  return {
    name: manifest.name,
    manifest,
    declared,
    origin: path,
    ...(existsSync(readmePath) ? { readme: readFileSync(readmePath, 'utf8') } : {}),
  };
}

/**
 * A set of skills that can resolve each other's `extends`.
 *
 * Built-ins and a user's own directory sit in the same registry deliberately: a
 * skill someone wrote should be able to extend `base-editor`, and should be
 * loadable exactly the way the shipped ones are.
 */
export class SkillRegistry {
  private readonly sources = new Map<string, SkillSource>();
  private readonly resolved = new Map<string, SkillManifestType>();

  static withBuiltIns(extraDirectories: string[] = []): SkillRegistry {
    const registry = new SkillRegistry();
    registry.addDirectory(BUILT_IN_SKILL_DIR);
    for (const directory of extraDirectories) registry.addDirectory(directory);
    return registry;
  }

  /** Adds every `<dir>/<name>/skill.yaml`, and a bare `<dir>/skill.yaml` too. */
  addDirectory(directory: string): void {
    if (!existsSync(directory)) return;

    for (const candidate of ['skill.yaml', 'skill.yml', 'skill.json']) {
      const direct = join(directory, candidate);
      if (existsSync(direct)) {
        this.add(loadSkillFile(direct));
        return;
      }
    }

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const candidate of ['skill.yaml', 'skill.yml', 'skill.json']) {
        const path = join(directory, entry.name, candidate);
        if (existsSync(path)) {
          this.add(loadSkillFile(path));
          break;
        }
      }
    }
  }

  add(source: SkillSource): void {
    // Later registrations win, so a user's directory can shadow a built-in of
    // the same name. That is how someone customises a shipped skill without
    // forking the project.
    this.sources.set(source.name, source);
    this.resolved.clear();
  }

  has(name: string): boolean {
    return this.sources.has(name);
  }

  list(): SkillSource[] {
    return [...this.sources.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  source(name: string): SkillSource | undefined {
    return this.sources.get(name);
  }

  /** Resolves a skill with every `extends` merged in. */
  resolve(name: string): SkillManifestType {
    const cached = this.resolved.get(name);
    if (cached) return cached;
    const source = this.sources.get(name);
    // The schema is applied once, to the finished composition. Applying it to
    // each file first and merging afterwards is what made inheritance lossy:
    // the defaults the schema had filled in were indistinguishable from the
    // ones the child had asked for, and they overwrote the parent.
    const manifest = parseOrThrow(
      SkillManifest,
      this.resolveWithStack(name, []),
      `skill ${name}${source ? ` (${source.origin})` : ''}`,
    );
    this.resolved.set(name, manifest);
    return manifest;
  }

  private resolveWithStack(name: string, stack: string[]): SkillFragment {
    if (stack.includes(name)) {
      throw new EditorialError(
        'skill_error',
        `skills extend each other in a cycle: ${[...stack, name].join(' -> ')}`,
      );
    }

    const source = this.sources.get(name);
    if (!source) {
      throw new EditorialError('not_found', `no skill named "${name}"`, {
        available: [...this.sources.keys()].sort(),
      });
    }

    let merged: SkillFragment | undefined;
    for (const parentName of source.manifest.extends) {
      const parent = this.resolveWithStack(parentName, [...stack, name]);
      merged = merged ? mergeFragments(merged, parent) : parent;
    }

    const own: SkillFragment = source.declared ?? source.manifest;
    const result = merged ? mergeFragments(merged, own) : own;
    // The resolved skill keeps its own identity, not its parent's.
    return {
      ...result,
      name: source.manifest.name,
      version: source.manifest.version,
      extends: source.manifest.extends,
    };
  }
}

/**
 * Merges a child over a parent.
 *
 * The rules, spelled out because an inheritance model nobody can predict is
 * worse than no inheritance at all:
 *
 * - `defaults`, `constraints` and `intent` merge field by field.
 * - `scoring.weights` merges key by key, so a child can change one weight
 *   without restating the others.
 * - `arc` is replaced wholesale when the child declares one, because a partial
 *   arc whose segment budgets no longer sum to one is not a useful shape.
 * - `rules` are concatenated, parent first. At equal priority the child's rule
 *   is applied later and therefore wins. A child rule that reuses a parent's id
 *   replaces it in place, which is the only way to switch an inherited rule off.
 * - An inherited rule's clip bounds are clamped to the child's own defaults. A
 *   rule may tighten the window the child declared; it may not widen it.
 */
export function mergeSkills(
  parent: SkillManifestType,
  child: SkillManifestType,
): SkillManifestType {
  return parseOrThrow(
    SkillManifest,
    mergeFragments(parent as unknown as SkillFragment, child as unknown as SkillFragment),
    `${child.name} extending ${parent.name}`,
  );
}

/**
 * The same merge, over the objects the authors actually wrote.
 *
 * This is where the composition happens, because only here is "the child did
 * not mention `snap_to_silence`" distinguishable from "the child asked for the
 * default". A manifest that has been through the schema says the same thing
 * either way, and merging one over a parent silently reset every tuned value
 * the child had not restated — a child that changed `max_operations` and
 * nothing else put its parent's cap on consecutive shots back to three.
 */
function mergeFragments(parent: SkillFragment, child: SkillFragment): SkillFragment {
  const defaults = mergeSection(parent.defaults, child.defaults);
  const parentScoring = section(parent.scoring);
  const childScoring = section(child.scoring);
  const scoring: SkillFragment = {
    ...parentScoring,
    ...childScoring,
    ...nonEmpty('weights', mergeSection(parentScoring.weights, childScoring.weights)),
    ...nonEmpty(
      'flag_weights',
      mergeSection(parentScoring.flag_weights, childScoring.flag_weights),
    ),
  };
  const childArc = section(child.arc);
  const merged: SkillFragment = {
    ...parent,
    ...child,
    ...nonEmpty('defaults', defaults),
    ...nonEmpty('scoring', scoring),
    arc: hasSegments(childArc) ? child.arc : parent.arc,
    ...nonEmpty('constraints', mergeSection(parent.constraints, child.constraints)),
    ...nonEmpty('intent', mergeSection(parent.intent, child.intent)),
    rules: mergeRules(
      rulesOf(parent).map((rule) => clampToDefaults(rule, SkillDefaults.parse(defaults))),
      rulesOf(child),
    ),
  };
  if (merged.arc === undefined) delete merged.arc;
  return merged;
}

/**
 * Parent rules then child rules, except that a shared id is one rule.
 *
 * Without this a child can only add. `tech-youtube` inherits `drop-silence`
 * from `talking-head` — wordless and unimportant, so cut it — which is right
 * for one person talking to camera and wrong for a tech video, where a silent
 * screen recording of the thing working is the part a written article cannot
 * replace. tech-youtube says exactly that in a rule of its own, and could not
 * reach it: dropping is sticky, by design, so nothing a later rule says can
 * bring the material back.
 *
 * A child rule with a parent's id replaces it, in the parent's position, so
 * that an override does not silently change where the rule sits in the file
 * order that breaks priority ties.
 */
function mergeRules(
  parent: readonly SkillRuleType[],
  child: readonly SkillRuleType[],
): SkillRuleType[] {
  const overrides = new Map<string, SkillRuleType>();
  for (const rule of child) if (rule.id !== undefined) overrides.set(rule.id, rule);

  const used = new Set<string>();
  const merged = parent.map((rule) => {
    const override = rule.id === undefined ? undefined : overrides.get(rule.id);
    if (!override) return rule;
    used.add(rule.id!);
    return override;
  });

  return [...merged, ...child.filter((rule) => rule.id === undefined || !used.has(rule.id))];
}

function section(value: unknown): SkillFragment {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as SkillFragment)
    : {};
}

function mergeSection(parent: unknown, child: unknown): SkillFragment {
  return { ...section(parent), ...section(child) };
}

/** Omits a section the composition never mentioned, so the schema still supplies it. */
function nonEmpty(key: string, value: SkillFragment): SkillFragment {
  return Object.keys(value).length > 0 ? { [key]: value } : {};
}

function hasSegments(arc: SkillFragment): boolean {
  return Array.isArray(arc.segments) && arc.segments.length > 0;
}

/**
 * The rules of a fragment, as rules.
 *
 * Rules are the one section that has to be understood before the merge rather
 * than after it, because an inherited one is clamped to the child's defaults.
 * A fragment whose rules do not parse is a broken skill file, and it was
 * already refused when the file was read.
 */
function rulesOf(fragment: SkillFragment): SkillRuleType[] {
  if (!Array.isArray(fragment.rules)) return [];
  return fragment.rules.map((rule) => SkillRule.parse(rule));
}

/**
 * Holds an inherited rule inside the bounds the child skill declared.
 *
 * A rule's duration bound is written against the defaults of the skill it was
 * written in, and inheritance can invert what it means. `base-editor` has a
 * rule called `trim-dead-air` whose whole purpose is to shorten a silent
 * stretch: 4 seconds, against that skill's ceiling of 12. Inherited by
 * `shorts`, which declares a ceiling of 3.5 seconds, the same rule made a
 * wordless shot of a train window the longest clip in a 37-second cut — longer
 * than any moment where somebody speaks. The rule that exists to make things
 * shorter was making one thing longer.
 *
 * So an inherited bound may only narrow the window. A skill's own rule is left
 * alone: `talking-head` deliberately lets a dense explanation run past its own
 * ceiling, and that is the author saying what their style is, in the file where
 * the style lives.
 */
function clampToDefaults(
  rule: SkillRuleType,
  defaults: SkillManifestType['defaults'],
): SkillRuleType {
  const { minimum_duration_sec: min, maximum_duration_sec: max } = rule.action;
  const clampedMin =
    min === undefined ? undefined : Math.max(min, defaults.min_clip_duration_ms / 1000);
  const clampedMax =
    max === undefined ? undefined : Math.min(max, defaults.max_clip_duration_ms / 1000);
  if (clampedMin === min && clampedMax === max) return rule;
  return {
    ...rule,
    action: {
      ...rule.action,
      ...(clampedMin === undefined ? {} : { minimum_duration_sec: clampedMin }),
      ...(clampedMax === undefined ? {} : { maximum_duration_sec: clampedMax }),
    },
  };
}

/** Checks the things a schema cannot: that the arc adds up and rules parse. */
export function validateSkill(manifest: SkillManifestType): string[] {
  const problems: string[] = [];

  if (manifest.arc.segments.length > 0) {
    const total = manifest.arc.segments.reduce((sum, s) => sum + s.budget, 0);
    if (Math.abs(total - 1) > 0.01) {
      problems.push(
        `arc segment budgets sum to ${total.toFixed(2)}, not 1.00 (${manifest.arc.segments
          .map((s) => `${s.name}=${s.budget}`)
          .join(', ')})`,
      );
    }
  }

  if (manifest.defaults.min_clip_duration_ms > manifest.defaults.max_clip_duration_ms) {
    problems.push('min_clip_duration_ms is greater than max_clip_duration_ms');
  }

  const seen = new Set<string>();
  for (const rule of manifest.rules) {
    if (!rule.id) continue;
    if (seen.has(rule.id)) problems.push(`two rules share the id "${rule.id}"`);
    seen.add(rule.id);
  }

  for (const rule of manifest.rules) {
    const action = rule.action as Record<string, unknown>;
    if (Object.keys(action).length === 0) {
      problems.push(
        `rule "${rule.id ?? '(unnamed)'}" has an empty action and can never do anything`,
      );
    }
    if (
      action.minimum_duration_sec !== undefined &&
      action.maximum_duration_sec !== undefined &&
      (action.minimum_duration_sec as number) > (action.maximum_duration_sec as number)
    ) {
      problems.push(`rule "${rule.id ?? '(unnamed)'}" sets a minimum duration above its maximum`);
    }
  }

  return problems;
}
