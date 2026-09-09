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

import { runAgent } from './agent.js';
import { runDoctor } from './doctor.js';
import { startNazarServer } from './http.js';
import { CompositeState, DEFAULT_REMOTE_COMMAND, RemoteHosts, isAlias, parseAliases } from './remote.js';
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
  nazar [--port <number>] [--no-open] [--no-task-text] [--no-codex] [--remote <alias,...>]
  nazar --agent [--hermes] [--no-claude] [--no-codex] [--task-text]
  nazar doctor [--verbose]

Options:
  --port <number>  Port for the local canvas server (default ${DEFAULT_PORT})
  --open           Open the canvas in your browser (default)
  --no-open        Start the server but do not open a browser
  --no-codex       Do not read Codex rollouts. Codex sessions are read from
                   ~/.codex/sessions when that directory exists; this stops it,
                   and a machine without Codex is unaffected either way.
  --no-task-text   Never read the task text out of a transcript, whatever the
                   canvas asks for. Task text is off in every browser until
                   somebody switches it on; this makes it unavailable, which is
                   what a recording or a shared screen wants. NAZAR_TASK_TEXT=0
                   does the same thing.
  --remote <list>  Comma-separated ~/.ssh/config aliases to read as well as this
                   machine. Each one is an "ssh <alias> -- ${DEFAULT_REMOTE_COMMAND}"
                   started by this process; there is no port, no token and
                   nothing left running when Nazar exits. See docs/REMOTE.md.
  --remote-cmd <c> What to run on the far end instead of the default above.
  -h, --help       Show this help
  -V, --version    Print the version

Remote mode (run on the far end, normally by --remote rather than by hand):
  --agent          Write the canvas to stdout as newline-delimited JSON and
                   exit when the pipe closes. No server, no port, no browser.
  --hermes         Also read Hermes sessions out of ~/.hermes/state.db,
                   read-only. Off unless asked for.
  --no-claude      Do not read Claude Code on the far end.
  --task-text      Let the far end read task text. Off by default here, which
                   is the opposite of the local default and deliberate: this is
                   text leaving a machine over a network.

Commands:
  doctor           Report what Nazar can read on this machine and why the
                   canvas would be empty, without starting the server.
                   -v, --verbose adds absolute paths and one line per session.

