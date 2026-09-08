/**
 * WP4f: the project-level status line, and why it makes two fields disappear.
 *
 * The bug this file exists for was found in live use and has nothing wrong with
 * it in Nazar at all. Cost and context window come from a capture that
 * `nazar-statusline` writes on every status-line redraw, and that wrapper is
 * installed at the **user** level — `statusLine.command` in the user settings —
 * chaining to whatever status line it replaced. Claude Code merges a project's
 * own settings over the user's, so a repository that sets `statusLine` for
 * itself does not chain to the wrapper: it *replaces* it. Every session started
 * inside that project therefore runs a different status line, writes no
 * capture, and shows no cost and no context window — while every session in
 * every other project on the same machine shows both.
 *
 * From the canvas that looked like a bug in Nazar. It is a two-line settings
 * file three directories away, and the only way anyone was ever going to find
 * it is if the tool said so. So this reader exists, and it is the narrowest
 * reader in the codebase:
 *
 * 1. **Two files, read-only, one key.** `<cwd>/.claude/settings.json` and
 *    `<cwd>/.claude/settings.local.json`, opened with `readFile` and nothing
 *    else. The parser builds a new object from `statusLine.command` alone; a
 *    settings file holds permissions, hooks, environment variables and model
 *    choices, and none of them is read, kept, or logged.
 * 2. **It is a new pinned path** (docs/pinned-internal-formats.md), because it
 *    is another file that belongs to Claude Code and can change shape without
 *    notice, and `test/pinned-paths.test.ts` fails if it is not in that table.
 * 3. **Nothing is written.** The same static gate as everywhere else
 *    (`test/no-writes.test.ts`) proves it: this file imports `readFile` and
 *    that is all it could ever do.
 *
 * It is also *slow to accuse*. A session with no capture is asked about only
 * after {@link CAPTURE_GRACE_MS}, because a session that started four seconds
 * ago has not necessarily had a status-line redraw yet, and a wrong explanation
 * is worse than none.
 *
 * # N-WP9: the other three reasons, and why the user-level file is read now
 *
 * A project's own `statusLine` is one of four reasons a live session can have
 * no capture, and `nazar doctor` was only able to name that one. The other
 * three need one more file:
 *
 * 1. the project overrides the status line — the reader above;
 * 2. **the wrapper is not the user-level status line at all** — it was never
 *    installed, or something replaced it since;
 * 3. **the session is older than the install** — Claude Code read the settings
 *    when the session started, so a status line installed afterwards does not
 *    reach it until it is restarted;
 * 4. nothing else: the session simply has not redrawn its status line yet.
 *
 * Two and three are answered by {@link readUserStatusLine}, which opens the
 * *user-level* settings file — the first thing in this repository to do so, and
 * a deliberate narrowing of a gate rather than an oversight. What changed is
 * only what may be **read**: `test/no-writes.test.ts` still fails the build if
 * any shipped source imports a filesystem binding that could write, and the
 * user-level file remains something Nazar will not modify until precision mode
 * (WP7) does it with a backup, a shown diff and an exact uninstall. One key
 * leaves this reader — `statusLine.command`, the same key the project reader
 * takes — plus one timestamp, and neither is ever written anywhere.
 *
 * The timestamp comes from the wrapper's own install artefact where there is
 * one. `nazar-statusline install` copies the settings file to
 * `settings.json.nazar-bak-<stamp>` **before** it edits anything, never writes
 * over an existing copy, and leaves it behind on uninstall (nazar-tray's
 * `docs/statusline-wrapper.md`), so the oldest such copy is the closest thing
 * on the disk to "when was this installed". Where there is none — a status line
 * configured by hand, or a machine where the backup was deleted — the settings
 * file's own modification time is used instead, and it is a weaker answer:
 * editing any other key in that file moves it. That is why the comparison only
 * ever produces a *likely* reason and the report says so.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/** A project's own settings, merged by Claude Code over the user's. */
export const CLAUDE_PROJECT_SETTINGS = '<cwd>/.claude/settings.json';

/** The same, not committed to the repository. Merged over the one above. */
export const CLAUDE_PROJECT_SETTINGS_LOCAL = '<cwd>/.claude/settings.local.json';

/** File names, in merge order: the later one wins where both set a key. */
export const PROJECT_SETTINGS_FILES = ['settings.json', 'settings.local.json'] as const;

/** The wrapper's own binary. A project pointing at it is not an override. */
export const WRAPPER_COMMAND = 'nazar-statusline';

/** Longest command string this reader will carry out of a settings file. */
export const MAX_COMMAND_LENGTH = 200;

