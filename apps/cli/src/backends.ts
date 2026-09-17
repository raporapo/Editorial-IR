import { existsSync } from 'node:fs';
import { EditorialError, type ExecutionLocality } from '@editorial-ir/contracts';
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
 * Three modes, and the first one is the default because it is the one that
 * always works:
 *
 * - `local` needs ffmpeg and nothing else. No GPU, no network, no key, no cost.
 * - `python` adds the perception runtime: real transcription, real vision.
 * - `fixture` replays recorded perception, which is how the worked example and
 *   the tests run anywhere.
 *
 * Stronger models for the hard events are configured through the environment
 * rather than flags, because a key does not belong in shell history, and because
 * whether one is available is a property of the machine rather than of the
 * command being run.
 */
export interface BackendOptions {
  perception?: string;
  decision?: string;
  onLog?: (message: string) => void;
}

export interface ResolvedBackends {
  suite: PerceptionSuite;
  decision: EditorialDecisionModel;
  escalationContext?: ContextModel;
  escalationDecision?: EditorialDecisionModel;
  /** Human-readable summary, for `oea doctor` and for the analyse report. */
  description: string[];
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
    const { capabilities, stageLocality } = await workerHealthOrNothing(client, options.onLog);
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
      ...(has('transcribe') ? { speech: new WorkerSpeechModel(client) } : {}),
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
        ? { context: new WorkerContextModel(client, 'vlm', describeLocality) }
        : {}),
      ...(has('embed_frames') ? { visual: new WorkerVisualEmbeddingModel(client) } : {}),
      text: has('embed_text') ? new WorkerTextEmbeddingModel(client) : new HashingTextEmbedding(),
    };

    if (has('describe') && describeLocality === 'remote_api') {
      remoteWorkerContext = new WorkerContextModel(client, 'vlm', describeLocality);
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
  } else {
    description.push('embeddings: hashing (lexical, no model)');
  }

  // The expensive look, for the events that earn it.
  let escalationContext: ContextModel | undefined;
  const vlmBase = process.env.OEA_VLM_BASE_URL;
  const vlmModel = process.env.OEA_VLM_MODEL;
  if (vlmBase && vlmModel) {
    escalationContext = new OpenAiCompatibleContextModel({
      baseUrl: vlmBase,
      model: vlmModel,
      ...(process.env.OEA_VLM_API_KEY ? { apiKey: process.env.OEA_VLM_API_KEY } : {}),
    });
    description.push(`closer look: ${vlmModel} at ${vlmBase}`);
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

  return {
    suite,
    decision,
    ...(escalationContext ? { escalationContext } : {}),
    ...(escalationDecision ? { escalationDecision } : {}),
    description,
    close: async () => {
      for (const close of closers) await close();
      await suite.close?.();
      await decision.close?.();
    },
  };
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
): Promise<{ capabilities: Record<string, boolean>; stageLocality: Record<string, string> }> {
  try {
    const health = await workerHealth(client);
    return { capabilities: health.capabilities, stageLocality: health.stage_locality };
  } catch (error) {
    onLog?.(
      `the Python worker did not answer health (${error instanceof Error ? error.message : String(error)})`,
    );
    return { capabilities: {}, stageLocality: {} };
  }
}
