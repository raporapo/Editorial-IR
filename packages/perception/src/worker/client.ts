import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import {
  EditorialError,
  PERCEPTION_PROTOCOL_VERSION,
  PERCEPTION_RESULT_SCHEMAS,
  PerceptionEvent,
  PerceptionResponse,
  parseOrThrow,
  type PerceptionOp,
  type PerceptionResultMap,
} from '@editorial-ir/contracts';

/**
 * The transport to the Python perception runtime.
 *
 * One JSON object per line in each direction over a subprocess, correlated by
 * request id. Logs go to stderr, so a chatty dependency printing a download bar
 * can never corrupt the protocol stream — which is exactly what happens the
 * first time a model downloads itself on a user's machine.
 *
 * The transport is not the architecture. Replacing this with HTTP or a queue
 * changes this file and nothing else, because both sides only ever agreed on the
 * schemas in `@editorial-ir/contracts`.
 */
export interface PythonWorkerOptions {
  /** Interpreter or launcher, e.g. `python3` or `uv`. */
  command?: string;
  /** Arguments before the protocol flags. */
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Default per-request timeout. Model loading on first use can be slow. */
  timeoutMs?: number;
  onProgress?: (event: { id: string; progress?: number; message?: string }) => void;
  onLog?: (line: string) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  op: PerceptionOp;
  timer?: NodeJS.Timeout;
}

export class PythonWorkerClient {
  private child?: ChildProcessWithoutNullStreams;
  private reader?: Interface;
  private readonly pending = new Map<string, Pending>();
  private counter = 0;
  private exitReason?: string;
  private startPromise?: Promise<void>;

  constructor(private readonly options: PythonWorkerOptions = {}) {}

  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.startPromise ??= this.doStart();
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    const command = this.options.command ?? 'python3';
    const args = this.options.args ?? ['-m', 'editorial_perception'];