/**
 * How long a session may be alive with no capture before the reason is worth
 * looking for.
 *
 * Ninety seconds is long past the first status-line redraw of any session that
 * is doing anything at all, and short enough that the hint appears while the
 * user is still looking at the card that lacks the numbers.
 */
export const CAPTURE_GRACE_MS = 90_000;

/** One project settings file that declares a status line. */
export interface ProjectStatusLine {
  /** Absolute path of the file that declared it. */
  readonly file: string;
  /** `statusLine.command`, capped. Absent when the key carried no command. */
  readonly command?: string;
  /**
   * True when this status line is **not** the Nazar wrapper, and therefore
   * displaces it. A project that points its own `statusLine` at
   * `nazar-statusline` keeps the captures coming and is not an override.
   */
  readonly overrides: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The status line one settings file declares, if it declares one.
 *
 * `statusLine` is observed as an object with `type` and `command`, and Claude
 * Code has also accepted a bare string in the past — both are handled, and
 * anything else that is merely *present* still counts as an override, because
 * what matters for a capture is that the project set the key at all.
 *
 * Malformed JSON is not an error to report: a settings file somebody is
 * half-way through editing is not evidence of anything, so it answers
 * `undefined` exactly as a file with no `statusLine` would.
 */
export function statusLineOf(raw: string, file: string): ProjectStatusLine | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const declared = parsed['statusLine'];
  if (declared === undefined || declared === null) return undefined;

  const declaredCommand = isRecord(declared)
    ? declared['command']
    : typeof declared === 'string'
      ? declared
      : undefined;
  const command =
    typeof declaredCommand === 'string' && declaredCommand.length > 0
      ? declaredCommand.slice(0, MAX_COMMAND_LENGTH)
      : undefined;

  return {
    file,
    ...(command === undefined ? {} : { command }),
    // A key with no command displaces the user-level one just as surely as one
    // with a command does, so "we could not read a command" is not "no
    // override" — it is an override we can say less about.
    overrides: command === undefined || !command.includes(WRAPPER_COMMAND),
  };
}

/**
 * Read a project's two settings files. Neither existing is the normal case.
 *
 * Both are read rather than only the first: `settings.local.json` is merged
 * last and can introduce a `statusLine` the committed file never had, which is
 * exactly the case a user would take longest to find on their own.
 */
export async function readProjectStatusLines(cwd: string): Promise<ProjectStatusLine[]> {
  const found: ProjectStatusLine[] = [];
  for (const name of PROJECT_SETTINGS_FILES) {
    const file = path.join(cwd, '.claude', name);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      // Absent, unreadable, or a directory. All three mean "this project says
      // nothing about the status line", which is the answer for most projects.
      continue;
    }
    const declared = statusLineOf(raw, file);
    if (declared !== undefined) found.push(declared);
  }
  return found;
}

/** The overriding declarations among a project's, in merge order. */
export function overridesIn(lines: readonly ProjectStatusLine[]): ProjectStatusLine[] {
  return lines.filter((line) => line.overrides);
}

/**
 * How many directories above a session's own the walk in
 * {@link readProjectStatusLinesUpward} will look.
 *
 * Claude Code merges the settings of a directory *and its ancestors*, so a
 * `statusLine` set at the top of a monorepo displaces the wrapper for every
 * session started anywhere inside it — and the canvas's own hint, which reads
 * one directory, cannot see that. Doctor walks up because it is asked once, by
 * a person, about a handful of sessions; the live probe deliberately does not,
 * because it is asked every two seconds about every card.
 *
 * Thirty-two is past any real path and stops a symlink loop from turning a
 * report into a hang.
 */
export const MAX_SETTINGS_ANCESTORS = 32;

export interface UpwardOptions {
  /**
   * A directory the walk stops **before** reading — the user's home.
   *
   * This is not an optimisation, it is the difference between two levels of the
   * same file. `<home>/.claude/settings.json` is the *user-level* settings file,
   * the one the wrapper installs itself into; a session whose working directory
   * happens to be under the home directory would otherwise reach it on the way
   * up and be told a *project* had replaced its status line. It has its own
   * reader ({@link readUserStatusLine}) and its own sentence, and conflating the
   * two would produce a confident, wrong explanation for every session started
   * anywhere in the home directory.
   */
  readonly stopAt?: string;
}

/** Whether two directory paths name the same place, as this platform decides. */
function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/**
 * Every `statusLine` declared for a working directory: its own first, then each
 * ancestor's, nearest first.
 *
 * Nearest first because that is merge order reversed, and the caller wants the
 * *closest* explanation — a project that sets its own status line explains the
 * missing capture better than the repository three directories above it that
 * also sets one.
 */
