// A stand-in for the Python perception worker, speaking the same JSON Lines
// protocol. It exists so the transport can be tested without Python installed.
import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'normal';
const rl = createInterface({ input: process.stdin });

if (mode === 'noise') {
  // A dependency printing to stdout is the classic way a worker corrupts its
  // own protocol stream. The client must survive it.
  process.stdout.write('Downloading model: 10%\n');
}

rl.on('line', (line) => {
  const request = JSON.parse(line);
  const reply = (body) => process.stdout.write(`${JSON.stringify({ v: '0.1.0', id: request.id, ...body })}\n`);

  switch (request.op) {
    case 'health':
      reply({
        ok: true,
        op: 'health',
        result: {
          protocol_version: '0.1.0',
          worker_version: 'fake-1',
          capabilities: { transcribe: true },
          device: 'cpu',
          ffmpeg_available: false,
        },
      });
      break;
    case 'probe':
      if (mode === 'slow') break; // never answers, to exercise the timeout
      process.stdout.write(
        `${JSON.stringify({ v: '0.1.0', id: request.id, event: 'progress', progress: 0.5, message: 'probing' })}\n`,
      );
      reply({ ok: true, op: 'probe', result: { duration_ms: 1234, metadata: {} } });
      break;
    case 'embed_text':
      reply({
        ok: true,
        op: 'embed_text',
        result: { dim: 2, vectors: request.params.texts.map((_, i) => [i, 1 - i]) },
      });
      break;
    case 'transcribe':
      reply({
        ok: false,
        op: 'transcribe',
        error: { code: 'missing_dependency', message: 'faster-whisper is not installed' },
      });
      break;
    case 'detect_shots':
      // A malformed result: the client must reject it rather than pass it on.
      reply({ ok: true, op: 'detect_shots', result: { shots: [{ start_ms: 'soon' }] } });
      break;
    case 'shutdown':
      reply({ ok: true, op: 'shutdown', result: {} });
      process.exit(0);
      break;
    case 'crash':
      process.exit(3);
      break;
    default:
      reply({ ok: false, op: request.op, error: { code: 'unsupported_op', message: request.op } });
  }
});
