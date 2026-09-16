import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  EditorialError,
  SkillManifest,
  parseOrThrow,
  type SkillManifest as SkillManifestType,
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
  /** Where it came from, for error messages. */
  origin: string;
  /** Contents of the skill's README, when it has one. */
  readme?: string;
}

export function parseSkill(text: string, origin: string): SkillManifestType {
  let raw: unknown;
  try {
    raw = origin.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
  } catch (error) {
    throw new EditorialError('skill_error', `${origin} is not valid ${origin.endsWith('.json') ? 'JSON' : 'YAML'}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return parseOrThrow(SkillManifest, raw, `skill manifest ${origin}`);
}

export function loadSkillFile(path: string): SkillSource {
  if (!existsSync(path)) {
    throw new EditorialError('not_found', `no skill file at ${path}`);
  }
  const manifest = parseSkill(readFileSync(path, 'utf8'), path);
  const readmePath = join(path, '..', 'SKILL.md');
  return {
    name: manifest.name,
    manifest,
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
    const manifest = this.resolveWithStack(name, []);
    this.resolved.set(name, manifest);
    return manifest;
  }

  private resolveWithStack(name: string, stack: string[]): SkillManifestType {
    if (stack.includes(name)) {
      throw new EditorialError('skill_error', `skills extend each other in a cycle: ${[...stack, name].join(' -> ')}`);
    }

    const source = this.sources.get(name);
    if (!source) {
      throw new EditorialError('not_found', `no skill named "${name}"`, {
        available: [...this.sources.keys()].sort(),
      });
    }

    let merged: SkillManifestType | undefined;
    for (const parentName of source.manifest.extends) {
      const parent = this.resolveWithStack(parentName, [...stack, name]);
      merged = merged ? mergeSkills(merged, parent) : parent;
    }

    const result = merged ? mergeSkills(merged, source.manifest) : source.manifest;
    // The resolved skill keeps its own identity, not its parent's.
    return { ...result, name: source.manifest.name, version: source.manifest.version, extends: source.manifest.extends };
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
 *   is applied later and therefore wins.
 */
export function mergeSkills(parent: SkillManifestType, child: SkillManifestType): SkillManifestType {
  return {
    ...parent,
    ...child,
    defaults: { ...parent.defaults, ...child.defaults },
    scoring: {
      ...parent.scoring,
      ...child.scoring,
      weights: { ...parent.scoring.weights, ...child.scoring.weights },
      flag_weights: { ...parent.scoring.flag_weights, ...child.scoring.flag_weights },
    },
    arc: child.arc.segments.length > 0 ? child.arc : parent.arc,
    constraints: { ...parent.constraints, ...child.constraints },
    intent: { ...parent.intent, ...child.intent },
    rules: [...parent.rules, ...child.rules],
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
      problems.push(`rule "${rule.id ?? '(unnamed)'}" has an empty action and can never do anything`);
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
