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
  CodexScan,
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
  CODEX_ROLLOUT_FILE,
  CODEX_THREAD_LOCKS_DIR,
  DEFAULT_CODEX_DAYS,
  NAZAR_LIMITS_FILE,
  NAZAR_STATUSLINE_DIR,
  WRAPPER_COMMAND,
  captureAgeSource,
  claudeConfigDir,
  codexSessionsDirPath,
  codexThreadLocksDirPath,
  createClaudeAgentsRunner,
  extractTranscriptLine,
  isPidAlive,
  nazarLimitsPath,
  newestCapture,
  projectsDirPath,
  readCapturesDir,
  readCodexStore,
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

import {
  DEFAULT_HERMES_POLL_MS,
  HERMES_HOME_DIR,
  HermesReader,
  discoverHermesSources,
  hermesHomeDir,
  loadSqlite,
} from '@nazar/core';

import { OPEN_HINT, browserOpenChain, describeOpenAttempt } from './open.js';
import { collapseHome } from './redact.js';
import type { RemoteSpawn } from './remote.js';
import { DEFAULT_REMOTE_COMMAND, LineReader, SSH_ARGS, sshSpawn } from './remote.js';

/* ------------------------------------------------------------------ *
 * N-WP17a: Hermes, and the remote hosts
 * ------------------------------------------------------------------ */

/**
 * How long doctor gives one alias before it gives up on it.
 *
 * `ConnectTimeout=10` plus the far end starting Node and reading a database.
 * Twenty-five seconds is long enough that a slow machine answers and short
 * enough that three dead hosts do not turn `nazar doctor` into a minute of
 * nothing. It is a *probe*: the canvas keeps retrying for as long as it runs,
 * and this is one attempt reported honestly.
 */
export const REMOTE_PROBE_MS = 25_000;

/** What one probe of one alias found. */
export interface RemoteProbe {
  readonly alias: string;
  /** `hello` arrived, ssh answered but said nothing we know, or it failed. */
  readonly state: 'ok' | 'no hello' | 'failed';
  readonly version?: string;
  readonly hostname?: string;
  /** `<name> <state> (<detail>)` per source the far end reported. */
  readonly sources: readonly string[];
  /** Sessions in the first snapshot, when one arrived. */
  readonly sessions?: number;
  /** The last line the far end (or ssh) wrote to stderr. */
  readonly error?: string;
  readonly durationMs: number;
}

/**
 * Run one alias once and report what came back.
 *
 * It uses the same spawn and the same parser the canvas uses, so a probe that
 * succeeds is evidence about the thing that will actually run — a doctor that
 * tested a different code path would be testing itself. The child is killed
 * either way: doctor starts nothing that outlives it.
 */
export async function probeRemote(
  alias: string,
  command: string,
  spawn: RemoteSpawn = sshSpawn,
  timeoutMs: number = REMOTE_PROBE_MS,
): Promise<RemoteProbe> {
  const started = Date.now();
  return await new Promise<RemoteProbe>((resolve) => {
    let settled = false;
    let stderr: string | undefined;
    let version: string | undefined;
    let hostname: string | undefined;
    let sources: string[] = [];
    let sessions: number | undefined;
    let sawHello = false;
    const reader = new LineReader();

    let child: ReturnType<RemoteSpawn>;
    const finish = (state: RemoteProbe['state']): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // Already gone. There is nothing a report can do about that.
      }
      resolve({
        alias,
        state,
        ...(version === undefined ? {} : { version }),
        ...(hostname === undefined ? {} : { hostname }),
        sources,
        ...(sessions === undefined ? {} : { sessions }),
        ...(stderr === undefined ? {} : { error: stderr }),
        durationMs: Date.now() - started,
      });
    };

    const timer = setTimeout(() => finish(sawHello ? 'ok' : 'no hello'), timeoutMs);
    timer.unref?.();

    try {
      child = spawn(alias, command);
    } catch (error) {
      clearTimeout(timer);
      resolve({
        alias,
        state: 'failed',
        sources: [],
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      });
      return;
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      for (const line of reader.push(chunk)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          continue;
        }
        if (typeof parsed !== 'object' || parsed === null) continue;
        const message = parsed as Record<string, unknown>;
        if (message['type'] === 'hello') {
          sawHello = true;
          if (typeof message['version'] === 'string') version = message['version'].slice(0, 40);
          if (typeof message['host'] === 'string') hostname = message['host'].slice(0, 80);
          sources = Array.isArray(message['sources'])
            ? (message['sources'] as unknown[]).flatMap((entry) => {
                if (typeof entry !== 'object' || entry === null) return [];
                const source = entry as Record<string, unknown>;
                const name = source['name'];
                if (typeof name !== 'string') return [];
                const detail = source['detail'];
                return [
                  `${name} ${source['state'] === 'unknown' ? '--' : 'ok'}${
                    typeof detail === 'string' ? ` (${detail})` : ''
                  }`,
                ];
              })
            : [];
          continue;
        }
        if (message['type'] === 'state' && sessions === undefined) {
          const state = message['state'];
          if (typeof state === 'object' && state !== null) {
            const list = (state as { sessions?: unknown }).sessions;
            if (Array.isArray(list)) sessions = list.length;
          }
          // A `hello` and one snapshot is the whole of what a probe needs.
          finish('ok');
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const line = String(chunk).trim().split('\n').pop();
      if (line !== undefined && line.length > 0) stderr = line.slice(0, 200);
    });

    child.on('error', (error: Error) => {
      stderr = error.message.slice(0, 200);
      finish('failed');
    });
    child.on('close', () => finish(sawHello ? 'ok' : 'failed'));
  });
}