export async function readProjectStatusLinesUpward(
  cwd: string,
  options: UpwardOptions = {},
): Promise<ProjectStatusLine[]> {
  const found: ProjectStatusLine[] = [];
  let dir = path.resolve(cwd);
  for (let step = 0; step <= MAX_SETTINGS_ANCESTORS; step += 1) {
    if (options.stopAt !== undefined && samePath(dir, options.stopAt)) break;
    found.push(...(await readProjectStatusLines(dir)));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * N-WP9: the user-level status line, and when it was installed
 * ------------------------------------------------------------------ */

/** Claude Code's own settings file, where the wrapper installs itself. */
export const CLAUDE_USER_SETTINGS = '~/.claude/settings.json';

/**
 * What `nazar-statusline install` copies the settings file to before it edits
 * it: `settings.json.nazar-bak-<stamp>`, never written over, left behind by
 * `uninstall`. The stamp's format is nazar-tray's business, so the file's
 * modification time is read rather than its name parsed.
 */
export const WRAPPER_BACKUP_PREFIX = 'settings.json.nazar-bak-';

/** What the user-level settings file says about the status line. */
export interface UserStatusLine {
  /** Absolute path of the file, whether or not it exists. */
  readonly file: string;
  /** False on a machine where Claude Code has no user settings at all. */
  readonly exists: boolean;
  /** `statusLine.command`, capped. Absent when no status line is configured. */
  readonly command?: string;
  /** True when that command is the wrapper, so captures should be written. */
  readonly isWrapper: boolean;
  /**
   * True when the command is spelled so that the shell will never spawn it.
   *
   * Windows only, and it is the whole difference between "the wrapper has not
   * ticked yet" and "the wrapper has never once run". See
   * {@link hasUnquotedBackslash}.
   */
  readonly bashUnsafe: boolean;
  /** When the status line was most likely put there, in epoch milliseconds. */
  readonly installedAt?: number;
  /** Which file {@link installedAt} came from, so the report can hedge. */
  readonly installedAtSource?: 'backup' | 'settings';
}

/** The oldest wrapper backup's time, else the settings file's own. */
async function installedAt(
  configDir: string,
  settingsFile: string,
): Promise<Pick<UserStatusLine, 'installedAt' | 'installedAtSource'>> {
  let oldest: number | undefined;
  try {
    for (const name of await readdir(configDir)) {
      if (!name.startsWith(WRAPPER_BACKUP_PREFIX)) continue;
      try {
        const info = await stat(path.join(configDir, name));
        if (oldest === undefined || info.mtimeMs < oldest) oldest = info.mtimeMs;
      } catch {
        // Removed between the listing and the stat. One fewer candidate.
      }
    }
  } catch {
    // No configuration directory, or one this process may not list. Both mean
    // the same thing here: no backup to date the install by.
  }
  // The *oldest* backup, not the newest: a second install after an uninstall
  // writes a second copy, and the question "is this session older than the
  // status line it is missing" is about the first time one was put there.
  if (oldest !== undefined) return { installedAt: oldest, installedAtSource: 'backup' };

  try {
    const info = await stat(settingsFile);
    return { installedAt: info.mtimeMs, installedAtSource: 'settings' };
  } catch {
    return {};
  }
}

/**
 * Whether `sh` would eat a backslash in this command line.
 *
 * **This is the root cause of a status line that reported itself installed and
 * had never run.** On Windows, Claude Code hands `statusLine.command` to Git
 * Bash where it can find one and to PowerShell where it cannot, and in `sh` a
 * backslash outside quotes is the escape character — so a perfectly ordinary
 * `C:\…\nazar-statusline.exe` reaches the shell with its separators eaten,
 * nothing is spawned, no capture is written, and every card shows no cost and
 * no context window. Doctor used to report that as *no status-line tick yet*,
 * which is what a session sitting at a prompt looks like and is the one reading
 * that makes a person wait instead of fixing it.
 *
 * The rule `sh` follows: outside quotes a backslash escapes the next character
 * and both disappear; inside double quotes it escapes only `"`, `\`, `$` and a
 * backtick and is literal otherwise; inside single quotes it is always literal.
 * So the only backslash worth reporting is an unquoted one.
 *
 * Nothing here is a judgement about a command line off Windows, where a
 * backslash is far more often a deliberate escape than a separator; the caller
 * is what applies the platform.
 */
export function hasUnquotedBackslash(command: string): boolean {
  let single = false;
  let double = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === "'" && !double) {
      single = !single;
    } else if (character === '"' && !single) {
      double = !double;
    } else if (character === '\\') {
      if (single) continue;
      if (double) {
        // Consuming the escaped character is what keeps the quote state right
        // for a command line that really does contain `"a\"b"`.
        const next = command[index + 1];
        if (next === '"' || next === '\\' || next === '$' || next === '`') index += 1;
        continue;
      }
      return true;
    }
  }
  return false;
}

