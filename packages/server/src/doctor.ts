/**
 * `nazar doctor` — why the canvas looks the way it does, without starting it.
 *
 * The canvas is a join of four sources, and when it is empty the interesting
 * question is always *which* of them came back empty. Doctor answers that in
 * one screen: where Claude Code's configuration directory resolved to, how many
 * session files are in it, whether `claude agents --json` answers and how long
 * it takes, how much is in the transcript store, which of the pinned formats
 * in docs/pinned-internal-formats.md could be validated against real data on
 * this machine, and — if the answer is zero sessions — the reason.
 *
 * **N-WP9 added the join the report was missing.** It printed "3 live
 * processes" in one section and "1 capture" in another and never subtracted
 * one from the other, which is the question a person runs doctor to answer.
 * Every live session without a capture now gets a line naming the most likely
 * reason it has none — a project's own status line, the wrapper not being the
 * user-level one, a session older than the install, or no status-line tick yet.
 *
 * **T-WP8 added a fifth, and it is the one that had been hiding behind the
 * fourth.** On Windows Claude Code runs `statusLine.command` through Git Bash,
 * where an unquoted backslash is an escape — so a wrapper installed at
 * `C:\…\nazar-statusline.exe` is never spawned at all, the capture directory
 * stays empty, and the report used to call that *no status-line tick yet*, the
 * one reading that tells a person to wait rather than to fix it.
 * The same package fixed a count that had been quietly wrong since WP4f: the
 * explanatory line said "none of the 1 live session" on a machine running
 * three, because it counted distinct working directories rather than sessions.
 *
 * Three rules this file keeps:
 *
 * 1. **It starts nothing.** No watcher, no server, no browser. It reads, it
 *    prints, it returns. Running it while Claude Code is working changes
 *    nothing about Claude Code.
 * 2. **It prints no path under the user's home** unless `--verbose` is given.
 *    The home directory is collapsed to `~` by the same {@link collapseHome}
 *    the canvas uses, and a configuration directory that lives outside the home
 *    is described rather than printed.
 * 3. **It reads through the shipped parsers only.** The transcript sample goes
 *    through `TranscriptTailer` + `extractTranscriptLine`, so doctor inherits
 *    the metadata-only guarantee instead of opening a second way in. Nothing it
 *    reads is kept: only counts leave this file.
 */
import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type {
  AgentsRunResult,
  AgentsRunner,
  CaptureScan,
  LimitsScan,
  ProjectStatusLine,
  SessionFileEntry,
  UserStatusLine,
} from '@nazar/core';
import {
  CLAUDE_AGENT_META_FILE,
  CLAUDE_AGENT_TRANSCRIPT,
  CLAUDE_PROJECT_DIR,
  CLAUDE_PROJECTS_DIR,
  CLAUDE_SESSION_FILE,
  CLAUDE_SESSION_TRANSCRIPT,
  CLAUDE_SUBAGENTS_DIR,
  CLAUDE_WORKFLOW_RUN_DIR,
  NAZAR_LIMITS_FILE,
  NAZAR_STATUSLINE_DIR,
  WRAPPER_COMMAND,
  captureAgeSource,
  claudeConfigDir,
  createClaudeAgentsRunner,
  extractTranscriptLine,
  isPidAlive,
  nazarLimitsPath,
  newestCapture,
  projectsDirPath,
  readCapturesDir,
  readLimitsFile,
  readProjectStatusLinesUpward,
  readSessionsDir,
  readSubagentsDir,
  readUserStatusLine,
  selectQuota,
  sessionTranscriptPaths,
  sessionsDirPath,
  statuslineCapturesDir,
  TranscriptTailer,
} from '@nazar/core';

import { OPEN_HINT, browserOpenChain, describeOpenAttempt } from './open.js';
import { collapseHome } from './redact.js';

/** Bytes of a transcript doctor samples to check the pinned line shape. */
export const DOCTOR_SAMPLE_BYTES = 512 * 1024;

/** Session directories doctor is willing to probe for a `subagents/` sample. */
const MAX_SUBAGENT_PROBES = 400;

export interface DoctorOptions {
  /** Print absolute paths and per-source detail. Off by default. */
  readonly verbose?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  /** Injected by tests so no real `claude` is spawned. */
  readonly agents?: AgentsRunner;
  /** Liveness probe, injected by tests. */
  readonly isAlive?: (pid: number) => boolean;
  /**
   * Platform the browser-opener chain is reported for, and the one the
   * user-level status line is judged as a shell command on. Injected by tests.
   */
  readonly platform?: NodeJS.Platform;
}

export interface DoctorReport {
  /** The report, one line per entry, without trailing newlines. */
  readonly lines: readonly string[];
  /** Sessions the canvas would draw right now. */
  readonly liveSessions: number;
}

/** A pinned-format row and what checking it against this machine produced. */
interface FormatCheck {
  readonly name: string;
  readonly ok: boolean;
  /** Counts when it validated; the reason it could not when it did not. */
  readonly detail: string;
}

/** What one walk of the transcript store found. Counts and two sample paths. */
interface StoreSurvey {
  readonly missing: boolean;
  readonly projectDirs: number;
  readonly transcripts: number;
  readonly sessionDirs: number;
  readonly subagentDirs: number;
  readonly workflowDirs: number;
  readonly warnings: number;
  readonly walkMs: number;
  /** Newest `<session>.jsonl`, sampled for the transcript row. Never printed. */
  readonly newestTranscript?: string;
  /** First `subagents/` directory found, sampled for the meta row. Never printed. */
  readonly sampleSubagentsDir?: string;
}

