import { existsSync } from 'node:fs';
import {
  EditorialError,
  type AnalysisStage,
  type ExecutionLocality,
  type StandInReason,
} from '@editorial-ir/contracts';
import {
  HashingTextEmbedding,
  OpenAiCompatibleContextModel,
  OpenAiCompatibleTextEmbedding,
  PythonWorkerClient,
  WorkerAudioModel,
  WorkerContextModel,
  WorkerMediaPreparer,
  WorkerMediaProbe,
  WorkerOcrModel,
  WorkerShotDetector,
  WorkerSpeechModel,
  WorkerTextEmbeddingModel,
  WorkerVisualEmbeddingModel,
  createFixtureSuite,
  createLocalSuite,
  isLocalEndpoint,
  loadPerceptionFixture,
  workerHealth,
  type ContextModel,
  type PerceptionSuite,
} from '@editorial-ir/perception';
import {
  FallbackDecisionBackend,
  HeuristicDecisionBackend,
  JevBackend,
  LocalSystemOneBackend,
  type EditorialDecisionModel,
} from '@editorial-ir/decision';

/**
 * Choosing which models to run.
 *
 * Where perception comes from:
 *
 * - `local` needs ffmpeg and nothing else. No GPU, no network, no key, no cost.
 * - `python` adds the perception runtime: real transcription, real vision.
 * - `fixture` replays recorded perception, which is how the worked example and
 *   the tests run anywhere.
 *
 * Model endpoints are configured through the environment rather than flags,
 * because a key does not belong in shell history, and because whether one is
 * available is a property of the machine rather than of the command being run.
 *
 * ## Why this refuses to run by default
 *
 * Every stage here has a stand-in, so an unconfigured install can analyse
 * footage end to end and produce an IR with every field populated. That is a
 * good property and it hid a bad one: the rules-and-hashing IR is *much* worse
 * than the model-backed one, and nothing about it says so. Benchmarks were
 * measuring the rules while reporting a number about the product.
 *
 * So the standard path is the default, it requires a model for each of the three
 * stages that decide the edit, and it fails with a list when one is missing.
 * `--offline-minimal` is the way to say you meant it — and what comes out is
 * stamped `offline_minimal`, so nothing downstream can mistake it for a
 * measurement.
 */

/** What a run is willing to accept. Never a claim about what it got. */
export type QualityMode = 'standard' | 'offline-minimal';

export interface BackendOptions {
  perception?: string;
  decision?: string;
  /** Defaults to `standard`, which refuses to run on stand-ins. */
  mode?: QualityMode;
  onLog?: (message: string) => void;
}

/** A decisive stage with no model behind it. */
export interface MissingModel {
  stage: AnalysisStage;
  using: string;
  remedy: string;
}

export interface ResolvedBackends {
  suite: PerceptionSuite;
  decision: EditorialDecisionModel;
  escalationContext?: ContextModel;
  escalationDecision?: EditorialDecisionModel;
  /** Human-readable summary, for `oea doctor` and for the analyse report. */
  description: string[];
  /** The mode that was asked for. Passed to the compiler to label its stand-ins. */
  mode: QualityMode;
  standInReason: StandInReason;
  /**
   * Decisive stages running on a stand-in. Empty in standard mode, because
   * standard mode refuses to resolve otherwise — `oea doctor` asks for
   * `mode: 'offline-minimal'` precisely so it can report this instead.
   */
  missing: MissingModel[];
  close(): Promise<void>;
}

