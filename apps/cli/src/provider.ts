import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

/**
 * One key for every model stage.
 *
 * Description, judgement and search each take a base URL, a model and a key
 * (`OEA_VLM_*`, `OEA_DECISION_*`, `OEA_EMBED_*`), which is right for mixing a
 * local server with a hosted one and a chore for the common case: one provider
 * account that can do all three. Gemini's OpenAI-compatible endpoint does all
 * three — pictures in chat completions, JSON-schema output, and embeddings — so
 * a single variable can stand for nine:
 *
 *     OEA_GEMINI_API_KEY=…
 *
 * The preset only fills what is not already set. A stage configured by its own
 * variables keeps them whole — its URL is never paired with this key — so a
 * local vision model beside Gemini judgement is still one line each.
 *
 * It needs asking for. A `GEMINI_API_KEY` that other tools put in the shell
 * turns nothing on by itself, because turning it on sends frames to Google, and
 * "video is never sent anywhere by default" is a promise the README makes.
 * `OEA_GEMINI_API_KEY`, or `OEA_PROVIDER=gemini` beside the generic name, is
 * the asking.
 */

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

/**
 * The models the preset asks for, when the key's own list has them.
 *
 * Description sees frames and writes Japanese as often as English, so it gets
 * the general Flash model. Judgement is the call made for every event and the
 * one that carries the long question set (about 1,560 input tokens an event,
 * twelve times a description), so it gets the cheapest capable tier. Names
 * move every few months; `confirmPresetModels` falls back to the newest of the
 * same family the key can reach rather than failing on a retired one.
 */
export const GEMINI_DEFAULTS = {
  describe: 'gemini-3.8-flash',
  judge: 'gemini-3.5-flash-lite',
  embed: 'gemini-embedding-001',
} as const;

export type PresetRole = keyof typeof GEMINI_DEFAULTS;

export interface ProviderPreset {
  provider: 'gemini';
  /** Which variable the key came from, for `oea doctor`. Never the key. */
  keyFrom: string;
  /** The model each role asks for, and whether the user named it. */
  models: Record<PresetRole, { model: string; named: boolean }>;
  /** Stages left alone because their own variables were already set. */
  keptOwn: string[];
  /** Variables this preset set. */
  filled: string[];
}

type Env = Record<string, string | undefined>;

/**
 * Settings from a `.env` file in the working directory, where the environment
 * does not already have them.
 *
 * So that "put the key in a file" is the whole of the local setup: copy
 * `.env.example` to `.env` and paste the key. Variables already set win, the
 * way `node --env-file` does it, so a shell or a CI secret is never overridden
 * by a file someone left behind. `.env` is in `.gitignore`.
 */
export function loadDotEnv(env: Env = process.env, directory = process.cwd()): string[] {
  const path = join(directory, '.env');
  if (!existsSync(path)) return [];
  let parsed: Record<string, string | undefined>;
  try {
    parsed = parseEnv(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
  const loaded: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] !== undefined || value === undefined || value === '') continue;
    env[key] = value;
    loaded.push(key);
  }
  return loaded;
}

/**
 * Fills the stage variables from one Gemini key, and says what it did.
 *
 * Mutates `env` (normally `process.env`) on purpose: the Python worker is a
 * child process and reads the same variables, so the preset has to be where
 * both runtimes look.
 */
export function applyProviderPreset(env: Env = process.env): ProviderPreset | undefined {
  const found = presetKey(env);
  if (!found) return undefined;
  const { key, keyFrom } = found;

  const chosen = (variable: string, role: PresetRole) => {
    const named = env[variable]?.trim();
    return named ? { model: named, named: true } : { model: GEMINI_DEFAULTS[role], named: false };
  };
  const models: ProviderPreset['models'] = {
    describe: chosen('OEA_GEMINI_MODEL', 'describe'),
    judge: chosen('OEA_GEMINI_JUDGE_MODEL', 'judge'),
    embed: chosen('OEA_GEMINI_EMBED_MODEL', 'embed'),
  };

  const filled: string[] = [];
  const keptOwn: string[] = [];
  const set = (name: string, value: string) => {
    if (env[name] !== undefined && env[name] !== '') return;
    env[name] = value;
    filled.push(name);
  };
  // A stage is the preset's only when its base URL is not already someone
  // else's: pairing this key with another provider's URL would send the key
  // there, and a model name from one provider means nothing to another.
  const stage = (prefix: string, model: string) => {
    if (env[`${prefix}_BASE_URL`]) {
      keptOwn.push(prefix);
      return;
    }
    set(`${prefix}_BASE_URL`, GEMINI_BASE_URL);
    set(`${prefix}_MODEL`, model);
    set(`${prefix}_API_KEY`, key);
  };

  const describeWasOurs = !env.OEA_VLM_BASE_URL;
  stage('OEA_VLM', models.describe.model);
  // A hosted model describes only the events that earn a closer look unless
  // told otherwise, which leaves every other event with a template and makes
  // `oea analyze` refuse standard quality. With one key being the whole setup,
  // it describes every event; the still-and-silent mask and --budget are what
  // keep that bounded, and OEA_VLM_SCOPE=escalation puts it back.
  if (describeWasOurs) set('OEA_VLM_SCOPE', 'base');

  const judgeWasOurs = !env.OEA_DECISION_BASE_URL;
  stage('OEA_DECISION', models.judge.model);
  if (judgeWasOurs) set('OEA_DECISION', 'local-system-one');

  stage('OEA_EMBED', models.embed.model);
  // `oea agent` plans with a model in the loop; the describing model is the
  // capable one of the two.
  stage('OEA_AGENT', models.describe.model);

  return { provider: 'gemini', keyFrom, models, keptOwn, filled };
}