/**
 * A path as the report should show it: absolute under `--verbose`, home
 * collapsed to `~` otherwise, and described rather than printed when it lies
 * outside the home directory entirely (which `CLAUDE_CONFIG_DIR` allows).
 */
export function displayPath(target: string, home: string, verbose: boolean): string {
  if (verbose) return target;
  const collapsed = collapseHome(target, home);
  if (collapsed.startsWith('~')) return collapsed;
  return '<outside your home directory; run "nazar doctor --verbose" to print it>';
}

/**
 * The plural of an English noun phrase, for the small set of endings this
 * report actually uses.
 *
 * The first version added `s` and nothing else, which is wrong for two whole
 * classes of word and was wrong here in a way that hid itself: every caller
 * that needed `entries`, `directories` or `processes` passed the plural by
 * hand, so the report read correctly while the helper stayed broken for the
 * next caller. A release audit found it as `plural(2, 'entry')` → `2 entrys`,
 * which is what a new call site would have printed.
 *
 * Three rules, and they are the three that matter for the words on this page:
 *
 * - a consonant followed by `y` becomes `ies` (`directory` → `directories`),
 *   while a vowel followed by `y` does not (`day` → `days`);
 * - a sibilant ending — `s`, `x`, `z`, `ch`, `sh` — takes `es`
 *   (`process` → `processes`);
 * - everything else takes `s`.
 *
 * It is deliberately not an English pluraliser. There is no `-f`/`-ves`, no
 * Latin `-us`/`-i`, and no irregular table, because a report that needs one of
 * those should say so at the call site — which is what the third argument is
 * still there for. The rule is applied to the **last word** of the phrase, so
 * `live process` and `project directory` come out right without any caller
 * spelling them out.
 */
export function plural(count: number, one: string, many = pluralise(one)): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The plural form of a noun phrase. Exported for the table test alone. */
export function pluralise(one: string): string {
  const cut = one.lastIndexOf(' ');
  const head = cut === -1 ? '' : one.slice(0, cut + 1);
  const word = cut === -1 ? one : one.slice(cut + 1);
  if (word.length === 0) return one;

  const lower = word.toLowerCase();
  if (/[^aeiou]y$/.test(lower)) return `${head}${word.slice(0, -1)}ies`;
  if (/(?:s|x|z|ch|sh)$/.test(lower)) return `${head}${word}es`;
  return `${head}${word}s`;
}

/**
 * Walk `~/.claude/projects` for counts and two sample paths.
 *
 * `readdir` only, plus one `stat` per transcript to find the newest: no file is
 * opened here. Measured on the maintainer's machine in WP4b, the same walk over
 * 68 project directories and 134 transcripts costs 16-18 ms.
 */
async function surveyStore(projectsDir: string): Promise<StoreSurvey> {
  const started = process.hrtime.bigint();
  const elapsed = (): number => Number(process.hrtime.bigint() - started) / 1e6;

  let slugs;
  try {
    slugs = await readdir(projectsDir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      missing: code === 'ENOENT' || code === 'ENOTDIR',
      projectDirs: 0,
      transcripts: 0,
      sessionDirs: 0,
      subagentDirs: 0,
      workflowDirs: 0,
      warnings: code === 'ENOENT' || code === 'ENOTDIR' ? 0 : 1,
      walkMs: elapsed(),
    };
  }

  let projectDirs = 0;
  let transcripts = 0;
  let sessionDirs = 0;
  let subagentDirs = 0;
  let workflowDirs = 0;
  let warnings = 0;
  let probes = 0;
  let newestTranscript: string | undefined;
  let newestAt = -1;
  let sampleSubagentsDir: string | undefined;

  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    projectDirs += 1;
    const projectDir = path.join(projectsDir, slug.name);

    let entries;
    try {
      entries = await readdir(projectDir, { withFileTypes: true });
    } catch {
      warnings += 1;
      continue;
    }

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        transcripts += 1;
        const file = path.join(projectDir, entry.name);
        try {
          const info = await stat(file);
          if (info.mtimeMs > newestAt) {
            newestAt = info.mtimeMs;
            newestTranscript = file;
          }
        } catch {
          warnings += 1;
        }
        continue;
      }
      if (!entry.isDirectory()) continue;

      sessionDirs += 1;
      if (probes >= MAX_SUBAGENT_PROBES) continue;
      probes += 1;

      const { subagentsDir, workflowsDir } = sessionTranscriptPaths(projectDir, entry.name);
      let hasSubagents = false;
      try {
        await readdir(subagentsDir);
        hasSubagents = true;
      } catch {
        hasSubagents = false;
      }
      if (!hasSubagents) continue;

      subagentDirs += 1;
      sampleSubagentsDir ??= subagentsDir;
      try {
        await readdir(workflowsDir);
        workflowDirs += 1;
      } catch {
        // No workflow run in this session, which is the normal case here.
      }
    }
  }

  return {
    missing: false,
    projectDirs,
    transcripts,
    sessionDirs,
    subagentDirs,
    workflowDirs,
    warnings,
    walkMs: elapsed(),
    newestTranscript,
    sampleSubagentsDir,
  };
}

/** Counts from the head of one transcript, taken through the shipped parser. */
interface TranscriptSample {
  readonly lines: number;
  readonly assistant: number;
  readonly withMessageId: number;
  readonly withRequestId: number;
  readonly withUsage: number;
  readonly sidechain: number;
  readonly withAgentId: number;
  readonly error?: string;
}

