/**
 * Handing the canvas URL to the machine's browser, and admitting when that
 * cannot be verified.
 *
 * The old version was one line — `cmd /c start "" <url>` on Windows, `open` on
 * macOS, `xdg-open` elsewhere — with every failure swallowed. It went wrong in
 * the way a swallowed failure always does: on the maintainer's machine no
 * browser appeared, the command exited 0, and running the same command by hand
 * worked. Nothing in the output said anything had been attempted, so there was
 * nothing to act on.
 *
 * Three things changed, and the third is the one that matters:
 *
 * 1. **A chain, not a single call.** Each of the Windows hypotheses has its own
 *    single point of failure, so none of them is trusted alone:
 *    - `spawn('cmd', ...)` resolves `cmd` through `PATH`. A shell with a
 *      trimmed `PATH` — and `system32` is not sacred — turns that into an
 *      `ENOENT` the old code discarded. {@link browserOpenChain} uses
 *      `ComSpec` when the environment sets it and only falls back to the bare
 *      name.
 *    - `start` is a `cmd` builtin whose first quoted argument is the *window
 *      title*, which is why the empty `''` is there. libuv has quoted empty
 *      arguments as `""` since 1.24; on anything older the argument vanishes,
 *      the URL becomes the title, `cmd` exits 0 and no browser opens — exactly
 *      the reported symptom. `rundll32` and `explorer.exe` need no such
 *      argument, so the chain survives it either way.
 *    - `windowsHide` keeps a console window from flashing up when the host has
 *      a console to give.
 * 2. **Never throws, never blocks.** A spawn that throws, errors or says
 *    nothing at all within {@link DEFAULT_OPEN_TIMEOUT_MS} moves the chain
 *    along; the caller is handed a promise it is free to ignore, and `serve`
 *    does ignore it.
 * 3. **The URL is printed first and the hint is honest.** On Windows *nothing*
 *    in the chain can report whether a browser actually opened: `cmd /c start`
 *    exits 0 whether or not the shell found a handler, `rundll32` exits 0
 *    unconditionally, and `explorer.exe` exits 1 even when it succeeds. So the
 *    Windows attempts are marked `confirms: false` and {@link OPEN_HINT} is
 *    printed after every Windows run. `open` and `xdg-open` do fail loudly when
 *    there is no handler, so on macOS and Linux the hint appears only when
 *    something actually went wrong.
 */
import { spawn as nodeSpawn } from 'node:child_process';

import type { OutputStream } from './cli.js';

/**
 * The one place this sentence is written. The canvas URL is always printed on
 * its own line before any of this runs, so "above" is exact.
 */
export const OPEN_HINT = 'if no browser opened, open the URL above';

/** How long one opener may stay silent before the chain assumes it is running. */
export const DEFAULT_OPEN_TIMEOUT_MS = 3000;

/** One link of the chain: a command, its arguments, and what its exit means. */
export interface OpenAttempt {
  readonly command: string;
  readonly args: readonly string[];
  /** Exit codes that mean this launcher did its job. */
  readonly okCodes: readonly number[];
  /**
   * Whether a successful exit says anything about the *browser*. False for
   * every Windows launcher, which is why {@link OPEN_HINT} exists.
   */
  readonly confirms: boolean;
}

/** The part of a `ChildProcess` this file uses, so a test can supply its own. */
export interface OpenChild {
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  unref?(): unknown;
}

/** The part of `child_process.spawn` this file uses. Injected by tests. */
export type OpenSpawn = (
  command: string,
  args: readonly string[],
  options: { detached: boolean; stdio: 'ignore'; windowsHide: boolean },
) => OpenChild;

/**
 * - `opened` — a launcher that can tell reported success.
 * - `launched` — a launcher ran and did not complain, but cannot confirm.
 * - `failed` — every link of the chain errored or exited badly.
 */
export type OpenStatus = 'opened' | 'launched' | 'failed';

export interface OpenOutcome {
  readonly status: OpenStatus;
  /** Every attempt made, described, in the order they were tried. */
  readonly attempted: readonly string[];
  /** Whether {@link OPEN_HINT} was written. */
  readonly hinted: boolean;
}

export interface OpenOptions {
  readonly spawn?: OpenSpawn;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  /** Where {@link OPEN_HINT} goes. Nothing is printed when this is absent. */
  readonly out?: OutputStream;
}

