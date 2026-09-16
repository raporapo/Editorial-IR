import { execFile } from 'node:child_process';
import { EditorialError } from '@editorial-ir/contracts';

/**
 * Every external process goes through this interface.
 *
 * Not for purity: for testability. ffmpeg is not installed in CI, and a
 * pipeline that can only be tested on a machine with ffmpeg is a pipeline that
 * stops being tested.
 */
export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface CommandOptions {
  timeoutMs?: number;
  /** Bytes of stdout to keep. ffmpeg's showinfo output on a long file is large. */
  maxBuffer?: number;
  cwd?: string;
  /** Do not throw on a non-zero exit; ffmpeg uses stderr for useful output. */
  allowFailure?: boolean;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: CommandOptions): Promise<CommandResult>;
  /** Resolves whether an executable is callable at all. */
  available(command: string): Promise<boolean>;
}

export class NodeCommandRunner implements CommandRunner {
  private readonly availability = new Map<string, Promise<boolean>>();

  async run(command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      execFile(
        command,
        args,
        {
          timeout: options.timeoutMs ?? 0,
          maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
          cwd: options.cwd,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          if (error) {
            const code = typeof error.code === 'number' ? error.code : 1;
            if (options.allowFailure) {
              resolve({ stdout, stderr, code });
              return;
            }
            reject(
              new EditorialError('media_error', `${command} failed: ${error.message}`, {
                command,
                args,
                code,
                stderr: stderr.slice(-2000),
              }),
            );
            return;
          }
          resolve({ stdout, stderr, code: 0 });
        },
      );
    });
  }

  async available(command: string): Promise<boolean> {
    let probe = this.availability.get(command);
    if (!probe) {
      probe = this.run(command, ['-version'], { timeoutMs: 10_000, allowFailure: true })
        .then((r) => r.code === 0)
        .catch(() => false);
      this.availability.set(command, probe);
    }
    return probe;
  }
}

/** A runner that answers from a fixed script. Used by tests to stand in for ffmpeg. */
export class ScriptedCommandRunner implements CommandRunner {
  readonly calls: { command: string; args: string[] }[] = [];

  constructor(
    private readonly responses: (
      command: string,
      args: string[],
    ) => CommandResult | undefined,
    private readonly availableCommands: Set<string> = new Set(['ffmpeg', 'ffprobe']),
  ) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push({ command, args });
    const response = this.responses(command, args);
    if (!response) {
      throw new EditorialError('media_error', `no scripted response for ${command}`, { command, args });
    }
    return response;
  }

  async available(command: string): Promise<boolean> {
    return this.availableCommands.has(command);
  }
}