/**
 * Read at most {@link DOCTOR_SAMPLE_BYTES} from the start of a transcript and
 * count what the pinned row promises. The parser is the canvas's own, so this
 * costs one read and adds no way for text to escape.
 */
async function sampleTranscript(file: string): Promise<TranscriptSample> {
  const empty = {
    lines: 0,
    assistant: 0,
    withMessageId: 0,
    withRequestId: 0,
    withUsage: 0,
    sidechain: 0,
    withAgentId: 0,
  };
  let result;
  try {
    result = await new TranscriptTailer(file, { maxBytesPerRead: DOCTOR_SAMPLE_BYTES }).read();
  } catch (error) {
    return { ...empty, error: (error as NodeJS.ErrnoException).code ?? 'unreadable' };
  }
  if (result.missing) return { ...empty, error: 'the file disappeared while reading it' };

  let assistant = 0;
  let withMessageId = 0;
  let withRequestId = 0;
  let withUsage = 0;
  let sidechain = 0;
  let withAgentId = 0;

  for (const line of result.lines) {
    const event = extractTranscriptLine(line);
    if (event === undefined) continue;
    if (event.isSidechain === true) sidechain += 1;
    if (event.agentId !== undefined) withAgentId += 1;
    if (event.type !== 'assistant') continue;
    assistant += 1;
    if (event.messageId !== undefined) withMessageId += 1;
    if (event.requestId !== undefined) withRequestId += 1;
    if (event.usage !== undefined) withUsage += 1;
  }

  return {
    lines: result.lines.length,
    assistant,
    withMessageId,
    withRequestId,
    withUsage,
    sidechain,
    withAgentId,
  };
}

/**
 * Check every row of docs/pinned-internal-formats.md against this machine.
 *
 * A row that cannot be checked is not a failure: a machine with no subagent has
 * no `meta.json` to validate, and saying so is the point of the command. What
 * the report must never do is claim a shape held when nothing was there to hold
 * it, so each row carries either counts or the reason it stayed unchecked.
 */