export async function resolveBackends(options: BackendOptions = {}): Promise<ResolvedBackends> {
  const description: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  // A worker whose closer look reaches off this machine. Held aside so it can
  // become the escalation model rather than the per-event default.
  let remoteWorkerContext: ContextModel | undefined;

  const perception = options.perception ?? process.env.OEA_PERCEPTION ?? 'local';
  let suite: PerceptionSuite;

  if (perception.startsWith('fixture')) {
    const path = perception.includes(':') ? perception.slice(perception.indexOf(':') + 1) : '';
    if (!path || !existsSync(path)) {
      throw new EditorialError(
        'invalid_input',
        `--perception fixture:<path> needs a fixture file that exists`,
        {
          given: path,
        },
      );
    }
    suite = createFixtureSuite(loadPerceptionFixture(path));
    description.push(`perception: replayed from ${path}`);
  } else if (perception.startsWith('python')) {
    const command = perception.includes(':')
      ? perception.slice(perception.indexOf(':') + 1)
      : 'python3';
    const client = new PythonWorkerClient({
      command,
      ...(options.onLog ? { onLog: options.onLog } : {}),
    });
    closers.push(() => client.close());

    // Ask the worker what it can actually do, and wire only that.
    //
    // The worker reports its capabilities honestly — a machine with no
    // faster-whisper says `transcribe: false` — and wiring a model it has just
    // said it cannot run turns "this stage is unavailable" into "the whole
    // analysis failed". The compiler is built to degrade around a missing
    // model; it cannot degrade around one that is present and throws.
    const { capabilities, stageLocality, stageModels } = await workerHealthOrNothing(
      client,
      options.onLog,
    );
    // The name that decides a stage's output, which only the worker knows. The
    // perception cache keys on it, so a placeholder meant changing the ASR
    // model and re-running served the old model's transcript. A worker that
    // does not answer leaves the placeholder, which at least does not claim to
    // be a model anyone chose.
    const named = (stage: string, fallback: string): string => stageModels[stage] ?? fallback;
    const has = (name: keyof typeof capabilities): boolean => capabilities[name] === true;
    // Where the worker says its describe would run. A worker that does not
    // answer, or an older one that does not know the question, leaves this
    // `unknown` — which is what goes into the record, rather than `local`.
    const describeLocality: ExecutionLocality =
      stageLocality.describe === 'local' || stageLocality.describe === 'remote_api'
        ? stageLocality.describe
        : 'unknown';

    suite = {
      probe: new WorkerMediaProbe(client),
      ...(has('prepare') ? { preparer: new WorkerMediaPreparer(client) } : {}),
      ...(has('transcribe')
        ? { speech: new WorkerSpeechModel(client, named('transcribe', 'asr')) }
        : {}),
      ...(has('detect_shots') ? { shots: new WorkerShotDetector(client) } : {}),
      ...(has('analyze_audio') ? { audio: new WorkerAudioModel(client) } : {}),
      ...(has('ocr') ? { ocr: new WorkerOcrModel(client) } : {}),
      // A worker-backed closer look is the base model only when it runs here.
      // The base pass goes over *every* event, and the worker's `describe` is an
      // HTTP call to whatever OEA_VLM_BASE_URL names — so pointing the worker at
      // a hosted service made a paid endpoint the per-event default, outside
      // `--budget` and recorded at a cost of zero. A remote one becomes the
      // escalation model below, which is where spending is decided and counted.
      ...(has('describe') && describeLocality !== 'remote_api'
        ? { context: new WorkerContextModel(client, named('describe', 'vlm'), describeLocality) }
        : {}),
      ...(has('embed_frames')
        ? { visual: new WorkerVisualEmbeddingModel(client, named('embed_frames', 'visual')) }
        : {}),
      text: has('embed_text')
        ? new WorkerTextEmbeddingModel(client, named('embed_text', 'text-embedding'))
        : new HashingTextEmbedding(),
    };

    if (has('describe') && describeLocality === 'remote_api') {
      remoteWorkerContext = new WorkerContextModel(
        client,
        named('describe', 'vlm'),
        describeLocality,
      );
    }

    const missing = Object.entries(capabilities)
      .filter(([, able]) => able !== true)
      .map(([name]) => name);
    description.push(`perception: the Python runtime (${command})`);
    if (missing.length > 0) {
      description.push(`  the worker cannot: ${missing.join(', ')}`);
      description.push(`  add them with: pip install 'editorial-perception[all]'`);
    }
  } else {
    suite = createLocalSuite();
    description.push('perception: ffmpeg only (no transcription, no vision)');
  }

  // A configured embedding service replaces the hashing stand-in everywhere.
  const embedBase = process.env.OEA_EMBED_BASE_URL;
  const embedModel = process.env.OEA_EMBED_MODEL;
  if (embedBase && embedModel) {
    suite = {
      ...suite,
      text: new OpenAiCompatibleTextEmbedding({
        baseUrl: embedBase,
        model: embedModel,
        ...(process.env.OEA_EMBED_API_KEY ? { apiKey: process.env.OEA_EMBED_API_KEY } : {}),
      }),
    };
    description.push(`embeddings: ${embedModel} at ${embedBase}`);
  } else if (suite.text.identity.standIn) {
    description.push('embeddings: hashing (lexical — matches words, not meaning)');
  } else {
    description.push(`embeddings: ${suite.text.identity.model ?? suite.text.identity.backend}`);
  }

  // ---- the look at each event ----------------------------------------------
  //
  // One model, two possible jobs, and which one it takes is about cost rather
  // than quality.
  //
  // A model on this machine is free per call, so it should describe *every*
  // event: that is what makes descriptions a model's work rather than a
  // template's. A hosted model is not free, and making it the per-event default
  // would put a paid call on every event of a one-hour project — so by default
  // it waits for the events that earn it, and the base pass keeps the rules.
  //
  // That default is a cost decision, and it is the operator's to overturn:
  // OEA_VLM_SCOPE=base says "describe everything with it and bill me", which is
  // also the only way a hosted-only setup reaches standard quality.
  let escalationContext: ContextModel | undefined;
  const vlmBase = process.env.OEA_VLM_BASE_URL;
  const vlmModel = process.env.OEA_VLM_MODEL;
  if (vlmBase && vlmModel) {
    const configured = process.env.OEA_VLM_SCOPE;
    if (configured !== undefined && configured !== 'base' && configured !== 'escalation') {
      throw new EditorialError('invalid_input', `OEA_VLM_SCOPE must be "base" or "escalation"`, {
        given: configured,
      });
    }
    const scope = configured ?? (isLocalEndpoint(vlmBase) ? 'base' : 'escalation');
    const vlm = new OpenAiCompatibleContextModel({
      baseUrl: vlmBase,
      model: vlmModel,
      ...(process.env.OEA_VLM_API_KEY ? { apiKey: process.env.OEA_VLM_API_KEY } : {}),
    });
    if (scope === 'base') {
      // Only when the suite has nothing better already. A worker running the
      // model in-process beats an HTTP hop to the same machine.
      if (suite.context === undefined || suite.context.identity.standIn) {
        suite = { ...suite, context: vlm };
        description.push(`descriptions: ${vlmModel} at ${vlmBase}, on every event`);
      } else {
        escalationContext = vlm;
        description.push(`closer look: ${vlmModel} at ${vlmBase}`);
      }
    } else {
      escalationContext = vlm;
      description.push(`closer look: ${vlmModel} at ${vlmBase} (the events that earn it)`);
      description.push(`  OEA_VLM_SCOPE=base would describe every event with it, at a cost`);
    }
  } else if (remoteWorkerContext) {
    // The worker has a hosted model configured and this process cannot see
    // which: reaching it through the worker for the events that earn it is
    // better than not reaching it at all, and better than reaching it for all
    // of them.
    escalationContext = remoteWorkerContext;
    description.push('closer look: through the Python worker, to a remote endpoint');
  }

  // ---- decision ------------------------------------------------------------
  const decisionChoice = options.decision ?? process.env.OEA_DECISION ?? 'heuristic';
  const heuristic = new HeuristicDecisionBackend();
  let decision: EditorialDecisionModel = heuristic;
  let escalationDecision: EditorialDecisionModel | undefined;

  const decisionBase = process.env.OEA_DECISION_BASE_URL;
  const decisionModel = process.env.OEA_DECISION_MODEL;

  if (decisionChoice === 'local-system-one' || decisionChoice === 'model') {
    if (!decisionBase || !decisionModel) {
      throw new EditorialError(
        'invalid_input',
        'a model decision backend needs OEA_DECISION_BASE_URL and OEA_DECISION_MODEL',
      );
    }
    // Wrapped so that a model server restarting at event four hundred degrades
    // instead of losing the whole compile.
    decision = new FallbackDecisionBackend(
      new LocalSystemOneBackend({
        baseUrl: decisionBase,
        model: decisionModel,
        ...(process.env.OEA_DECISION_API_KEY ? { apiKey: process.env.OEA_DECISION_API_KEY } : {}),
      }),
      heuristic,
      {
        ...(options.onLog
          ? { onFallback: (_error, id) => options.onLog?.(`decision fell back on ${id}`) }
          : {}),
      },
    );
    description.push(`judgement: ${decisionModel} at ${decisionBase}, falling back to rules`);
  } else if (decisionChoice === 'jev') {
    const jevBase = process.env.OEA_JEV_BASE_URL;
    if (!jevBase) {
      throw new EditorialError('invalid_input', 'the jev decision backend needs OEA_JEV_BASE_URL');
    }
    decision = new FallbackDecisionBackend(
      new JevBackend({
        baseUrl: jevBase,
        ...(process.env.OEA_JEV_API_KEY ? { apiKey: process.env.OEA_JEV_API_KEY } : {}),
      }),
      heuristic,
    );
    description.push(
      `judgement: an external decision service at ${jevBase}, falling back to rules`,
    );
  } else {
    description.push('judgement: rules (free, instant, reproducible)');
    // With a model configured but not selected as the primary, use it only where
    // the rules are unsure. That is the hybrid mode, and it is the one that
    // usually makes sense.
    if (decisionBase && decisionModel) {
      escalationDecision = new LocalSystemOneBackend({
        baseUrl: decisionBase,
        model: decisionModel,
        ...(process.env.OEA_DECISION_API_KEY ? { apiKey: process.env.OEA_DECISION_API_KEY } : {}),
      });
      description.push(
        `second opinion: ${decisionModel}, on the events the rules are unsure about`,
      );
    }
  }

  // ---- is this the standard path, or a sketch of it? -----------------------
  const mode: QualityMode = options.mode ?? 'standard';
  const close = async (): Promise<void> => {
    for (const closer of closers) await closer();
    await suite.close?.();
    await decision.close?.();
  };
  const missing = missingModels(suite, decision);

  if (mode === 'standard' && missing.length > 0) {
    // Nothing has been read or written yet, and a Python worker may be running.
    await close();
    throw new EditorialError('invalid_input', standardModeRefusal(missing), {
      missing: missing.map((m) => m.stage),
      hint: 'or pass --offline-minimal to analyse without them',
    });
  }

  return {
    suite,
    decision,
    ...(escalationContext ? { escalationContext } : {}),
    ...(escalationDecision ? { escalationDecision } : {}),
    description,
    mode,
    standInReason: mode === 'offline-minimal' ? 'requested' : 'not_configured',
    missing,
    close,
  };
}