/** Bytes of a transcript doctor samples to check the pinned line shape. */
export const DOCTOR_SAMPLE_BYTES = 512 * 1024;

/** Session directories doctor is willing to probe for a `subagents/` sample. */
const MAX_SUBAGENT_PROBES = 400;

export interface DoctorOptions {
  /** Print absolute paths and per-source detail. Off by default. */
  readonly verbose?: boolean;
  /**
   * N-WP18: read the Codex rollout store. On by default, and a machine without
   * `~/.codex/sessions` reports "not installed" rather than an error.
   */
  readonly codex?: boolean;
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
  /**
   * N-WP17a: aliases to probe. Empty is the normal case and prints one line
   * saying so — a report that silently omitted a section would be a report a
   * person could not tell "nothing configured" from "nothing checked".
   */
  readonly remotes?: readonly string[];
  /** What each probe runs on the far end. Defaults to the canvas's own. */
  readonly remoteCommand?: string;
  /** Injected by tests so `nazar doctor` never spawns a real ssh. */
  readonly spawn?: RemoteSpawn;
  /** How long one probe may take. Injected by tests. */
  readonly remoteTimeoutMs?: number;
  /**
   * The Hermes reader doctor reports on. `null` runs the report without one,
   * which is what a test that has no `~/.hermes` to point at does.
   */
  readonly hermes?: HermesReader | null;
}

export interface DoctorReport {
  /** The report, one line per entry, without trailing newlines. */
  readonly lines: readonly string[];
  /** Sessions the canvas would draw right now. */
  readonly liveSessions: number;
  /** N-WP18: Codex threads the canvas would draw right now. */
  readonly codexSessions: number;
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
  codex: CodexScan | undefined,
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