/**
 * `ComSpec` as the environment spells it. Windows environment keys are
 * case-insensitive to the real `process.env` but not to a plain object handed
 * in by a test, so both spellings are checked.
 */
function comSpec(env: NodeJS.ProcessEnv): string {
  const configured = env['ComSpec'] ?? env['COMSPEC'] ?? env['comspec'];
  return typeof configured === 'string' && configured.length > 0 ? configured : 'cmd.exe';
}

/**
 * The openers Nazar would try for this platform, in order.
 *
 * Windows gets three because each of them fails differently: `start` is a
 * `cmd` builtin and needs `cmd` to resolve at all; `rundll32 url.dll` is the
 * shell's own protocol handler and needs no shell builtin; `explorer.exe` is
 * the last resort and is the one thing on a Windows desktop that is always
 * there.
 */
export function browserOpenChain(
  url: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): readonly OpenAttempt[] {
  if (platform === 'win32') {
    return [
      // The empty string is the window title: without it `start` reads a
      // quoted URL as the title and opens nothing.
      { command: comSpec(env), args: ['/c', 'start', '', url], okCodes: [0], confirms: false },
      { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url], okCodes: [0], confirms: false },
      // Explorer answers 1 on success as often as 0, so both are accepted.
      { command: 'explorer.exe', args: [url], okCodes: [0, 1], confirms: false },
    ];
  }
  if (platform === 'darwin') {
    return [{ command: 'open', args: [url], okCodes: [0], confirms: true }];
  }
  return [{ command: 'xdg-open', args: [url], okCodes: [0], confirms: true }];
}

/** One attempt as a command line, for `nazar doctor` and for the outcome. */
export function describeOpenAttempt(attempt: OpenAttempt): string {
  const args = attempt.args.map((arg) => (arg.length === 0 || arg.includes(' ') ? `"${arg}"` : arg));
  return [attempt.command, ...args].join(' ');
}

type AttemptResult = 'exited' | 'timeout' | 'failed';

/** Run one link. Resolves; never rejects, never throws, never hangs. */
function runAttempt(
  attempt: OpenAttempt,
  spawnFn: OpenSpawn,
  timeoutMs: number,
): Promise<AttemptResult> {
  return new Promise<AttemptResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (result: AttemptResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };

    let child: OpenChild;
    try {
      child = spawnFn(attempt.command, [...attempt.args], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      done('failed');
      return;
    }

    // Deliberately not `unref`ed: an opener that says nothing must still settle
    // this promise, and a process with nothing else pending would otherwise
    // drain its event loop first and leave the caller waiting forever. The cost
    // is at most `timeoutMs` of extra process lifetime on the silent path.
    timer = setTimeout(() => done('timeout'), timeoutMs);

    try {
      child.on('error', () => done('failed'));
      child.on('exit', (code) => done(attempt.okCodes.includes(code ?? -1) ? 'exited' : 'failed'));
      child.unref?.();
    } catch {
      // A stub that does not implement the events is still a launched process
      // as far as we know; the timeout will settle it.
    }
  });
}

/**
 * Hand `url` to the platform's browser, walking the chain until one link
 * answers, then print {@link OPEN_HINT} unless the open was confirmed.
 *
 * The returned promise always resolves. `serve` does not await it: the canvas
 * is reachable the moment the URL is printed, and a browser that takes three
 * seconds to answer must not hold the terminal.
 */
export async function openInBrowser(url: string, options: OpenOptions = {}): Promise<OpenOutcome> {
  const spawnFn = options.spawn ?? (nodeSpawn as unknown as OpenSpawn);
  const chain = browserOpenChain(url, options.platform ?? process.platform, options.env ?? process.env);
  const timeoutMs = options.timeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;

  const attempted: string[] = [];
  let status: OpenStatus = 'failed';

  for (const attempt of chain) {
    attempted.push(describeOpenAttempt(attempt));
    const result = await runAttempt(attempt, spawnFn, timeoutMs);
    if (result === 'failed') continue;
    status = attempt.confirms && result === 'exited' ? 'opened' : 'launched';
    break;
  }

  let hinted = false;
  if (status !== 'opened' && options.out !== undefined) {
    options.out.write(`${OPEN_HINT}\n`);
    hinted = true;
  }

  return { status, attempted, hinted };
}
