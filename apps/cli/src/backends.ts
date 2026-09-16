import { existsSync } from 'node:fs';
import { EditorialError } from '@editorial-ir/contracts';
import {
  HeuristicContextModel,
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
  createFixtureSuite,
  createLocalSuite,
  loadPerceptionFixture,
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

export function resolveBackends(options: BackendOptions = {}): ResolvedBackends {
  const description: string[] = [];
  const closers: (() => Promise<void>)[] = [];

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
    suite = {
      probe: new WorkerMediaProbe(client),
      preparer: new WorkerMediaPreparer(client),
      speech: new WorkerSpeechModel(client),
      shots: new WorkerShotDetector(client),
      audio: new WorkerAudioModel(client),
      ocr: new WorkerOcrModel(client),
      context: new WorkerContextModel(client),
      text: new WorkerTextEmbeddingModel(client),
    };
    description.push(`perception: the Python runtime (${command})`);
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

  if (!suite.context) {
    suite = { ...suite, context: new HeuristicContextModel() };
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