  /*
   * N-WP18. Two rows rather than one, because they are two different claims:
   * that a rollout still parses into the fields the reader wants, and that the
   * lock directory is where liveness comes from. A machine with Codex installed
   * but nothing open validates the first and not the second, and the report has
   * to be able to say so — "no lock" is the normal state of a quiet machine,
   * not a broken shape.
   */
  if (codex !== undefined) {
    checks.push({
      name: CODEX_ROLLOUT_FILE,
      ok: codex.configured && codex.rollouts > 0,
      detail: !codex.configured
        ? 'not validated: no rollout store, so Codex is not installed'
        : codex.rollouts === 0
          ? 'not validated: the store exists and holds no rollout in the days scanned'
          : `${plural(codex.rollouts, 'rollout')} listed, ${plural(codex.warnings, 'unreadable file')}, ${plural(codex.sessions, 'open thread')}`,
    });
    checks.push({
      name: CODEX_THREAD_LOCKS_DIR,
      ok: codex.locksConfigured,
      detail: codex.locksConfigured
        ? `${plural(codex.locks, 'lock')} held; a lock is what makes a Codex thread "alive" rather than merely recent`
        : 'not validated: no lock directory, so liveness falls back to the silence window alone',
    });
  }

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
 * N-WP18: what Codex looks like on this machine.
 *
 * Four sentences at most, and each is a fact rather than a status: whether the
 * store exists, how much of it the scanner looked at, how many threads are open
 * right now, and — the one that surprises people — that a Codex card never
 * offers jump-to-terminal, because a rollout carries no process id anywhere.
 *
 * A machine without Codex gets one line saying so. That is not a warning: most
 * machines running Nazar have never installed it.
 */
function codexSection(
  scan: CodexScan | undefined,
  sessions: readonly { readonly status: string; readonly state: string }[],
  paths: { readonly sessionsDir: string; readonly locksDir: string },
  home: string,
  verbose: boolean,
): string[] {
  const show = (target: string): string => displayPath(target, home, verbose);
  if (scan === undefined) {
    return [`  reading is off for this run (--no-codex); no rollout was opened`];
  }
  if (!scan.configured) {
    return [
      `  rollout store   ${show(paths.sessionsDir)} - missing, so Codex is not installed here`,
    ];
  }

  const lines: string[] = [];
  lines.push(
    `  rollout store   ${show(paths.sessionsDir)} - ${plural(scan.rollouts, 'rollout')} in the last ${plural(DEFAULT_CODEX_DAYS, 'day')}, ${plural(scan.warnings, 'unreadable file')}`,
  );
  lines.push(
    `  thread locks    ${show(paths.locksDir)} - ${
      scan.locksConfigured
        ? `${plural(scan.locks, 'lock')} held right now`
        : 'missing; liveness falls back to the silence window alone'
    }`,
  );
  const alive = sessions.filter((session) => session.state === 'alive').length;
  lines.push(
    `  on the canvas   ${plural(scan.sessions, 'Codex thread')}, ${alive} with a writer still holding the lock`,
  );
  if (verbose) {
    for (const session of sessions) {
      lines.push(`    ${session.status} - process ${session.state}`);
    }
  }
  lines.push(
    '  a rollout names no process, so a Codex card shows no pid and offers no jump to a terminal.',
  );
  lines.push(
    '  Codex records the approval policy and never a request, so a thread is never shown as waiting.',
  );
  return lines;
}

/**
 * N-WP17a. What Hermes there is on this machine, and whether Node can read it.
 *
 * Two questions, and they fail in opposite directions, so they get separate
 * sentences. `node:sqlite` missing is a fact about the *runtime* — an old Node,
 * or a build with it compiled out — and no amount of Hermes on the disk will
 * change it. No `state.db` is a fact about the *machine*, and it is the normal
 * answer for everybody who does not run Hermes; it is not a failure and is not
 * printed as one.
 *
 * The reader is started, read once and stopped. Nothing here outlives the
 * report, and every read is the read-only connection the canvas would make.
 */
async function hermesSection(
  options: DoctorOptions,
  home: string,
  verbose: boolean,
  show: (target: string) => string,
): Promise<string[]> {
  const lines: string[] = [];
  const homeDir = hermesHomeDir(options.env ?? process.env, home);
  lines.push(`  home           ${show(homeDir)}   (${HERMES_HOME_DIR}; HERMES_HOME overrides it)`);

  const sqlite = await loadSqlite();
  lines.push(
    sqlite === undefined
      ? `  node:sqlite    not available on ${process.version} — Hermes needs Node 22.5 or newer. Nothing else about Nazar is affected.`
      : `  node:sqlite    available on ${process.version}; connections are opened file:<path>?mode=ro and readOnly`,
  );

  const refs = await discoverHermesSources(homeDir);
  if (refs.length === 0) {
    lines.push('  profiles       none found (normal on a machine that does not run Hermes)');
    return lines;
  }
  lines.push(
    `  profiles       ${plural(refs.length, 'state.db')}: ${refs.map((ref) => ref.profile).join(', ')}`,
  );
  if (sqlite === undefined) return lines;

  const reader =
    options.hermes === null
      ? undefined
      : (options.hermes ??
        new HermesReader({ homeDir, pollIntervalMs: DEFAULT_HERMES_POLL_MS, taskText: false }));
  if (reader === undefined) return lines;
  const scan = await reader.scan();
  reader.stop();
  for (const source of scan.sources) {
    lines.push(
      `  ${source.state === 'ok' ? 'ok' : '--'}  ${source.profile.padEnd(12)} ${
        source.state === 'ok'
          ? `${plural(source.sessions, 'session')}, ${source.running} holding a live turn lease`
          : (source.error ?? 'unreadable')
      }`,
    );
    if (verbose) lines.push(`      ${show(source.file)}`);
  }
  lines.push(
    `  ${plural(scan.sessions.length, 'card')} would be drawn: open sessions, plus what ended in the last ten minutes.`,
  );
  lines.push(
    '  waiting is never shown for Hermes: it is held in the gateway\'s memory and written to no file.',
  );
  return lines;
}

/**
 * N-WP17a. One line per alias, and the alias is only ever a name.
 *
 * With none configured this is one sentence rather than a missing section: a
 * report that printed nothing here would leave a person unable to tell "no
 * remote hosts" from "the remote check did not run".
 */
async function remoteSection(options: DoctorOptions): Promise<string[]> {
  const aliases = options.remotes ?? [];
  const command = options.remoteCommand ?? DEFAULT_REMOTE_COMMAND;
  if (aliases.length === 0) {
    return [
      '  none configured. "nazar --remote <alias>" reads another machine over your own ssh:',
      `  ssh ${SSH_ARGS.join(' ')} <alias> -- ${command}`,
      '  No port is opened, no token is stored and nothing is installed there. See docs/REMOTE.md.',
    ];
  }

  const lines: string[] = [`  command        ${command}`];
  const probes = await Promise.all(
    aliases.map((alias) =>
      probeRemote(alias, command, options.spawn ?? sshSpawn, options.remoteTimeoutMs),
    ),
  );
  for (const probe of probes) {
    const head = `  ${probe.state === 'ok' ? 'ok' : '--'}  ${probe.alias.padEnd(16)}`;
    if (probe.state === 'ok') {
      lines.push(
        `${head} nazar ${probe.version ?? 'unknown'} on ${probe.hostname ?? 'unknown'} in ${probe.durationMs.toFixed(0)} ms` +
          (probe.sessions === undefined ? '' : `, ${plural(probe.sessions, 'session')}`),
      );
      for (const source of probe.sources) lines.push(`        ${source}`);
      continue;
    }
    lines.push(
      `${head} ${probe.state === 'no hello' ? 'ssh connected but no hello arrived' : 'no answer'} after ${probe.durationMs.toFixed(0)} ms`,
    );
    if (probe.error !== undefined) lines.push(`        ${probe.error}`);
    lines.push(
      `        check "ssh ${probe.alias}" works without a password, and that the far end has "${command.split(' ')[0] ?? 'nazar'}" on its PATH`,
    );
  }
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
  const readCodex = options.codex !== false;
  const alive = options.isAlive ?? isPidAlive;
  const show = (target: string): string => displayPath(target, home, verbose);

  const configDir = claudeConfigDir(env, home);
  const sessionsDir = sessionsDirPath(env, home);
  const projectsDir = projectsDirPath(env, home);
  const configured = env['CLAUDE_CONFIG_DIR'];
  const fromEnv = typeof configured === 'string' && configured.length > 0;

  const capturesDir = statuslineCapturesDir(env, home);
  const limitsFile = nazarLimitsPath(env, home);

  // N-WP18. Codex's own two directories, resolved the same way: `CODEX_HOME`
  // when it is set, `<home>/.codex` otherwise.
  const codexSessionsDir = codexSessionsDirPath(env, home);
  const codexLocksDir = codexThreadLocksDirPath(env, home);

  const runAgents = options.agents ?? createClaudeAgentsRunner();
  const [agents, sessions, store, captures, limits, codex] = await Promise.all([
    runAgents(),
    readSessionsDir(sessionsDir),
    surveyStore(projectsDir),
    readCapturesDir(capturesDir),
    readLimitsFile(limitsFile),
    // One pass and nothing started: the reader is constructed, refreshed once
    // and thrown away, so `doctor` still starts no watcher and no timer.
    readCodex
      ? readCodexStore({ sessionsDir: codexSessionsDir, locksDir: codexLocksDir })
      : Promise.resolve(undefined),
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

  lines.push('Codex (N-WP18)');
  lines.push(
    ...codexSection(
      codex?.scan,
      codex?.sessions ?? [],
      { sessionsDir: codexSessionsDir, locksDir: codexLocksDir },
      home,
      verbose,
    ),
  );
  lines.push('');

  /* ---- N-WP17a: Hermes ------------------------------------------- */

  lines.push('Hermes sessions (read-only)');
  lines.push(...(await hermesSection(options, home, verbose, show)));
  lines.push('');

  /* ---- N-WP17a: the remote hosts ---------------------------------- */

  lines.push('Remote hosts (ssh)');
  lines.push(...(await remoteSection(options)));
  lines.push('');

  lines.push('Pinned formats (docs/pinned-internal-formats.md)');
  const checks = await checkFormats(agents, sessions, store, captures, limits, codex?.scan);
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

  return {
    lines,
    liveSessions: liveEntries.length,
    codexSessions: codex?.scan.sessions ?? 0,
  };
}
