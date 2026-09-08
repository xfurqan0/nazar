/**
 * Runner for `claude agents --json`, the only authority on whether a session's
 * process is really there and on what a waiting session is waiting for.
 *
 * Schema verified live on the maintainer's machine (Claude Code 2.1.263,
 * Windows 11, four interactive sessions open): an array whose elements carry
 * exactly `pid`, `cwd`, `kind`, `startedAt`, `sessionId`, `name`, `status`.
 * `waitingFor` appears only while `status == "waiting"`, and `id` / `state`
 * only for background sessions; neither was observed. Five consecutive runs
 * cost 275, 264, 261, 257 and 257 ms, so this is a gate that runs at startup,
 * on a change to the sessions directory and every 20-30 s, never a loop.
 *
 * The runner never throws and never rejects. A missing or failing `claude`
 * leaves the registry working from the session files alone.
 */
import { execFile } from 'node:child_process';

import type { SessionStatus } from './types.js';
import { toSessionStatus } from './types.js';

/** One element of `claude agents --json`. */
export interface AgentsEntry {
  readonly pid: number;
  readonly cwd?: string;
  readonly kind?: string;
  readonly name?: string;
  readonly status: SessionStatus;
  readonly waitingFor?: string;
  readonly sessionId?: string;
  readonly startedAt?: number;
}

export interface AgentsRunResult {
  readonly ok: boolean;
  readonly entries: readonly AgentsEntry[];
  /** Wall time of the call, so the gate's real cost is measurable. */
  readonly durationMs: number;
  readonly error?: string;
}

export type AgentsRunner = () => Promise<AgentsRunResult>;

export interface AgentsRunnerOptions {
  /** Defaults to `claude`; tests inject an executable that echoes a fixture. */
  readonly command?: string;
  readonly args?: readonly string[];
  /** Wall-time budget for one call. */
  readonly timeoutMs?: number;
  readonly platform?: NodeJS.Platform;
}

export const DEFAULT_AGENTS_COMMAND = 'claude';
export const DEFAULT_AGENTS_ARGS: readonly string[] = ['agents', '--json'];
export const DEFAULT_AGENTS_TIMEOUT_MS = 5000;

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Parse the command's stdout. Unknown keys are ignored; an element without a
 * usable pid is dropped, because pid is what liveness is checked against.
 */
export function parseAgentsOutput(raw: string): { entries: AgentsEntry[]; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { entries: [], error: 'output was not JSON' };
  }
  if (!Array.isArray(parsed)) {
    return { entries: [], error: 'output was not an array' };
  }

  const entries: AgentsEntry[] = [];
  for (const element of parsed as unknown[]) {
    if (typeof element !== 'object' || element === null || Array.isArray(element)) continue;
    const record = element as Record<string, unknown>;
    const pid = readNumber(record['pid']);
    if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) continue;
    entries.push({
      pid,
      cwd: readString(record['cwd']),
      kind: readString(record['kind']),
      name: readString(record['name']),
      status: toSessionStatus(record['status']),
      waitingFor: readString(record['waitingFor']),
      sessionId: readString(record['sessionId']),
      startedAt: readNumber(record['startedAt']),
    });
  }
  return { entries };
}

interface ExecOutcome {
  readonly stdout: string;
  readonly failure?: NodeJS.ErrnoException;
}

function execOnce(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  shell: boolean,
): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        timeout: timeoutMs,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        shell,
      },
      (error, stdout) => {
        resolve({ stdout, failure: (error as NodeJS.ErrnoException | null) ?? undefined });
      },
    );
  });
}

/**
 * Build a runner. On Windows a global npm install leaves `claude` as a `.cmd`
 * shim, which `execFile` refuses to spawn directly, so a spawn failure there is
 * retried once through the shell. The command and its arguments are fixed
 * configuration, never user input, so the retry quotes the command and passes
 * nothing else through. On this machine `claude` is a real `.exe` and the first
 * attempt succeeds.
 */
export function createClaudeAgentsRunner(options: AgentsRunnerOptions = {}): AgentsRunner {
  const command = options.command ?? DEFAULT_AGENTS_COMMAND;
  const args = options.args ?? DEFAULT_AGENTS_ARGS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_AGENTS_TIMEOUT_MS;
  const platform = options.platform ?? process.platform;

  return async function runClaudeAgents(): Promise<AgentsRunResult> {
    const started = process.hrtime.bigint();
    const elapsed = (): number => Number(process.hrtime.bigint() - started) / 1e6;

    let outcome = await execOnce(command, args, timeoutMs, false);
    const spawnFailed =
      outcome.failure !== undefined &&
      (outcome.failure.code === 'ENOENT' || outcome.failure.code === 'EINVAL');
    if (spawnFailed && platform === 'win32') {
      outcome = await execOnce(`"${command}"`, args, timeoutMs, true);
    }

    if (outcome.failure !== undefined) {
      return {
        ok: false,
        entries: [],
        durationMs: elapsed(),
        error: outcome.failure.code ?? outcome.failure.message,
      };
    }

    const parsed = parseAgentsOutput(outcome.stdout);
    if (parsed.error !== undefined) {
      return { ok: false, entries: [], durationMs: elapsed(), error: parsed.error };
    }
    return { ok: true, entries: parsed.entries, durationMs: elapsed() };
  };
}