async function checkFormats(
  agents: AgentsRunResult,
  sessions: { entries: readonly SessionFileEntry[]; warnings: number; missingDirectory: boolean },
  store: StoreSurvey,
  captures: CaptureScan,
  limits: LimitsScan,
): Promise<FormatCheck[]> {
  const checks: FormatCheck[] = [];

  checks.push({
    name: 'claude agents --json',
    ok: agents.ok && agents.entries.length > 0,
    detail: !agents.ok
      ? `not validated: the command did not answer (${agents.error ?? 'unknown error'})`
      : agents.entries.length === 0
        ? 'not validated: the command answered with an empty list, so no entry could be checked'
        : `${plural(agents.entries.length, 'entry')}, every one carrying a pid and a status`,
  });

  const statuses = new Set(sessions.entries.map((entry) => entry.status));
  checks.push({
    name: CLAUDE_SESSION_FILE,
    ok: sessions.entries.length > 0,
    detail:
      sessions.entries.length > 0
        ? `${plural(sessions.entries.length, 'file')} parsed, ${plural(sessions.warnings, 'unreadable file')}, status seen: ${[...statuses].sort().join(', ')}`
        : sessions.missingDirectory
          ? 'not validated: the sessions directory does not exist yet'
          : 'not validated: the sessions directory holds no session file right now',
  });

  checks.push({
    name: CLAUDE_PROJECTS_DIR,
    ok: !store.missing && store.transcripts > 0,
    detail: store.missing
      ? 'not validated: the transcript store does not exist yet'
      : store.transcripts === 0
        ? 'not validated: the store exists but holds no transcript'
        : `${plural(store.transcripts, 'transcript')} in ${plural(store.projectDirs, 'project directory')}, walked in ${store.walkMs.toFixed(0)} ms`,
  });

  checks.push({
    name: CLAUDE_PROJECT_DIR,
    ok: store.projectDirs > 0,
    detail:
      store.projectDirs > 0
        ? `${plural(store.projectDirs, 'slug')} listed; the slug transform is pinned by packages/core/test/project-slug.test.ts`
        : 'not validated: no project directory exists yet',
  });

  checks.push({
    name: CLAUDE_SUBAGENTS_DIR,
    ok: store.subagentDirs > 0,
    detail:
      store.subagentDirs > 0
        ? `${plural(store.subagentDirs, 'directory')} across ${plural(store.sessionDirs, 'session directory')}`
        : 'not validated: no session on this machine has spawned a subagent',
  });

  if (store.sampleSubagentsDir === undefined) {
    const reason = 'not validated: there is no subagents directory to sample';
    checks.push({ name: CLAUDE_AGENT_META_FILE, ok: false, detail: reason });
    checks.push({ name: CLAUDE_AGENT_TRANSCRIPT, ok: false, detail: reason });
  } else {
    const scan = await readSubagentsDir(store.sampleSubagentsDir);
    const typed = scan.metas.filter((meta) => meta.agentType !== undefined).length;
    const depths = scan.metas.filter((meta) => meta.spawnDepth !== undefined).length;
    const parents = scan.metas.filter((meta) => meta.parentAgentId !== undefined);
    const ids = new Set(scan.metas.map((meta) => meta.id));
    const dangling = parents.filter((meta) => !ids.has(meta.parentAgentId ?? '')).length;
    checks.push({
      name: CLAUDE_AGENT_META_FILE,
      ok: scan.metas.length > 0 && typed === scan.metas.length && dangling === 0,
      detail:
        scan.metas.length === 0
          ? 'not validated: the sampled directory holds no meta file'
          : `${plural(scan.metas.length, 'file')} in one session, ${typed} with agentType, ${depths} with spawnDepth, ${plural(parents.length, 'parent link')}, ${dangling} dangling`,
    });

    const first = scan.transcripts[0];
    if (first === undefined) {
      checks.push({
        name: CLAUDE_AGENT_TRANSCRIPT,
        ok: false,
        detail: 'not validated: the sampled directory holds no subagent transcript',
      });
    } else {
      const sample = await sampleTranscript(first.file);
      checks.push({
        name: CLAUDE_AGENT_TRANSCRIPT,
        ok: sample.error === undefined && sample.withAgentId > 0,
        detail:
          sample.error !== undefined
            ? `not validated: ${sample.error}`
            : `${plural(sample.lines, 'line')} sampled, ${sample.withAgentId} carrying agentId, ${sample.sidechain} marked isSidechain`,
      });
    }
  }

  checks.push({
    name: CLAUDE_WORKFLOW_RUN_DIR,
    ok: store.workflowDirs > 0,
    detail:
      store.workflowDirs > 0
        ? `${plural(store.workflowDirs, 'run directory')} found`
        : 'not validated: no workflow run directory exists on this machine (the shape is handled defensively, never pinned)',
  });

  if (store.newestTranscript === undefined) {
    checks.push({
      name: CLAUDE_SESSION_TRANSCRIPT,
      ok: false,
      detail: 'not validated: there is no session transcript to sample',
    });
  } else {
    const sample = await sampleTranscript(store.newestTranscript);
    checks.push({
      name: CLAUDE_SESSION_TRANSCRIPT,
      ok: sample.error === undefined && sample.assistant > 0 && sample.withMessageId === sample.assistant,
      detail:
        sample.error !== undefined
          ? `not validated: ${sample.error}`
          : sample.assistant === 0
            ? 'not validated: the sampled head held no assistant line'
            : `${plural(sample.assistant, 'assistant line')} in the newest transcript's first ${DOCTOR_SAMPLE_BYTES / 1024} KB: ${sample.withMessageId} with message.id, ${sample.withRequestId} with requestId, ${sample.withUsage} with usage`,
    });
  }

  const captured = newestCapture(captures);
  checks.push({
    name: NAZAR_STATUSLINE_DIR,
    ok: captures.configured && captures.captures.size > 0,
    detail: !captures.configured
      ? 'not validated: no capture directory, so the status-line wrapper is not installed'
      : captures.captures.size === 0
        ? 'not validated: the directory exists but holds no capture yet'
        : `${plural(captures.captures.size, 'capture')}, ${plural(captures.warnings, 'unreadable file')}; ` +
          `newest carries ${[
            captured?.costUsd === undefined ? undefined : 'cost',
            captured?.contextWindow === undefined ? undefined : 'context window',
            captured?.effort === undefined ? undefined : 'effort',
            captured?.rateLimits === undefined ? undefined : 'rate limits',
          ]
            .filter((part) => part !== undefined)
            .join(', ') || 'none of the four fields Nazar reads'}`,
  });

  const document = limits.document;
  checks.push({
    name: NAZAR_LIMITS_FILE,
    ok: document !== undefined,
    detail:
      document !== undefined
        ? `schemaVersion ${document.schemaVersion}, ${plural(document.providers.length, 'provider')}: ` +
          document.providers
            .map(
              (provider) =>
                `${provider.name} ${provider.configured ? `${plural(provider.windows.length, 'window')}` : 'not configured'}`,
            )
            .join(', ')
        : limits.configured
          ? `not validated: the file is there and could not be read (${limits.error ?? 'unknown reason'})`
          : 'not validated: no limits file, so nazar-tray is not installed',
  });

  return checks;
}

/**
 * The two optional sources, and how to get them.
 *
 * This is the section that answers "why are there no usage limits", which is the
 * question WP5 creates: before it there was nothing to miss. It reports what is
 * on the machine and prints the wrapper's own dry-run command — **prints**, and
 * never runs it. Installing the wrapper edits a file that belongs to Claude
 * Code, and that is the user's decision to take, in their own terminal, with
 * the diff in front of them.
 */
/**
 * WP4f: the project-level `statusLine` that swallows the wrapper.
 *
 * This is the section the maintainer's live use created. Cost and context were
 * missing on some cards and present on others, on one machine, with the wrapper
 * installed — and the reason was a `statusLine` key in a project's own
 * settings, which Claude Code merges over the user's and which therefore
 * replaces the wrapper for every session started in that directory. Nothing
 * about it is visible from the canvas, so doctor names the file, names the key,
 * and says what to change it to.
 *
 * The suggestion is to *point the project's status line at the wrapper too*
 * rather than to delete the key: the wrapper chains to whatever it replaced,
 * but it only ever installed itself at the user level, so a project has to opt
 * in for the chain to reach it. Removing the key works as well and is offered
 * second, because it changes what that project's status line shows.
 */