/**
 * The key the preset runs on and the variable it came from, or nothing when
 * the preset was not asked for.
 */
function presetKey(env: Env): { key: string; keyFrom: string } | undefined {
  const own = env.OEA_GEMINI_API_KEY?.trim();
  if (own) return { key: own, keyFrom: 'OEA_GEMINI_API_KEY' };
  if (env.OEA_PROVIDER?.trim().toLowerCase() !== 'gemini') return undefined;
  for (const name of ['GEMINI_API_KEY', 'GOOGLE_API_KEY']) {
    const value = env[name]?.trim();
    if (value) return { key: value, keyFrom: name };
  }
  return undefined;
}

/** A model family and its version, read from a Gemini model id. */
function versionOf(id: string, family: RegExp): number[] | undefined {
  const match = family.exec(id);
  if (!match?.[1]) return undefined;
  return match[1].split('.').map(Number);
}

function newer(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * The same kind of model as the one asked for, newest first, from what the key
 * can reach. Only plain stable names: a `-preview`, `-exp`, `-image`, `-tts` or
 * `-live` variant is a different product with a different price and a
 * different contract, and choosing one silently would change the analysis in a
 * way nobody asked for.
 */
export function newestOfFamily(role: PresetRole, available: readonly string[]): string | undefined {
  const family =
    role === 'embed'
      ? /^gemini-embedding-(\d+)$/
      : role === 'judge'
        ? /^gemini-(\d+(?:\.\d+)?)-flash-lite$/
        : /^gemini-(\d+(?:\.\d+)?)-flash$/;
  const candidates = available
    .map((id) => ({ id, version: versionOf(id, family) }))
    .filter((c): c is { id: string; version: number[] } => c.version !== undefined)
    .sort((a, b) => newer(b.version, a.version));
  if (candidates[0]) return candidates[0].id;
  // No Flash-Lite on this key: the describing tier judges too.
  return role === 'judge' ? newestOfFamily('describe', available) : undefined;
}

export interface PresetCheck {
  /** Lines worth saying: a model replaced, or a list that could not be read. */
  notes: string[];
  /** The key was refused outright. Nothing that needs a model can run. */
  refused?: string;
}

/**
 * Asks Gemini which models this key can use, and moves any default the list
 * does not have onto the newest of its family.
 *
 * One cheap request, made only by the commands that are about to call a model.
 * A model the user named is never replaced — they may know about one the list
 * does not show — but is reported when the list lacks it. A list that cannot be
 * read changes nothing: the defaults are tried as they are, and whatever fails
 * fails with the provider's own message.
 */
export async function confirmPresetModels(
  preset: ProviderPreset,
  env: Env = process.env,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<PresetCheck> {
  const key = presetKey(env)?.key ?? '';
  const notes: string[] = [];
  let available: string[];
  try {
    const response = await fetchImpl(`${GEMINI_BASE_URL}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      const body = (await response.text()).slice(0, 300);
      return {
        notes,
        refused: `Gemini refused the key in ${preset.keyFrom} (${response.status}): ${oneLine(body)}`,
      };
    }
    if (!response.ok) {
      notes.push(
        `could not list the Gemini models (${response.status}); trying ${describePreset(preset)}`,
      );
      return { notes };
    }
    const payload = (await response.json()) as { data?: { id?: unknown }[] };
    available = (payload.data ?? [])
      .map((entry) => (typeof entry.id === 'string' ? entry.id.replace(/^models\//, '') : ''))
      .filter((id) => id.length > 0);
  } catch (error) {
    notes.push(
      `could not reach Gemini to list its models (${error instanceof Error ? error.message : String(error)}); ` +
        `trying ${describePreset(preset)}`,
    );
    return { notes };
  }
  if (available.length === 0) return { notes };

  const variables: Record<PresetRole, string[]> = {
    describe: ['OEA_VLM_MODEL', 'OEA_AGENT_MODEL'],
    judge: ['OEA_DECISION_MODEL'],
    embed: ['OEA_EMBED_MODEL'],
  };
  for (const role of Object.keys(variables) as PresetRole[]) {
    const wanted = preset.models[role];
    if (available.includes(wanted.model)) continue;
    const owned = variables[role].filter((name) => preset.filled.includes(name));
    if (owned.length === 0) continue;
    if (wanted.named) {
      notes.push(`${wanted.model} is not in the models this Gemini key lists; using it anyway`);
      continue;
    }
    const replacement = newestOfFamily(role, available);
    if (!replacement) {
      notes.push(`${wanted.model} is not available to this key, and nothing like it is`);
      continue;
    }
    for (const name of owned) env[name] = replacement;
    wanted.model = replacement;
    notes.push(
      `${GEMINI_DEFAULTS[role]} is not available to this key; using ${replacement} for ${roleWords(role)}`,
    );
  }
  return { notes };
}

/** "gemini-x for descriptions, …", for a message. */
export function describePreset(preset: ProviderPreset): string {
  return (Object.keys(preset.models) as PresetRole[])
    .map((role) => `${preset.models[role].model} for ${roleWords(role)}`)
    .join(', ');
}

function roleWords(role: PresetRole): string {
  return role === 'describe' ? 'descriptions' : role === 'judge' ? 'judgement' : 'search';
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