/**
 * The decisive stages that have no model behind them.
 *
 * Asked of the resolved backends rather than of the environment variables that
 * configured them, because those are not the same question: a variable can be
 * set and point at a closed port, and a worker can be running a model nobody
 * configured here. What matters is what will actually run.
 */
export function missingModels(
  suite: PerceptionSuite,
  decision: EditorialDecisionModel,
): MissingModel[] {
  const missing: MissingModel[] = [];
  const add = (
    stage: AnalysisStage,
    standIn: { insteadOf: string; remedy?: string } | undefined,
    using: string,
  ): void => {
    if (standIn)
      missing.push({ stage, using, remedy: standIn.remedy ?? `configure ${standIn.insteadOf}` });
  };

  // An absent context model is the same situation as a rule-based one: the
  // compiler substitutes its own, and every event gets a template.
  if (suite.context === undefined) {
    missing.push({
      stage: 'description',
      using: 'a summary of the observations',
      remedy: 'set OEA_VLM_BASE_URL and OEA_VLM_MODEL, or install the Python runtime',
    });
  } else {
    add('description', suite.context.identity.standIn, suite.context.identity.model ?? 'rules');
  }
  add('judgement', decision.identity.standIn, decision.identity.model ?? 'rules');
  add('text_embedding', suite.text.identity.standIn, suite.text.identity.model ?? 'hashing');
  return missing;
}