function statusLineSection(
  overrides: readonly ProjectStatusLine[],
  counts: { readonly live: number; readonly checked: number },
  home: string,
  verbose: boolean,
): string[] {
  if (counts.live === 0) return [];
  if (overrides.length === 0) {
    // N-WP9: **sessions**, not distinct working directories. Counting directories is
    // what made this line read "none of the 1 live session" on a machine running
    // three of them in one repository. A session whose file carries no working
    // directory cannot be checked at all, and rather than quietly counting it as
    // clear, the sentence says how many were looked at.
    return [
      counts.checked === counts.live
        ? `  project statusLine — none of the ${plural(counts.live, 'live session')} runs in a project that`
        : `  project statusLine — none of the ${counts.checked} of ${plural(counts.live, 'live session')} with a known directory runs in a project that`,
      '  overrides the status line, so nothing there is blocking a capture.',
    ];
  }

  const lines: string[] = [
    `  project statusLine — ${plural(overrides.length, 'project settings file')} replace the`,
    '  user-level status line, so the wrapper never runs for sessions started there and',
    '  those cards show no cost and no context window:',
  ];
  for (const override of overrides) {
    lines.push(
      `    ${displayPath(override.file, home, verbose)} — "statusLine"${
        override.command === undefined ? '' : `.command = ${JSON.stringify(override.command)}`
      }`,
    );
  }
  lines.push(
    `  Fix it either way: point that "statusLine.command" at ${WRAPPER_COMMAND} as well — it`,
    '  chains to whatever it replaces, but it installed itself at the user level only — or',
    '  remove the "statusLine" key from the project so the user-level one applies again.',
  );
  return lines;
}

/* ------------------------------------------------------------------ *
 * N-WP9: relating "N live processes" to "M captures"
 * ------------------------------------------------------------------ */

/**
 * How many sessions are named one by one before the list is summarised.
 *
 * Ten is more live sessions than the maintainer has ever had at once, and a
 * report that scrolls is a report nobody reads to the end of.
 */
export const MAX_EXPLAINED_SESSIONS = 10;

/** What doctor needs to know about one live session to explain it. */
export interface MissingCapture {
  readonly pid: number;
  /** The nearest project settings file that displaces the wrapper for it. */
  readonly override?: ProjectStatusLine;
  readonly cwd?: string;
  readonly startedAt?: number;
}

/**
 * Why one live session has no capture, in one sentence.
 *
 * The four reasons are tried in the order of how *specific* they are, not how
 * likely: a project override explains this session and no other, while an
 * absent user-level status line explains every session on the machine. Naming
 * the specific one first is what makes the line worth printing per session —
 * otherwise every line would say the same thing and the list would be a count
 * with extra words.
 *
 * The last reason is the one with no evidence behind it, and it is phrased as
 * what has *not* happened rather than as a fault: Claude Code runs the status
 * line after a turn, so a session sitting at a prompt has genuinely not written
 * one yet, and that is the ordinary state of a session somebody just started.
 */
export function captureReason(
  session: MissingCapture,
  user: UserStatusLine,
  now: number,
): string {
  if (session.override !== undefined) {
    return (
      'this project sets its own "statusLine"' +
      (session.override.command === undefined
        ? ''
        : ` (${JSON.stringify(session.override.command)})`) +
      ', so the wrapper never runs for it'
    );
  }

  if (!user.exists) {
    return 'Claude Code has no user settings file here, so nothing installs a status line';
  }
  if (user.command === undefined) {
    return 'no "statusLine" is configured at the user level, so the wrapper never runs';
  }
  if (!user.isWrapper) {
    return `the user-level "statusLine" is ${JSON.stringify(user.command)}, not ${WRAPPER_COMMAND}`;
  }

  // Before the install date and before the tick, because it outranks both: a
  // command the shell cannot start explains a session that has been running for
  // hours exactly as well as one started a minute ago, and restarting that
  // session — which is what the install-date reason tells a person to do —
  // would change nothing at all.
  if (user.bashUnsafe) {
    return (
      `the user-level "statusLine" is ${JSON.stringify(user.command)}, and Claude Code runs ` +
      'it through Git Bash on Windows, where those unquoted backslashes are escapes — so ' +
      `the wrapper is never spawned; \`${WRAPPER_DRY_RUN}\` shows the rewrite that fixes it`
    );
  }

  if (
    session.startedAt !== undefined &&
    user.installedAt !== undefined &&
    session.startedAt < user.installedAt
  ) {
    const hedge =
      user.installedAtSource === 'backup'
        ? ''
        : ' (dated by the settings file, which any other edit also moves)';
    return (
      `this session started ${describeAge(user.installedAt - session.startedAt)} before the ` +
      `status line was installed${hedge}; restart it and the capture appears`
    );
  }

  const age =
    session.startedAt === undefined
      ? ''
      : ` (this one is ${describeAge(Math.max(0, now - session.startedAt))} old)`;
  return `no status-line tick yet — Claude Code runs it after a turn${age}`;
}

/**
 * The section that relates the two counts printed above it.
 *
 * Before this, `nazar doctor` printed "3 live processes" in one section and "1
 * capture" in another and left the arithmetic to the reader — which is the
 * whole question a person runs doctor to answer, and the one thing the report
 * would not say. The heading is the subtraction; the lines under it are the
 * reasons.
 *
 * With no capture directory at all there is one machine-wide answer and it is
 * already four lines above, so this says so once rather than repeating it once
 * per session.
 */
