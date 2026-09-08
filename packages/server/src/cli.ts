/**
 * The `nazar` command.
 *
 * It starts the watchers, binds the canvas to 127.0.0.1 and prints the URL.
 * That is nearly the whole surface: one subcommand (`doctor`, which starts
 * nothing and only reports), no daemon, no config file, and nothing written
 * anywhere on the machine.
 *
 * Opening the browser is done with the platform's own opener through
 * `child_process`, not with a dependency, and it is a chain rather than a
 * single call — `open.ts` holds the reasoning. `--no-open` skips it, which is
 * what a remote shell or a screenshot run wants. The URL is printed on its own
 * line *before* any of that is attempted, so the terminal stays useful even
 * when every opener on the machine fails.
 *
 * # How the command line is read (N-WP9)
 *
 * The first version of {@link main} searched the *whole* argument list for
 * every flag it knew, in a fixed order, and ignored everything it did not
 * recognise. Both halves of that were wrong, and a release audit found them
 * together:
 *
 * - `nazar doctor -v` printed the version and never ran doctor. `-v` was the
 *   short form of `--version` and the search that found it did not care that
 *   a subcommand had already claimed the line. The flag a person types after
 *   `doctor` belongs to `doctor`.
 * - `nazar --prot 8080` started the server on 4676 and said nothing. A
 *   misspelled flag that changes nothing and reports nothing is the worst
 *   possible answer: the command appears to have worked.
 *
 * So the subcommand is decided first, each level knows exactly which flags it
 * owns, and **anything else beginning with `-` stops the command** with exit
 * code 2 and a line naming the flag. `-v` and `--verbose` are doctor's;
 * `--version` and `-V` are the top level's. Typing `nazar -v` therefore no
 * longer prints a version — it names the flag and points at both of the two
 * things it could have meant, which is the honest answer to an ambiguity this
 * program created for itself.
 */
import { existsSync } from 'node:fs';

import { HistoryScanner, NazarState } from '@nazar/core';

import { runDoctor } from './doctor.js';
import { startNazarServer } from './http.js';
import { openInBrowser } from './open.js';
import type { OpenOutcome } from './open.js';
import { resolveUiDir } from './ui-assets.js';
import { VERSION } from './version.js';

export { VERSION };

/** Port Nazar listens on when `--port` is not given (docs/PROJECT.md §7). */
export const DEFAULT_PORT = 4676;

/** A bad command line, reported to the user rather than thrown as a crash. */
export class CliError extends Error {
  override readonly name = 'CliError';
}

/** Anything we can print to. Keeps `main` testable without touching stdio. */
export interface OutputStream {
  write(chunk: string): unknown;
}

const HELP = `nazar - keep a watchful eye on your agents

Usage:
  nazar [--port <number>] [--no-open]
  nazar doctor [--verbose]

Options:
  --port <number>  Port for the local canvas server (default ${DEFAULT_PORT})
  --open           Open the canvas in your browser (default)
  --no-open        Start the server but do not open a browser
  -h, --help       Show this help
  -V, --version    Print the version

Commands:
  doctor           Report what Nazar can read on this machine and why the
                   canvas would be empty, without starting the server.
                   -v, --verbose adds absolute paths and one line per session.

The canvas is served on 127.0.0.1 only. Nazar reads what Claude Code already
writes; it installs no hooks and changes no settings.
`;

/** One line, printed under every "unknown option". */
export const USAGE = 'usage: nazar [--port <number>] [--no-open] | nazar doctor [--verbose]';

/** Flags every level answers to. */
const HELP_FLAGS = ['-h', '--help'];
const VERSION_FLAGS = ['-V', '--version'];

/** What `doctor` accepts, on top of the two above. */
const DOCTOR_FLAGS = ['-v', '--verbose'];

/** What the serve path accepts, on top of the two above. */
const SERVE_FLAGS = ['--open', '--no-open', '--port'];

/**
 * The first argument that begins with `-` and is on none of the lists, or
 * `undefined` when every flag is one this level owns.
 *
 * `--port`'s value is skipped rather than inspected: a port is a number, and a
 * number does not begin with `-` — but a *missing* value followed by another
 * flag would otherwise be reported here as an unknown option, when
 * {@link parsePort} has a better sentence for it. The `--port=<n>` form carries
 * its own value and needs no skipping.
 */
export function unknownFlag(argv: readonly string[], known: readonly string[]): string | undefined {
  const allowed = new Set([...HELP_FLAGS, ...VERSION_FLAGS, ...known]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith('-') || arg === '-') continue;
    const name = arg.startsWith('--') && arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (!allowed.has(name)) return arg;
    if (name === '--port' && arg === '--port') i += 1;
  }
  return undefined;
}

/**
 * The sentence an unknown flag gets.
 *
 * `-v` is special-cased because this program is the reason it is ambiguous: it
 * used to be the short form of `--version`, and it is now doctor's `--verbose`.
 * Naming both is more useful than naming neither.
 */
export function unknownFlagMessage(flag: string): string {
  const hint =
    flag === '-v'
      ? ' ("-v" is doctor\'s --verbose; the version is "nazar --version")'
      : '';
  return `nazar: unknown option "${flag}"${hint}\n${USAGE}\n`;
}

/**
 * Reads `--port` out of an argument list. Accepts both `--port 8080` and
 * `--port=8080`; the last occurrence wins. Throws {@link CliError} on a value
 * that is not a decimal port number.
 */