function standardModeRefusal(missing: readonly MissingModel[]): string {
  const width = Math.max(...missing.map((m) => m.stage.length));
  const rows = missing
    .map(
      (m) => `  ${m.stage.padEnd(width)}  now: ${m.using}
  ${' '.repeat(width)}  fix: ${m.remedy}`,
    )
    .join('\n');
  return [
    `standard quality needs a model for each stage that decides the edit; ${missing.length} ${missing.length === 1 ? 'is' : 'are'} missing:`,
    '',
    rows,
    '',
    'Any OpenAI-compatible server will do — Ollama, vLLM, LM Studio, llama.cpp, or a',
    'hosted provider. "oea doctor" reports what this machine can actually reach.',
    '',
    'To analyse without them, pass --offline-minimal. It is free and instant, and the',
    'result is stamped offline_minimal so it is never mistaken for a measure of quality.',
  ].join('\n');
}

/**
 * What the Python worker says it can run.
 *
 * A worker that will not answer is not a reason to fail: it may still be able to
 * probe media, and the caller finds out soon enough. Assume nothing in that case
 * rather than assuming everything, which is what wiring every model did.
 */
async function workerHealthOrNothing(
  client: PythonWorkerClient,
  onLog?: (message: string) => void,
): Promise<{
  capabilities: Record<string, boolean>;
  stageLocality: Record<string, string>;
  stageModels: Record<string, string>;
}> {
  try {
    const health = await workerHealth(client);
    return {
      capabilities: health.capabilities,
      stageLocality: health.stage_locality,
      stageModels: health.stage_models,
    };
  } catch (error) {
    onLog?.(
      `the Python worker did not answer health (${error instanceof Error ? error.message : String(error)})`,
    );
    return { capabilities: {}, stageLocality: {}, stageModels: {} };
  }
}