function missingCaptureSection(
  live: readonly MissingCapture[],
  captures: CaptureScan,
  missing: readonly MissingCapture[],
  user: UserStatusLine,
  home: string,
  verbose: boolean,
  now: number,
): string[] {
  if (live.length === 0) return [];

  if (!captures.configured) {
    return [
      `  none of the ${plural(live.length, 'live session')} has a capture, and the reason is the`,
      user.bashUnsafe
        ? '  machine rather than any of them: the wrapper is the status line and cannot be run.'
        : '  machine rather than any of them: the wrapper is not installed.',
    ];
  }

  if (missing.length === 0) {
    return [`  every one of the ${plural(live.length, 'live session')} has a capture.`];
  }

  const lines = [
    `  ${missing.length} of the ${plural(live.length, 'live session')} ${
      missing.length === 1 ? 'has' : 'have'
    } no capture:`,
  ];
  for (const session of missing.slice(0, MAX_EXPLAINED_SESSIONS)) {
    const where =
      session.override !== undefined
        ? ` · ${displayPath(session.override.file, home, verbose)}`
        : session.cwd === undefined
          ? ''
          : ` · ${displayPath(session.cwd, home, verbose)}`;
    lines.push(`    pid ${session.pid}${where} — ${captureReason(session, user, now)}`);
  }
  const rest = missing.length - MAX_EXPLAINED_SESSIONS;
  if (rest > 0) lines.push(`    … and ${plural(rest, 'more session')}, not listed`);
  return lines;
}

function quotaSection(
  captures: CaptureScan,
  limits: LimitsScan,
  paths: { readonly capturesDir: string; readonly limitsFile: string },
  home: string,
  verbose: boolean,
  now: number,
  statusLines: {
    readonly overrides: readonly ProjectStatusLine[];
    readonly liveSessions: number;
    readonly checkedSessions: number;
    readonly live: readonly MissingCapture[];
    readonly missing: readonly MissingCapture[];
    readonly user: UserStatusLine;
  },
): string[] {
  const lines: string[] = [];
  const show = (target: string): string => displayPath(target, home, verbose);
  const age = (at: number | undefined): string =>
    at === undefined ? 'of unknown age' : `${describeAge(Math.max(0, now - at))} old`;
  const newest = newestCapture(captures);

  lines.push(
    `  captures       ${show(paths.capturesDir)} — ${
      !captures.configured
        ? // "Not installed" is the wrong half of the answer when the wrapper is
          // the status line and the shell has never been able to start it: the
          // row would contradict the explanation three lines below it.
          statusLines.user.bashUnsafe
          ? 'not there; the wrapper is the status line but the shell cannot run it'
          : 'not there; the status-line wrapper is not installed'
        : `${plural(captures.captures.size, 'capture')}, newest ${age(
            newest === undefined ? undefined : captureAgeSource(newest),
          )}, ${plural(captures.warnings, 'unreadable file')}`
    }`,
  );
  lines.push(
    `  limits.json    ${show(paths.limitsFile)} — ${
      limits.document !== undefined
        ? `read, written ${age(limits.document.updatedAt ?? limits.fileAt)}`
        : limits.configured
          ? `unusable: ${limits.error ?? 'unknown reason'}`
          : 'not there; nazar-tray is not installed'
    }`,
  );

  const quota = selectQuota(limits, captures);
  if (quota === undefined) {
    lines.push('  usage limits are hidden: neither source exists on this machine.');
  } else {
    const windows = quota.providers.reduce((sum, provider) => sum + provider.windows.length, 0);
    lines.push(
      `  usage limits show ${plural(windows, 'window')} from ${
        quota.source === 'limits.json' ? 'nazar-tray' : 'the status-line captures'
      }` +
        quota.providers
          .filter((provider) => provider.windows.length > 0)
          .map(
            (provider) =>
              ` · ${provider.name} ${provider.windows
                .map(
                  (window) =>
                    `${window.key} ${window.percent === undefined ? 'unknown' : `${Math.floor(window.percent)} %`}`,
                )
                .join(' ')}`,
          )
          .join(''),
    );
  }

  if (statusLines.user.bashUnsafe) {
    // The case that reads as "not installed" and is nothing of the kind. Said
    // once for the machine, above the per-session lines, and said whether or not
    // there is a live session to hang it on — a person running doctor with
    // nothing open still needs to know why the directory is empty.
    lines.push(
      `  the user-level "statusLine" *is* the wrapper — ${JSON.stringify(statusLines.user.command)} —`,
      '  but Claude Code runs it through Git Bash on Windows, where an unquoted backslash is',
      '  an escape rather than a separator. The path arrives with its separators eaten, no',
      '  program is spawned, and no capture is ever written, however many sessions run.',
      '  Its own installer rewrites the command; see the diff before anything changes:',
      `    ${WRAPPER_DRY_RUN}`,
    );
  } else if (!captures.configured) {
    lines.push(
      '  cost and context window come from the status-line wrapper, which belongs to',
      '  nazar-tray. Nazar never installs it and never edits Claude Code\'s configuration.',
      '  To see what installing it would change, run its own dry run and read the diff:',
      `    ${WRAPPER_DRY_RUN}`,
    );
  }
  if (captures.configured) {
    // Only worth asking when the wrapper *is* installed. With no wrapper on the
    // machine no project is blocking anything, and the four lines above are the
    // whole answer.
    lines.push(
      ...statusLineSection(
        statusLines.overrides,
        { live: statusLines.liveSessions, checked: statusLines.checkedSessions },
        home,
        verbose,
      ),
    );
  }

  lines.push(
    ...missingCaptureSection(
      statusLines.live,
      captures,
      statusLines.missing,
      statusLines.user,
      home,
      verbose,
      now,
    ),
  );
  return lines;
}