export function parsePort(argv: readonly string[]): number {
  let raw: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === '--port') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new CliError('--port needs a value, for example --port 4676');
      }
      raw = value;
      i += 1;
    } else if (arg.startsWith('--port=')) {
      raw = arg.slice('--port='.length);
    }
  }

  if (raw === undefined) return DEFAULT_PORT;

  if (!/^\d+$/.test(raw)) {
    throw new CliError(`--port must be a number, got "${raw}"`);
  }

  const port = Number(raw);
  if (port < 1 || port > 65535) {
    throw new CliError(`--port must be between 1 and 65535, got "${raw}"`);
  }

  return port;
}

/**
 * Whether to open a browser. Opening is the default; `--no-open` wins over an
 * explicit `--open`, so a wrapper script can always append it.
 */
export function parseOpen(argv: readonly string[]): boolean {
  return !argv.includes('--no-open');
}

export interface ServeOptions {
  readonly port: number;
  readonly open: boolean;
  readonly out: OutputStream;
  readonly err: OutputStream;
}

export interface ServeHandle {
  readonly url: string;
  /**
   * How the browser open went, or `undefined` under `--no-open`. Nothing waits
   * on it — it is here so a test can, and so it never becomes a floating
   * rejection.
   */
  readonly opening: Promise<OpenOutcome | undefined>;
  close(): Promise<void>;
}

/** Start the watchers and the server. Resolves once the canvas is reachable. */
export async function serve(options: ServeOptions): Promise<ServeHandle> {
  const uiDir = resolveUiDir();
  if (!existsSync(uiDir)) {
    throw new CliError(`the canvas is not built (${uiDir} is missing). Run "npm run build" first.`);
  }

  const state = new NazarState();
  await state.start();

  // WP4b. Constructing it costs nothing: the scanner walks no directory until
  // the history panel asks for a page, and opens no transcript until the user
  // opens a session.
  const history = new HistoryScanner();

  const server = await startNazarServer({ state, uiDir, history, port: options.port });

  // The URL goes out before anything is spawned. Every opener below can fail
  // silently on some machine, and a printed URL is the one thing that cannot.
  options.out.write(`nazar ${VERSION} - pre-alpha\n`);
  options.out.write(`canvas: ${server.url}\n`);
  const snapshot = state.snapshot();
  const count = snapshot.sessions.length;
  options.out.write(
    count === 0
      ? 'no Claude Code sessions found yet; the canvas updates as they start\n'
      : `watching ${count} session${count === 1 ? '' : 's'}\n`,
  );
  if (!snapshot.commandAvailable) {
    options.err.write(
      'note: "claude agents --json" did not answer, so liveness comes from the session files alone\n',
    );
  }

  // Not awaited: the canvas is already reachable, and an opener that takes
  // three seconds to answer must not hold the terminal. The hint line, when it
  // is needed, arrives on its own.
  const opening: Promise<OpenOutcome | undefined> = options.open
    ? openInBrowser(server.url, { out: options.out })
    : Promise.resolve(undefined);

  return {
    url: server.url,
    opening,
    close: async () => {
      await server.close();
      state.stop();
    },
  };
}

/**
 * Runs the CLI and resolves with the process exit code.
 *
 * The subcommand is read first and each level then validates its own flags, so
 * a flag typed after `doctor` cannot be answered by the top level. See the
 * module note for the two bugs that shape is here to make impossible.
 */
export async function main(
  argv: readonly string[],
  out: OutputStream = process.stdout,
  err: OutputStream = process.stderr,
): Promise<number> {
  // The one subcommand. It starts no watcher, no server and no browser, which
  // is why it is handled before anything below allocates.
  if (argv[0] === 'doctor') {
    const rest = argv.slice(1);
    const unknown = unknownFlag(rest, DOCTOR_FLAGS);
    if (unknown !== undefined) {
      err.write(unknownFlagMessage(unknown));
      return 2;
    }
    if (rest.some((arg) => HELP_FLAGS.includes(arg))) {
      out.write(HELP);
      return 0;
    }
    if (rest.some((arg) => VERSION_FLAGS.includes(arg))) {
      out.write(`${VERSION}\n`);
      return 0;
    }

    const report = await runDoctor({ verbose: rest.some((arg) => DOCTOR_FLAGS.includes(arg)) });
    out.write(`nazar doctor ${VERSION} · node ${process.version} · ${process.platform}\n\n`);
    out.write(`${report.lines.join('\n')}\n`);
    return 0;
  }

  const unknown = unknownFlag(argv, SERVE_FLAGS);
  if (unknown !== undefined) {
    err.write(unknownFlagMessage(unknown));
    return 2;
  }

  if (argv.some((arg) => HELP_FLAGS.includes(arg))) {
    out.write(HELP);
    return 0;
  }

  if (argv.some((arg) => VERSION_FLAGS.includes(arg))) {
    out.write(`${VERSION}\n`);
    return 0;
  }

  let port: number;
  try {
    port = parsePort(argv);
  } catch (error) {
    err.write(`nazar: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  let handle: ServeHandle;
  try {
    handle = await serve({ port, open: parseOpen(argv), out, err });
  } catch (error) {
    if (error instanceof CliError) {
      err.write(`nazar: ${error.message}\n`);
      return 2;
    }
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'EADDRINUSE') {
      err.write(`nazar: port ${port} is already in use. Try "nazar --port ${port + 1}".\n`);
      return 1;
    }
    err.write(`nazar: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const shutdown = (): void => {
    void handle.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return 0;
}