    const child = spawn(command, args, {
      cwd: this.options.cwd,
      env: { ...process.env, PYTHONUNBUFFERED: '1', ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.exitReason = undefined;

    child.on('error', (error) => {
      if (this.child !== child) return;
      this.failAll(
        new EditorialError(
          'perception_failed',
          `could not start the perception worker: ${error.message}`,
          {
            command,
            args,
          },
        ),
      );
    });

    child.on('exit', (code, signal) => {
      // Only if this is still the worker in use. A replacement may already have
      // been started — after a timeout, or after a caller restarted one
      // deliberately — and clearing the start promise of a worker that is
      // coming up would let a second process be spawned beside it.
      if (this.child !== child) return;
      this.exitReason = `worker exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}`;
      this.startPromise = undefined;
      this.child = undefined;
      this.failAll(new EditorialError('perception_failed', this.exitReason));
    });

    // A worker that has already exited turns any further write into an EPIPE on
    // the stream itself. Pending requests are failed by the exit handler, so the
    // stream error carries no extra information and must not become an
    // unhandled exception in the host process.
    child.stdin.on('error', () => undefined);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim().length > 0) this.options.onLog?.(line);
      }
    });

    this.reader = createInterface({ input: child.stdout });
    this.reader.on('line', (line) => this.handleLine(line));
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // A worker that prints to stdout is misbehaving, but it should not take
      // down the run: treat the line as a log and carry on.
      this.options.onLog?.(`non-JSON line from worker: ${trimmed.slice(0, 200)}`);
      return;
    }

    const asEvent = PerceptionEvent.safeParse(parsed);
    if (asEvent.success) {
      const event = asEvent.data;
      if (event.event === 'progress') {
        this.options.onProgress?.({
          id: event.id,
          ...(event.progress === undefined ? {} : { progress: event.progress }),
          ...(event.message === undefined ? {} : { message: event.message }),
        });
      } else if (event.message) {
        this.options.onLog?.(event.message);
      }
      return;
    }

    const response = PerceptionResponse.safeParse(parsed);
    if (!response.success) {
      // A reply this version cannot parse must still settle the request it
      // belongs to. Leaving it pending turns a protocol mismatch into a hang,
      // which is a far worse failure than an error message.
      const id = (parsed as { id?: unknown }).id;
      if (typeof id === 'string' && this.pending.has(id)) {
        const pending = this.pending.get(id)!;
        this.pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(
          new EditorialError(
            'perception_failed',
            'the worker sent a reply this version cannot read',
            {
              op: pending.op,
              line: trimmed.slice(0, 300),
            },
          ),
        );
        return;
      }
      this.options.onLog?.(`unrecognised message from worker: ${trimmed.slice(0, 200)}`);
      return;
    }

    const message = response.data;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (pending.timer) clearTimeout(pending.timer);

    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(
        new EditorialError('perception_failed', `${message.error.code}: ${message.error.message}`, {
          op: pending.op,
          ...message.error.details,
        }),
      );
    }
  }

  /**
   * Kills a worker that can no longer be trusted, and fails what it was holding.
   *
   * Everything still pending is queued behind work nobody is waiting for any
   * more, so it is already lost; saying so is better than letting each request
   * discover it by timing out.
   */
  private abandon(reason: string): void {
    const child = this.child;
    this.child = undefined;
    this.reader?.close();
    this.reader = undefined;
    this.startPromise = undefined;
    this.exitReason = reason;
    this.failAll(new EditorialError('perception_failed', reason));
    if (child && child.exitCode === null) child.kill('SIGKILL');
  }

  private failAll(error: unknown): void {
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  /** Sends one request and validates the reply against the schema for that op. */
  async request<Op extends PerceptionOp>(
    op: Op,
    params: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<PerceptionResultMap[Op]> {
    await this.start();
    const child = this.child;
    if (!child || child.exitCode !== null) {
      throw new EditorialError(
        'perception_failed',
        this.exitReason ?? 'perception worker is not running',
      );
    }

    const id = `req_${++this.counter}`;
    const payload = `${JSON.stringify({ v: PERCEPTION_PROTOCOL_VERSION, id, op, params })}\n`;

    const raw = await new Promise<unknown>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? 0;
      const pending: Pending = { resolve, reject, op };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(
            new EditorialError(
              'perception_failed',
              `perception worker timed out after ${timeoutMs}ms`,
              {
                op,
              },
            ),
          );
          // The worker handles one request at a time and has no way to be told
          // to stop, so abandoning a request does not free it: it goes on
          // working, and everything sent afterwards waits behind the thing that
          // already timed out and times out in turn. One slow file took the
          // rest of the run with it. Giving up on a request means giving up on
          // the process; the next request starts a fresh one.
          this.abandon(`the worker was restarted after "${op}" timed out`);
        }, timeoutMs);
      }
      this.pending.set(id, pending);
      child.stdin.write(payload, (error) => {
        if (error) {
          this.pending.delete(id);
          if (pending.timer) clearTimeout(pending.timer);
          reject(
            new EditorialError('perception_failed', `could not write to worker: ${error.message}`),
          );
        }
      });
    });

    const schema = PERCEPTION_RESULT_SCHEMAS[op];
    if (!schema) {
      throw new EditorialError('perception_failed', `no result schema for "${op}"`, { op });
    }
    return parseOrThrow(schema, raw, `perception result for "${op}"`) as PerceptionResultMap[Op];
  }

  /** Asks the worker to shut down, then makes sure it actually did. */
  async close(graceMs = 5000): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    if (child.stdin.writable) {
      child.stdin.write(
        `${JSON.stringify({ v: PERCEPTION_PROTOCOL_VERSION, id: 'shutdown', op: 'shutdown', params: {} })}\n`,
        () => undefined,
      );
      child.stdin.end();
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, graceMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.reader?.close();
    this.child = undefined;
    this.startPromise = undefined;
  }
}