/** The wrapper's own preview command. Printed by doctor, never executed. */
export const WRAPPER_DRY_RUN = 'nazar-statusline install --dry-run';

/** A coarse age: doctor reports how old a reading is, not to the millisecond. */
export function describeAge(ms: number): string {
  if (!Number.isFinite(ms)) return 'an unknown time';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} days`;
}

/**
 * The browser-opener chain, exactly as `nazar` would walk it here.
 *
 * "It printed a URL and no browser appeared" is the one failure a user cannot
 * debug from the outside, because every link of the chain fails silently by
 * design. Printing the chain turns it into something they can paste into a
 * shell themselves, and naming the confirmation gap explains why Nazar prints
 * its hint line even on the runs that worked.
 */
function browserSection(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const chain = browserOpenChain('<url>', platform, env);
  const lines: string[] = [
    '  the canvas URL is printed first, then handed to these in order, stopping',
    '  at the first one that answers:',
  ];
  chain.forEach((attempt, index) => {
    lines.push(`    ${index + 1}. ${collapseHome(describeOpenAttempt(attempt), home)}`);
  });
  const confirms = chain.some((attempt) => attempt.confirms);
  lines.push(
    confirms
      ? `  a non-zero exit means no handler, so the hint line is printed only then: "${OPEN_HINT}"`
      : `  none of them can report whether a browser actually opened on this platform —`,
  );
  if (!confirms) {
    lines.push(
      '  "start" exits 0 whether or not the shell found a handler, rundll32 exits 0',
      '  unconditionally, and explorer.exe exits 1 even when it succeeds. So nazar',
      `  always prints: "${OPEN_HINT}"`,
    );
  }
  lines.push('  "nazar --no-open" skips the whole chain.');
  return lines;
}

/**
 * Why the canvas would draw what it draws. The empty case is the one worth
 * spelling out: "no news" is never rendered as a running session, so a canvas
 * showing nothing is always one of a small number of situations.
 */
function canvasVerdict(
  live: number,
  sessions: { entries: readonly SessionFileEntry[]; missingDirectory: boolean },
  agents: AgentsRunResult,
): string[] {
  if (live > 0) {
    return [`  the canvas would draw ${plural(live, 'session')} right now.`];
  }

  const lines: string[] = ['  the canvas would draw 0 sessions, because:'];
  if (sessions.missingDirectory) {
    lines.push(
      '    the sessions directory does not exist, so Claude Code has never run under this',
      '    configuration directory. Check CLAUDE_CONFIG_DIR if you moved it.',
    );
  } else if (sessions.entries.length === 0) {
    lines.push(
      '    Claude Code writes one file per live session into the sessions directory and there',
      '    is none right now. Start a session in a terminal; the canvas fills within a second.',
    );
  } else {
    lines.push(
      `    ${plural(sessions.entries.length, 'session file')} exist, but no process behind them is alive.`,
      '    These are stale entries from sessions that ended; Nazar holds them at "unknown" for',
      '    one liveness gate and then drops them, rather than drawing them as running.',
    );
  }
  if (!agents.ok) {
    lines.push(
      '    "claude agents --json" also did not answer, so there is no second opinion on liveness.',
    );
  }
  lines.push(
    '    Claude Desktop and VS Code sessions never appear here: they are absent from',
    '    "claude agents --json", and v1 does not support them.',
  );
  return lines;
}

/**
 * Build the report. Nothing is started and nothing is written; the caller
 * prints the lines.
 */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const verbose = options.verbose ?? false;
  const alive = options.isAlive ?? isPidAlive;
  const show = (target: string): string => displayPath(target, home, verbose);

  const configDir = claudeConfigDir(env, home);
  const sessionsDir = sessionsDirPath(env, home);
  const projectsDir = projectsDirPath(env, home);
  const configured = env['CLAUDE_CONFIG_DIR'];
  const fromEnv = typeof configured === 'string' && configured.length > 0;

  const capturesDir = statuslineCapturesDir(env, home);
  const limitsFile = nazarLimitsPath(env, home);

  const runAgents = options.agents ?? createClaudeAgentsRunner();
  const [agents, sessions, store, captures, limits] = await Promise.all([
    runAgents(),
    readSessionsDir(sessionsDir),
    surveyStore(projectsDir),
    readCapturesDir(capturesDir),
    readLimitsFile(limitsFile),
  ]);

  const liveEntries = sessions.entries.filter((entry) => alive(entry.pid));

  /*
   * WP4f, widened in N-WP9. One walk per distinct working directory of a live
   * session, and only when the wrapper is installed — with no captures
   * directory the answer is already "the wrapper is not installed" and a
   * project's settings cannot make that more true. Every read is a `readFile`
   * of one key.
   *
   * The walk goes *up* from each working directory, which the canvas's own
   * probe deliberately does not do: Claude Code merges a directory's settings
   * with its ancestors', so a `statusLine` at the top of a monorepo displaces
   * the wrapper for every session inside it. Doctor is asked once, by a person,
   * about a handful of directories; the probe is asked every two seconds about
   * every card, and that is the whole difference.
   */
  const liveCwds = [
    ...new Set(
      liveEntries
        .map((entry) => entry.cwd)
        .filter((cwd): cwd is string => typeof cwd === 'string' && cwd.length > 0),
    ),
  ];
  const byCwd = new Map<string, ProjectStatusLine[]>();
  if (captures.configured) {
    await Promise.all(
      liveCwds.map(async (cwd) => {
        // `stopAt: home` is load-bearing: `<home>/.claude/settings.json` is the
        // user-level file, not a project's, and it has its own reader and its
        // own sentence below.
        byCwd.set(cwd, await readProjectStatusLinesUpward(cwd, { stopAt: home }));
      }),
    );
  }
  const projectStatusLines = [...byCwd.values()].flat();

  /*
   * N-WP9. The other three reasons a live session can have no capture, which
   * all come from one file. Read whether or not the wrapper is installed: "it
   * is not the user-level status line" is exactly the case where the captures
   * directory exists — left behind by an uninstall, or by something that
   * replaced the wrapper afterwards — and no project is to blame.
   */
  const user = await readUserStatusLine(configDir, options.platform ?? process.platform);

  const live: MissingCapture[] = liveEntries.map((entry) => {
    const override =
      entry.cwd === undefined ? undefined : byCwd.get(entry.cwd)?.find((line) => line.overrides);
    return {
      pid: entry.pid,
      ...(override === undefined ? {} : { override }),
      ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
      ...(entry.startedAt === undefined ? {} : { startedAt: entry.startedAt }),
    };
  });
  // A session with no `sessionId` cannot have a capture found for it: the
  // wrapper keys its files by that id and nothing else. Counting it as missing
  // is the honest direction — it genuinely has no capture on the canvas.
  const missing = live.filter((_session, index) => {
    const id = liveEntries[index]?.sessionId;
    return id === undefined || !captures.captures.has(id);
  });

  const lines: string[] = [];

  lines.push('Claude Code configuration');
  lines.push(
    `  config dir     ${show(configDir)}   (${fromEnv ? 'from CLAUDE_CONFIG_DIR' : 'default; set CLAUDE_CONFIG_DIR to move it'})`,
  );
  lines.push(
    `  sessions dir   ${show(sessionsDir)} — ${
      sessions.missingDirectory
        ? 'missing (normal on a machine where Claude Code has not run)'
        : `${plural(sessions.entries.length, 'session file')}, ${plural(liveEntries.length, 'live process')}, ${plural(sessions.warnings, 'unreadable file')}`
    }`,
  );
  lines.push(
    `  projects dir   ${show(projectsDir)} — ${
      store.missing
        ? 'missing (no transcript store yet)'
        : `${plural(store.projectDirs, 'project directory')}, ${plural(store.transcripts, 'transcript')}, ${plural(store.subagentDirs, 'subagents directory')} across ${plural(store.sessionDirs, 'session directory')}`
    }`,
  );
  if (!store.missing) {
    lines.push(
      `                 walked in ${store.walkMs.toFixed(0)} ms, ${plural(store.warnings, 'warning')}; the listing opens no file`,
    );
  }
  lines.push('');

  lines.push('claude agents --json');
  lines.push(
    agents.ok
      ? `  answered with ${plural(agents.entries.length, 'session')} in ${agents.durationMs.toFixed(0)} ms`
      : agents.error === 'ENOENT'
        ? `  command not found: "claude" is not on PATH (${agents.durationMs.toFixed(0)} ms). Liveness falls back to the session files alone.`
        : `  did not answer: ${agents.error ?? 'unknown error'} (${agents.durationMs.toFixed(0)} ms). Liveness falls back to the session files alone.`,
  );
  lines.push(
    '  it lists top-level terminal sessions only: never subagents, never Desktop or VS Code.',
  );
  if (verbose && agents.ok) {
    for (const entry of agents.entries) {
      lines.push(
        `    pid ${entry.pid} · ${entry.status}${entry.waitingFor === undefined ? '' : ` · waiting for ${entry.waitingFor}`}${entry.kind === undefined ? '' : ` · ${entry.kind}`}`,
      );
    }
  }
  lines.push('');

  lines.push('Usage limits, cost and context (nazar-tray)');
  lines.push(
    ...quotaSection(
      captures,
      limits,
      { capturesDir, limitsFile },
      home,
      verbose,
      Date.now(),
      {
        overrides: projectStatusLines.filter((line) => line.overrides),
        // Sessions, not working directories. Two sessions in one repository
        // used to be counted once, which is how the report came to say "none of
        // the 1 live session" on a machine running two.
        liveSessions: liveEntries.length,
        // Those with a working directory, which is what a project rule can be read for.
        checkedSessions: live.filter((session) => session.cwd !== undefined).length,
        live,
        missing,
        user,
      },
    ),
  );
  lines.push('');

  lines.push('Pinned formats (docs/pinned-internal-formats.md)');
  const checks = await checkFormats(agents, sessions, store, captures, limits);
  const width = Math.max(...checks.map((check) => check.name.length));
  for (const check of checks) {
    lines.push(`  ${check.ok ? 'ok' : '--'}  ${check.name.padEnd(width)}  ${check.detail}`);
  }
  const unchecked = checks.filter((check) => !check.ok).length;
  lines.push(
    `  ${checks.length - unchecked} of ${checks.length} validated against this machine; an unvalidated row is a shape nothing here could exercise, not a failure.`,
  );
  lines.push('');

  lines.push('Canvas');
  lines.push(...canvasVerdict(liveEntries.length, sessions, agents));
  lines.push('');

  lines.push('Browser');
  lines.push(...browserSection(home, options.platform ?? process.platform, env));

  if (!verbose) {
    lines.push('');
    lines.push('  Paths are shown with your home directory collapsed to ~. Add --verbose for the');
    lines.push('  absolute paths and one line per live session.');
  }

  return { lines, liveSessions: liveEntries.length };
}