/**
 * Read `<config dir>/settings.json` for the one key, and date the install.
 *
 * Every failure is the same answer: a file that is missing, unreadable or
 * malformed says nothing about the status line, which is exactly what a machine
 * with no user settings says. Nothing here throws, because doctor asking a
 * question must never be the reason doctor cannot answer.
 *
 * `platform` is a parameter rather than a read of `process.platform` for the
 * reason every other injected value here is one: the case that only happens on
 * Windows has to be a case the tests can reach from anywhere.
 */
export async function readUserStatusLine(
  configDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<UserStatusLine> {
  const file = path.join(configDir, 'settings.json');

  let raw: string | undefined;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    raw = undefined;
  }

  const declared = raw === undefined ? undefined : statusLineOf(raw, file);
  const dated = await installedAt(configDir, file);

  return {
    file,
    exists: raw !== undefined,
    ...(declared?.command === undefined ? {} : { command: declared.command }),
    // `overrides` is "this is not the wrapper", so the wrapper is its negation —
    // and an absent declaration is not the wrapper either.
    isWrapper: declared !== undefined && !declared.overrides,
    bashUnsafe:
      platform === 'win32' &&
      declared?.command !== undefined &&
      hasUnquotedBackslash(declared.command),
    ...dated,
  };
}

/** One project directory, as this probe last saw it. */
interface Probed {
  readonly at: number;
  readonly lines: readonly ProjectStatusLine[];
}

export interface ProjectStatusLineProbeOptions {
  /** How long an answer is trusted before the directory is read again. */
  readonly ttlMs?: number;
  /** Injected by tests. */
  readonly now?: () => number;
  /** Injected by tests, so no real filesystem is needed. */
  readonly read?: (cwd: string) => Promise<ProjectStatusLine[]>;
}

/** A settings file changes about as often as a repository is cloned. */
export const DEFAULT_PROBE_TTL_MS = 5 * 60_000;

/**
 * A cache in front of {@link readProjectStatusLines}, keyed by working
 * directory.
 *
 * The join that needs this answer is synchronous and runs on every publish, so
 * the read cannot happen inside it. This is the shape that resolves that: a
 * synchronous {@link lookup} that answers from the cache, and an asynchronous
 * {@link probe} the publisher fires and forgets. The consequence is that the
 * hint appears one publish after the grace period rather than on the same one,
 * which is two seconds later on a canvas that has already been waiting ninety.
 */
export class ProjectStatusLineProbe {
  private readonly cache = new Map<string, Probed>();

  private readonly pending = new Set<string>();

  private readonly ttlMs: number;

  private readonly now: () => number;

  private readonly read: (cwd: string) => Promise<ProjectStatusLine[]>;

  constructor(options: ProjectStatusLineProbeOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_PROBE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.read = options.read ?? readProjectStatusLines;
  }

  /** What is known about this directory right now, without reading anything. */
  lookup(cwd: string): readonly ProjectStatusLine[] | undefined {
    return this.cache.get(cwd)?.lines;
  }

  /** True when this directory declares a status line that is not the wrapper. */
  overrides(cwd: string | undefined): boolean {
    if (cwd === undefined) return false;
    const lines = this.lookup(cwd);
    return lines !== undefined && lines.some((line) => line.overrides);
  }

  /**
   * Read this directory unless a fresh answer is already held, or a read for it
   * is already in flight. Never rejects: a probe that failed is a directory
   * that stays unknown, which draws nothing.
   */
  async probe(cwd: string): Promise<void> {
    const now = this.now();
    const held = this.cache.get(cwd);
    if (held !== undefined && now - held.at < this.ttlMs) return;
    if (this.pending.has(cwd)) return;
    this.pending.add(cwd);
    try {
      const lines = await this.read(cwd);
      this.cache.set(cwd, { at: this.now(), lines });
    } catch {
      this.cache.set(cwd, { at: this.now(), lines: [] });
    } finally {
      this.pending.delete(cwd);
    }
  }

  /** Forget everything. Used when the state stops. */
  clear(): void {
    this.cache.clear();
  }
}