The canvas is served on 127.0.0.1 only. Nazar reads what Claude Code already
writes; it installs no hooks and changes no settings.
`;

/** One line, printed under every "unknown option". */
export const USAGE =
  'usage: nazar [--port <number>] [--no-open] [--no-task-text] [--no-codex] [--remote <alias,...>] | nazar --agent [--hermes] | nazar doctor [--verbose]';

/** Flags every level answers to. */
const HELP_FLAGS = ['-h', '--help'];
const VERSION_FLAGS = ['-V', '--version'];

/**
 * What `doctor` accepts, on top of the two above.
 *
 * N-WP17a put `--remote` on this list as well as on the serve path, and it is
 * the same flag doing the same thing: name the machines you expect to be able
 * to read. Doctor makes **one** attempt per alias and reports it; the canvas
 * retries for as long as it runs. A person debugging a connection wants the
 * first answer, not a program that keeps trying in the background.
 */
const DOCTOR_FLAGS = ['-v', '--verbose', '--remote', '--remote-cmd'];

/** What the serve path accepts, on top of the two above. */
const SERVE_FLAGS = [
  '--open',
  '--no-open',
  '--port',
  '--task-text',
  '--no-task-text',
  '--codex',
  '--no-codex',
  '--remote',
  '--remote-cmd',
];

/**
 * N-WP17a: what `--agent` accepts, and nothing the serve path owns.
 *
 * `--port` and `--open` are absent on purpose. An agent binds nothing and opens
 * nothing, so a `--port` typed next to `--agent` is a misunderstanding worth a
 * sentence rather than a flag that is quietly ignored.
 *
 * `--codex` and `--no-codex` are here because the far end reads the same
 * sources the near end does: a build server with `~/.codex/sessions` on it has
 * Codex work worth drawing, and the switch that turns that off locally has to
 * exist there too or `--no-codex` would be a promise only one machine keeps.
 */
const AGENT_FLAGS = [
  '--agent',
  '--claude',
  '--no-claude',
  '--codex',
  '--no-codex',
  '--hermes',
  '--no-hermes',
  '--task-text',
  '--no-task-text',
];

/**
 * Flags whose next argument is their value.
 *
 * {@link unknownFlag} has to skip these, or `--remote-cmd "nazar --agent"`
 * reports `--agent` as an unknown option — which it is not; it is a word inside
 * a string that belongs to another machine's shell.
 */
const VALUE_FLAGS = new Set(['--port', '--remote', '--remote-cmd']);

/** Environment variable that switches task text off without a flag (N-WP15a). */
export const TASK_TEXT_VAR = 'NAZAR_TASK_TEXT';

/**
 * The first argument that begins with `-` and is on none of the lists, or
 * `undefined` when every flag is one this level owns.
 *
 * A value-taking flag's value is skipped rather than inspected — see
 * {@link VALUE_FLAGS}. A port is a number and a number does not begin with `-`,
 * but a *missing* value followed by another flag would otherwise be reported
 * here as an unknown option, when {@link parsePort} has a better sentence for
 * it; and `--remote-cmd`'s value is a whole command line for another machine,
 * which is full of things that begin with `-` and none of them ours. The
 * `--flag=<value>` form carries its own value and needs no skipping.
 */
export function unknownFlag(argv: readonly string[], known: readonly string[]): string | undefined {
  const allowed = new Set([...HELP_FLAGS, ...VERSION_FLAGS, ...known]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith('-') || arg === '-') continue;
    const name = arg.startsWith('--') && arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (!allowed.has(name)) return arg;
    if (VALUE_FLAGS.has(name) && arg === name) i += 1;
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
 * The value of a `--flag <value>` / `--flag=<value>` pair, or `undefined`.
 *
 * The last occurrence wins, which is {@link parsePort}'s rule and the one a
 * wrapper script relies on: append your own and be sure of the answer. A flag
 * present with no value throws, because "you typed --remote and named no host"
 * is a better answer than starting with none.
 */
export function parseValue(argv: readonly string[], flag: string): string | undefined {
  let raw: string | undefined;
  const prefix = `${flag}=`;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === flag) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new CliError(`${flag} needs a value`);
      }
      raw = value;
      i += 1;
    } else if (arg.startsWith(prefix)) {
      raw = arg.slice(prefix.length);
    }
  }
  return raw;
}

/**
 * N-WP17a: the aliases `--remote` named, checked.
 *
 * An alias has to look like an alias — see `remote.ts` for what that means and
 * why it excludes `user@host`, a path and anything beginning with `-`. A name
 * that does not is a {@link CliError} naming it, rather than an argument handed
 * to `ssh` to be interpreted as who-knows-what.
 */
export function parseRemotes(argv: readonly string[]): string[] {
  const raw = parseValue(argv, '--remote');
  if (raw === undefined) return [];
  const aliases = parseAliases(raw);
  if (aliases.length === 0) {
    throw new CliError('--remote needs at least one ~/.ssh/config alias, for example --remote box');
  }
  for (const alias of aliases) {
    if (!isAlias(alias)) {
      throw new CliError(
        `--remote: "${alias}" is not an ssh alias. Put the host in ~/.ssh/config and name it here; ` +
          'Nazar takes no user, port or key on its command line.',
      );
    }
  }
  return aliases;
}

/**
 * Whether to open a browser. Opening is the default; `--no-open` wins over an
 * explicit `--open`, so a wrapper script can always append it.
 */
export function parseOpen(argv: readonly string[]): boolean {
  return !argv.includes('--no-open');
}

/**
 * N-WP15a: whether this process may read task text at all.
 *
 * The shape is `parseOpen`'s, and the negative wins for the same reason: a
 * wrapper — the desktop shell, a `presenting` alias, a `.desktop` entry — can
 * always append `--no-task-text` and be sure of the answer. The environment
 * variable is the same switch for a shell profile, and it is checked *only* for
 * the exact string `0`: an unset variable, an empty one and `NAZAR_TASK_TEXT=1`
 * all mean "leave it to the flag", so a stray value in an inherited environment
 * cannot quietly turn a feature on that the user never chose.
 *
 * Turning it off never has to be explained twice: whichever of the two said so
 * wins, and there is no ordering to remember.
 */
export function parseTaskText(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (argv.includes('--no-task-text')) return false;
  return env[TASK_TEXT_VAR] !== '0';
}

/**
 * N-WP18: whether this process may read Codex rollouts at all.
 *
 * The shape is `parseOpen`'s and the negative wins for the same reason: a
 * wrapper can always append `--no-codex` and be sure of the answer. There is no
 * environment variable, because unlike task text this switches off a *source*
 * rather than a privacy surface — a machine with no `~/.codex/sessions` already
 * reads nothing, and a machine with one has asked for Codex by installing it.
 */
export function parseCodex(argv: readonly string[]): boolean {
  return !argv.includes('--no-codex');
}

export interface ServeOptions {
  readonly port: number;
  readonly open: boolean;
  /**
   * N-WP15a. Defaults to `true`, which means "the browser decides" — and every
   * browser starts with it off. `false` is `--no-task-text`, and it reaches
   * three places at once: the live readers, the history scanner and the wire.
   */
  readonly taskText?: boolean;
  /**
   * N-WP18. Defaults to `true`, which means "read Codex if it is installed".
   * `false` is `--no-codex` and reaches the reader itself, so with it off no
   * rollout is opened at all.
   */
  readonly codex?: boolean;
  /**
   * N-WP17a: `~/.ssh/config` aliases to read alongside this machine.
   *
   * Empty is the normal case and costs nothing: with no alias no child process
   * is spawned, no composite is built, and the server is handed exactly the
   * state source it was handed before this package existed.
   */
  readonly remotes?: readonly string[];
  /** What to run on each far end. Defaults to `nazar --agent --hermes`. */
  readonly remoteCommand?: string;
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

  /*
   * N-WP15a. One boolean, three places, and it has to be all three.
   *
   * The readers take it because with it off no transcript prose is ever in this
   * process; the server takes it because that is where a browser's `?task=1` is
   * answered. Passing it to only the last would leave the text in memory and
   * make `--no-task-text` a filter rather than a switch.
   */
  const taskText = options.taskText !== false;

  // N-WP18. `null` is the whole of `--no-codex`: with no reader constructed
  // there is no poll, no watch and no rollout opened on this run.
  const codex = options.codex !== false;
  const state = new NazarState({
    treeOptions: { taskText },
    ...(codex ? { codexOptions: { taskText } } : { codex: null }),
  });
  await state.start();

  // WP4b. Constructing it costs nothing: the scanner walks no directory until
  // the history panel asks for a page, and opens no transcript until the user
  // opens a session.
  const history = new HistoryScanner({ taskText });

  /*
   * N-WP17a. The remote hosts, when there are any.
   *
   * The server is handed a composite rather than the local state: one
   * `StateSource` whose snapshot is this machine's plus every remote session,
   * so nothing downstream — the SSE stream, the JSON route, the browser — has
   * to know that some of the cards came off an ssh pipe. With no `--remote`
   * the composite is not built at all.
   */
  const aliases = options.remotes ?? [];
  const remotes =
    aliases.length === 0
      ? undefined
      : new RemoteHosts({
          aliases,
          ...(options.remoteCommand === undefined ? {} : { command: options.remoteCommand }),
          err: options.err,
        });
  remotes?.start();

  // N-WP16: the same object twice, under two names, because it plays two parts.
  // `state` is polled for what is true now; `endings` is listened to for what
  // just happened. Naming both is what lets a route test take one without the
  // other.
  //
  // N-WP17a: under `--remote` both are the composite. A session ending on
  // another machine is an ending — the far end says so on its own stream — and
  // routing it through the same source is what makes the sound rules treat a
  // remote card exactly like a local one.
  const source = remotes === undefined ? state : new CompositeState(state, remotes);
  const server = await startNazarServer({
    state: source,
    endings: source,
    uiDir,
    history,
    port: options.port,
    taskText,
  });

  // The URL goes out before anything is spawned. Every opener below can fail
  // silently on some machine, and a printed URL is the one thing that cannot.
  options.out.write(`nazar ${VERSION} - pre-alpha\n`);
  options.out.write(`canvas: ${server.url}\n`);
  const snapshot = state.snapshot();
  const count = snapshot.sessions.length;
  options.out.write(
    count === 0
      ? 'no agent sessions found yet; the canvas updates as they start\n'
      : `watching ${count} session${count === 1 ? '' : 's'}\n`,
  );
  if (!snapshot.commandAvailable) {
    options.err.write(
      'note: "claude agents --json" did not answer, so liveness comes from the session files alone\n',
    );
  }
  // Said out loud, because the point of the switch is that somebody can rely on
  // it. A silent hard-disable is a promise nobody can check.
  if (!taskText) {
    options.out.write('task text is off: no transcript text is read on this run\n');
  }
  // Same reasoning: a switch nobody can check is a promise, not a switch.
  if (!codex) {
    options.out.write('codex is off: no rollout is read on this run\n');
  }
  // Said out loud for the same reason: a card on this canvas may be describing
  // work on another machine, and the line that says which machines are being
  // asked is the only place a person can check that from.
  if (remotes !== undefined) {
    options.out.write(
      `remote: ${aliases.join(', ')} over ssh, running "${remotes.command}"\n`,
    );
    options.out.write('  "nazar doctor" reports each connection and what it answered\n');
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
      // Every ssh child dies with this process; killing them here is what makes
      // "nothing is left running" true of Ctrl-C as well as of a crash.
      remotes?.stop();
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

    let doctorRemotes: string[];
    let doctorCommand: string | undefined;
    try {
      doctorRemotes = parseRemotes(rest);
      doctorCommand = parseValue(rest, '--remote-cmd');
    } catch (error) {
      err.write(`nazar: ${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }

    const report = await runDoctor({
      verbose: rest.includes('-v') || rest.includes('--verbose'),
      remotes: doctorRemotes,
      ...(doctorCommand === undefined ? {} : { remoteCommand: doctorCommand }),
    });
    out.write(`nazar doctor ${VERSION} · node ${process.version} · ${process.platform}\n\n`);
    out.write(`${report.lines.join('\n')}\n`);
    return 0;
  }

  /*
   * N-WP17a. `--agent` is a second mode, not a flag on the serve path, so it
   * is decided here — beside `doctor` and for the same reason. It binds
   * nothing, opens nothing and prints nothing to stdout except the stream, and
   * the flags it owns are its own: `--port` next to `--agent` is a
   * misunderstanding, and it is answered as one rather than ignored.
   */
  if (argv.includes('--agent')) {
    const unknownForAgent = unknownFlag(argv, AGENT_FLAGS);
    if (unknownForAgent !== undefined) {
      err.write(unknownFlagMessage(unknownForAgent));
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
    const handleAgent = await runAgent({
      claude: !argv.includes('--no-claude'),
      // N-WP18's switch, read the same way here as on the serve path: the
      // negative wins, and it reaches the reader rather than filtering its
      // output.
      codex: parseCodex(argv),
      hermes: argv.includes('--hermes') && !argv.includes('--no-hermes'),
      // The far end's default is off, and `NAZAR_TASK_TEXT=0` still overrides a
      // typed `--task-text` in the one direction that switch ever moves.
      taskText: argv.includes('--task-text') && parseTaskText(argv),
      out,
      err,
    });
    await handleAgent.done;
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
  let remotes: string[];
  let remoteCommand: string | undefined;
  try {
    port = parsePort(argv);
    remotes = parseRemotes(argv);
    remoteCommand = parseValue(argv, '--remote-cmd');
  } catch (error) {
    err.write(`nazar: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (remoteCommand !== undefined && remotes.length === 0) {
    err.write('nazar: --remote-cmd has nothing to run; name a host with --remote\n');
    return 2;
  }

  let handle: ServeHandle;
  try {
    handle = await serve({
      port,
      open: parseOpen(argv),
      taskText: parseTaskText(argv),
      codex: parseCodex(argv),
      remotes,
      ...(remoteCommand === undefined ? {} : { remoteCommand }),
      out,
      err,
    });
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
