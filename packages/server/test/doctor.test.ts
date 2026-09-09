/**
 * `nazar doctor` has two jobs and both are tested here: it must explain an
 * empty canvas, and it must not leak a path under the user's home while doing
 * it. Every case runs against a synthetic configuration directory with an
 * injected `claude agents --json` runner and an injected liveness probe, so no
 * real session, no real transcript and no real `claude` binary is involved.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { cp, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import type { AgentsRunResult, UserStatusLine } from '@nazar/core';

import {
  captureReason,
  describeAge,
  displayPath,
  plural,
  pluralise,
  runDoctor,
  WRAPPER_DRY_RUN,
} from '../src/doctor.ts';
import { OPEN_HINT } from '../src/open.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', '..', '..', 'fixtures');

/** A configuration directory built from the repo's sanitized fixtures. */
async function makeConfigDir(
  options: {
    sessions?: boolean;
    store?: boolean;
    limits?: boolean;
    captures?: boolean;
    /** N-WP18: a Codex rollout store, with or without a lock held. */
    codex?: boolean;
    codexLock?: boolean;
  } = {},
): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nazar-doctor-'));

  if (options.sessions === true) {
    const sessionsDir = path.join(dir, '.claude', 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    for (const name of ['1001.json', '1002.json']) {
      await cp(path.join(fixtures, 'sessions', name), path.join(sessionsDir, name));
    }
    // The credential file the reader must never open, present as it is on a
    // real machine.
    await writeFile(path.join(sessionsDir, '1001.deadbeef.key'), 'not-a-session', 'utf8');
  }

  if (options.store === true) {
    const slug = 'C--proj-example';
    const session = '00000000-0000-4000-8000-000000000005';
    const projectDir = path.join(dir, '.claude', 'projects', slug);
    const subagents = path.join(projectDir, session, 'subagents');
    await mkdir(subagents, { recursive: true });
    await cp(path.join(fixtures, 'transcript-slice.jsonl'), path.join(projectDir, `${session}.jsonl`));
    for (const name of [
      'agent-a0000000000000006.meta.json',
      'agent-a0000000000000006.jsonl',
      'agent-a0000000000000007.meta.json',
    ]) {
      await cp(path.join(fixtures, 'subagents', name), path.join(subagents, name));
    }
  }

  // WP3'/WP5. `~/.nazar` belongs to nazar-tray; the fixtures are its own
  // sample and three real captures with their paths replaced.
  if (options.limits === true) {
    await mkdir(path.join(dir, '.nazar'), { recursive: true });
    await cp(path.join(fixtures, 'limits.sample.json'), path.join(dir, '.nazar', 'limits.json'));
  }
  if (options.captures === true) {
    const capturesDir = path.join(dir, '.nazar', 'statusline');
    await mkdir(capturesDir, { recursive: true });
    for (const name of [
      '00000000-0000-4000-8000-000000000001.json',
      '00000000-0000-4000-8000-000000000002.json',
      'chain.json',
    ]) {
      await cp(path.join(fixtures, 'statusline-captures', name), path.join(capturesDir, name));
    }
  }

  // N-WP18. `~/.codex` belongs to a different vendor's tool; the fixtures are
  // three synthetic rollouts that still carry every field the reader must skip.
  if (options.codex === true) {
    const dayDir = path.join(dir, '.codex', 'sessions', '2026', '09', '09');
    await mkdir(dayDir, { recursive: true });
    const rollout = path.join(
      dayDir,
      'rollout-2026-09-09T04-00-00-00000000-0000-7000-8000-000000000001.jsonl',
    );
    await cp(path.join(fixtures, 'codex', 'rollout-open.jsonl'), rollout);
    // `cp` carries the fixture's own mtime across on this platform, and the
    // silence window is measured against it — so a fixture committed last week
    // would make every unlocked thread look finished. Stamp it deliberately:
    // "this rollout is being written to right now" is the state under test.
    const now = new Date();
    await utimes(rollout, now, now);
    const locksDir = path.join(dir, '.codex', 'thread-writer-locks');
    await mkdir(locksDir, { recursive: true });
    if (options.codexLock === true) {
      await writeFile(
        path.join(locksDir, '00000000-0000-7000-8000-000000000001.lock'),
        '',
        'utf8',
      );
    }
  }

  return { dir, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 5 }) };
}

function agentsAnswering(entries: number): () => Promise<AgentsRunResult> {
  return async () => ({
    ok: true,
    durationMs: 12,
    entries: Array.from({ length: entries }, (_unused, index) => ({
      pid: 1001 + index,
      status: 'idle' as const,
      kind: 'interactive',
    })),
  });
}

const agentsMissing = async (): Promise<AgentsRunResult> => ({
  ok: false,
  durationMs: 3,
  entries: [],
  error: 'ENOENT',
});

test('doctor explains an empty canvas when Claude Code has never run', async () => {
  const { dir, cleanup } = await makeConfigDir();
  try {
    const report = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude') },
      home: dir,
      agents: agentsMissing,
      isAlive: () => false,
    });
    const text = report.lines.join('\n');

    assert.equal(report.liveSessions, 0);
    assert.match(text, /the canvas would draw 0 sessions, because:/);
    assert.match(text, /the sessions directory does not exist/);
    assert.match(text, /command not found/);
    assert.match(text, /from CLAUDE_CONFIG_DIR/);
    // The unsupported surfaces are named every time the answer is zero.
    assert.match(text, /Claude Desktop and VS Code sessions never appear here/);
  } finally {
    await cleanup();
  }
});

test('doctor separates "no session running" from "stale session files"', async () => {
  const { dir, cleanup } = await makeConfigDir({ sessions: true });
  try {
    const dead = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude') },
      home: dir,
      agents: agentsAnswering(0),
      isAlive: () => false,
    });
    assert.equal(dead.liveSessions, 0);
    assert.match(dead.lines.join('\n'), /no process behind them is alive/);

    const alive = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude') },
      home: dir,
      agents: agentsAnswering(2),
      isAlive: () => true,
    });
    assert.equal(alive.liveSessions, 2);
    assert.match(alive.lines.join('\n'), /the canvas would draw 2 sessions right now\./);
  } finally {
    await cleanup();
  }
});

test('doctor counts the store and validates the formats it can reach', async () => {
  const { dir, cleanup } = await makeConfigDir({ sessions: true, store: true });
  try {
    const report = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude') },
      home: dir,
      agents: agentsAnswering(2),
      isAlive: () => true,
    });
    const text = report.lines.join('\n');

    assert.match(text, /1 project directory, 1 transcript, 1 subagents directory/);
    assert.match(text, /2 files parsed, 0 unreadable files, status seen: busy, idle/);
    // Both transcript shapes and the meta files come back validated.
    assert.match(text, /ok {2}~\/\.claude\/projects\/<slug>\/<session>\.jsonl/);
    assert.match(text, /ok {2}~\/\.claude\/projects\/<slug>\/<session>\/subagents\/agent-\*\.meta\.json/);
    assert.match(text, /ok {2}~\/\.claude\/projects\/<slug>\/<session>\/subagents\/agent-\*\.jsonl/);
    // …and the two optional sources say which of them is missing rather than
    // pretending to have been checked. Neither is in this temporary home.
    assert.match(text, /~\/\.nazar\/statusline {2,}not validated: no capture directory/);
    assert.match(text, /~\/\.nazar\/limits\.json {2,}not validated: no limits file/);
    // A workflow directory exists on no machine yet, this one included.
    assert.match(text, /workflows\/<runId> {2,}not validated/);
  } finally {
    await cleanup();
  }
});

test('doctor prints no path under the home directory without --verbose', async () => {
  const { dir, cleanup } = await makeConfigDir({ sessions: true, store: true });
  try {
    const quiet = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude') },
      home: dir,
      agents: agentsAnswering(1),
      isAlive: () => true,
    });
    assert.equal(
      quiet.lines.join('\n').includes(dir),
      false,
      'the configuration directory was printed in full',
    );
    assert.match(quiet.lines.join('\n'), /~[\\/]\.claude/);

    const loud = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude') },
      home: dir,
      agents: agentsAnswering(1),
      isAlive: () => true,
      verbose: true,
    });
    assert.ok(loud.lines.join('\n').includes(dir), '--verbose must print the absolute path');
  } finally {
    await cleanup();
  }
});

test('a configuration directory outside the home is described, not printed', () => {
  const home = process.platform === 'win32' ? 'C:\\Users\\somebody' : '/home/somebody';
  const inside = path.join(home, '.claude');
  const outside = process.platform === 'win32' ? 'D:\\claude-config' : '/opt/claude-config';

  assert.match(displayPath(inside, home, false), /^~[\\/]\.claude$/);
  assert.equal(displayPath(inside, home, true), inside);
  assert.match(displayPath(outside, home, false), /^<outside your home directory;/);
  assert.equal(displayPath(outside, home, true), outside);
});

test('doctor prints the browser-opener chain it would walk', async () => {
  const { dir, cleanup } = await makeConfigDir();
  try {
    const windows = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), ComSpec: 'C:\WINDOWS\system32\cmd.exe' },
      home: dir,
      agents: agentsMissing,
      isAlive: () => false,
      platform: 'win32',
    });
    const text = windows.lines.join('\n');

    assert.match(text, /^Browser$/m);
    // The order is the contract, and doctor is where a user reads it.
    const chain = text.slice(text.indexOf('\nBrowser\n'));
    const cmd = chain.indexOf('cmd.exe /c start "" <url>');
    const rundll = chain.indexOf('rundll32 url.dll,FileProtocolHandler <url>');
    const explorer = chain.indexOf('explorer.exe <url>');
    assert.ok(cmd > -1 && rundll > cmd && explorer > rundll, `chain out of order:\n${chain}`);
    assert.match(text, new RegExp(OPEN_HINT));
    assert.match(text, /none of them can report whether a browser actually opened/);
    assert.match(text, /--no-open/);

    const linux = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude') },
      home: dir,
      agents: agentsMissing,
      isAlive: () => false,
      platform: 'linux',
    });
    const linuxText = linux.lines.join('\n');
    assert.match(linuxText, /xdg-open <url>/);
    // xdg-open does fail loudly, so the hint is conditional there.
    assert.match(linuxText, /the hint line is printed only then/);
  } finally {
    await cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * WP3'/WP5: the two optional sources
 * ------------------------------------------------------------------ */

test('doctor says the strip is hidden and how to get it, when neither source exists', async () => {
  const { dir, cleanup } = await makeConfigDir({ sessions: true });
  try {
    const report = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude') },
      home: dir,
      agents: agentsAnswering(2),
      isAlive: () => true,
    });
    const text = report.lines.join('\n');

    assert.match(text, /Usage limits, cost and context \(nazar-tray\)/);
    assert.match(text, /the status-line wrapper is not installed/);
    assert.match(text, /nazar-tray is not installed/);
    assert.match(text, /usage limits are hidden: neither source exists/);
    // The hint is the wrapper's own dry run, printed and never executed.
    assert.ok(text.includes(WRAPPER_DRY_RUN));
    assert.match(text, /--dry-run/);
  } finally {
    await cleanup();
  }
});

test('doctor reports the numbers nazar-tray wrote, when limits.json is there', async () => {
  const { dir, cleanup } = await makeConfigDir({ sessions: true, limits: true });
  try {
    const report = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude') },
      home: dir,
      agents: agentsAnswering(1),
      isAlive: () => true,
    });
    const text = report.lines.join('\n');

    assert.match(text, /limits\.json .* read, written/);
    assert.match(text, /usage limits show 5 windows from nazar-tray/);
    assert.match(text, /seven_day_fable 23 %/);
    // Captures are still missing, so the install hint is still printed.
    assert.ok(text.includes(WRAPPER_DRY_RUN));
  } finally {
    await cleanup();
  }
});

test('doctor counts the captures and says what the newest one carries', async () => {
  const { dir, cleanup } = await makeConfigDir({ sessions: true, captures: true });
  try {
    const report = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude') },
      home: dir,
      agents: agentsAnswering(1),
      isAlive: () => true,
    });
    const text = report.lines.join('\n');

    assert.match(text, /2 captures/, 'chain.json is not a capture');
    assert.match(text, /cost, context window, effort, rate limits/);
    assert.match(text, /usage limits show 2 windows from the status-line captures/);
    // With a capture directory present there is nothing left to install.
    assert.equal(text.includes(WRAPPER_DRY_RUN), false);
  } finally {
    await cleanup();
  }
});

test('doctor never prints a path under the home directory without --verbose', async () => {
  const { dir, cleanup } = await makeConfigDir({ sessions: true, limits: true, captures: true });
  try {
    const quiet = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude') },
      home: dir,
      agents: agentsAnswering(1),
      isAlive: () => true,
    });
    assert.equal(quiet.lines.join('\n').includes(dir), false, 'a home path escaped');

    const loud = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude') },
      home: dir,
      agents: agentsAnswering(1),
      isAlive: () => true,
      verbose: true,
    });
    assert.ok(loud.lines.join('\n').includes(dir), '--verbose is what prints them');
  } finally {
    await cleanup();
  }
});

test('a malformed limits.json is reported as unusable, not as missing', async () => {
  const { dir, cleanup } = await makeConfigDir({ sessions: true });
  try {
    await mkdir(path.join(dir, '.nazar'), { recursive: true });
    await writeFile(path.join(dir, '.nazar', 'limits.json'), '{ half written', 'utf8');
    const report = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude') },
      home: dir,
      agents: agentsAnswering(1),
      isAlive: () => true,
    });
    assert.match(report.lines.join('\n'), /unusable: not valid JSON/);
  } finally {
    await cleanup();
  }
});

test('describeAge is coarse on purpose: doctor reports an age, not a stopwatch', () => {
  assert.equal(describeAge(3_000), '3 s');
  assert.equal(describeAge(90_000), '1 min');
  assert.equal(describeAge(3 * 3_600_000), '3 h');
  assert.equal(describeAge(5 * 86_400_000), '5 days');
});

/* ------------------------------------------------------------------ *
 * WP4f: the project statusLine that swallows the wrapper
 *
 * "Cost and context are missing on *some* cards" is the one report from live
 * use that nothing in the canvas could explain, and the answer was three
 * directories away in a project's own settings. Doctor is where that answer
 * belongs, so these check that it finds the file, prints the key, says how to
 * fix it — and that it stays quiet in every case where there is nothing to say.
 * ------------------------------------------------------------------ */

/**
 * A configuration directory with one live session running in a project of the
 * test's own making. The project lives *inside* the fake home, so the report's
 * home-collapsing is exercised rather than side-stepped.
 *
 * N-WP9 gave it the rest of the machine a capture's absence can be blamed on:
 * a user-level settings file and its modification time, a second session in the
 * same project, a working directory below the one that carries the settings,
 * and the session's own start time and id.
 */
async function makeProjectConfig(
  settings: Readonly<Record<string, unknown>> | undefined,
  options: {
    captures?: boolean;
    local?: Readonly<Record<string, unknown>>;
    /** Written to `<home>/.claude/settings.json`: the user level. */
    user?: Readonly<Record<string, unknown>>;
    /** Modification time for that file, which dates the install. */
    userMtime?: number;
    /** A second live session in the same project, for the counting case. */
    second?: boolean;
    /** Put the session's cwd three directories below the settings file. */
    deep?: boolean;
    startedAt?: number;
    sessionId?: string;
  } = {},
): Promise<{ dir: string; project: string; cleanup: () => Promise<void> }> {
  const made = await makeConfigDir({ captures: options.captures ?? true });
  const project = path.join(made.dir, 'proj', 'overridden');
  await mkdir(project, { recursive: true });
  if (settings !== undefined || options.local !== undefined) {
    await mkdir(path.join(project, '.claude'), { recursive: true });
  }
  if (settings !== undefined) {
    await writeFile(
      path.join(project, '.claude', 'settings.json'),
      JSON.stringify(settings, null, 2),
      'utf8',
    );
  }
  if (options.local !== undefined) {
    await writeFile(
      path.join(project, '.claude', 'settings.local.json'),
      JSON.stringify(options.local, null, 2),
      'utf8',
    );
  }

  if (options.user !== undefined) {
    await mkdir(path.join(made.dir, '.claude'), { recursive: true });
    const userFile = path.join(made.dir, '.claude', 'settings.json');
    await writeFile(userFile, JSON.stringify(options.user, null, 2), 'utf8');
    if (options.userMtime !== undefined) {
      const when = new Date(options.userMtime);
      await utimes(userFile, when, when);
    }
  }

  const cwd = options.deep ? path.join(project, 'packages', 'server', 'src') : project;
  if (options.deep) await mkdir(cwd, { recursive: true });

  const sessionsDir = path.join(made.dir, '.claude', 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  const session = (pid: number, sessionId: string): string =>
    JSON.stringify({
      pid,
      sessionId,
      cwd,
      kind: 'interactive',
      name: `session-${pid}`,
      status: 'busy',
      startedAt: options.startedAt ?? 1_788_697_701_170,
      updatedAt: 1_788_751_348_625,
      statusUpdatedAt: 1_788_751_348_625,
      version: '2.1.263',
    });

  await writeFile(
    path.join(sessionsDir, '1010.json'),
    session(1010, options.sessionId ?? '00000000-0000-4000-8000-000000000010'),
    'utf8',
  );
  if (options.second === true) {
    await writeFile(
      path.join(sessionsDir, '1011.json'),
      session(1011, '00000000-0000-4000-8000-000000000011'),
      'utf8',
    );
  }

  return { dir: made.dir, project, cleanup: made.cleanup };
}

test('doctor names the project settings file that replaces the status line', async () => {
  const { dir, cleanup } = await makeProjectConfig({
    statusLine: { type: 'command', command: 'powershell -File ./scripts/status.ps1' },
    permissions: { allow: ['Bash(git status)'] },
  });
  try {
    const report = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), NAZAR_HOME: path.join(dir, '.nazar') },
      home: dir,
      agents: agentsAnswering(1),
      isAlive: () => true,
    });
    const text = report.lines.join('\n');

    assert.match(text, /project statusLine — 1 project settings file replace the/);
    assert.match(text, /~[/\\]proj[/\\]overridden[/\\]\.claude[/\\]settings\.json/);
    assert.match(text, /"statusLine"\.command = "powershell -File \.\/scripts\/status\.ps1"/);
    // Both fixes, in the order they should be tried.
    assert.match(text, /point that "statusLine\.command" at nazar-statusline as well/);
    assert.match(text, /remove the "statusLine" key from the project/);
    // Nothing else in that settings file reached the report.
    assert.ok(!text.includes('git status'), 'only statusLine.command is read');
    assert.ok(!text.includes('permissions'), 'only statusLine.command is read');
  } finally {
    await cleanup();
  }
});

test('doctor prints the absolute path only under --verbose', async () => {
  const { dir, project, cleanup } = await makeProjectConfig({
    statusLine: { command: 'my-prompt' },
  });
  try {
    const env = {
      CLAUDE_CONFIG_DIR: path.join(dir, '.claude'),
      NAZAR_HOME: path.join(dir, '.nazar'),
    };
    const quiet = await runDoctor({ env, home: dir, agents: agentsAnswering(1), isAlive: () => true });
    assert.ok(!quiet.lines.join('\n').includes(project), 'the home directory stays collapsed');

    const loud = await runDoctor({
      env,
      home: dir,
      verbose: true,
      agents: agentsAnswering(1),
      isAlive: () => true,
    });
    assert.ok(loud.lines.join('\n').includes(path.join(project, '.claude', 'settings.json')));
  } finally {
    await cleanup();
  }
});

test('doctor says so when no live project overrides the status line', async () => {
  const { dir, cleanup } = await makeProjectConfig(undefined);
  try {
    const report = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), NAZAR_HOME: path.join(dir, '.nazar') },
      home: dir,
      agents: agentsAnswering(1),
      isAlive: () => true,
    });
    const text = report.lines.join('\n');
    assert.match(text, /none of the \d+ live sessions? runs in a project that/);
    assert.match(text, /nothing there is blocking a capture/);
  } finally {
    await cleanup();
  }
});

test('a project pointing its own status line at the wrapper is not reported', async () => {
  const { dir, cleanup } = await makeProjectConfig({
    statusLine: { type: 'command', command: 'nazar-statusline' },
  });
  try {
    const report = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), NAZAR_HOME: path.join(dir, '.nazar') },
      home: dir,
      agents: agentsAnswering(1),
      isAlive: () => true,
    });
    assert.match(report.lines.join('\n'), /nothing there is blocking a capture/);
  } finally {
    await cleanup();
  }
});

test('settings.local.json is reported too, and separately', async () => {
  const { dir, cleanup } = await makeProjectConfig(
    { statusLine: { command: 'nazar-statusline' } },
    { local: { statusLine: { command: 'starship prompt' } } },
  );
  try {
    const report = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), NAZAR_HOME: path.join(dir, '.nazar') },
      home: dir,
      agents: agentsAnswering(1),
      isAlive: () => true,
    });
    const text = report.lines.join('\n');
    assert.match(text, /1 project settings file replace the/, 'only the local one overrides');
    assert.match(text, /settings\.local\.json — "statusLine"\.command = "starship prompt"/);
  } finally {
    await cleanup();
  }
});

test('with no wrapper installed doctor does not blame a project', async () => {
  // The section is only reached when the captures directory exists. Without it
  // the answer is already "the wrapper is not installed", and a project's
  // settings cannot make that more true.
  const { dir, cleanup } = await makeProjectConfig(
    { statusLine: { command: 'my-prompt' } },
    { captures: false },
  );
  try {
    const report = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), NAZAR_HOME: path.join(dir, '.nazar') },
      home: dir,
      agents: agentsAnswering(1),
      isAlive: () => true,
    });
    const text = report.lines.join('\n');
    assert.ok(!text.includes('project statusLine'));
    assert.match(text, /the status-line wrapper is not installed/);
    assert.ok(text.includes(WRAPPER_DRY_RUN));
  } finally {
    await cleanup();
  }
});

test('doctor with no live session says nothing about projects at all', async () => {
  const { dir, cleanup } = await makeProjectConfig({ statusLine: { command: 'my-prompt' } });
  try {
    const report = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), NAZAR_HOME: path.join(dir, '.nazar') },
      home: dir,
      agents: agentsAnswering(0),
      isAlive: () => false,
    });
    assert.ok(!report.lines.join('\n').includes('project statusLine'), 'nothing to explain');
  } finally {
    await cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * N-WP9: the plural helper, on its own
 *
 * It was a one-liner that added `s`, and every call site that needed
 * `entries` or `directories` worked around it by passing the plural by hand —
 * which is exactly how a broken helper survives a code review. The table is
 * here so the next caller does not have to.
 * ------------------------------------------------------------------ */

test('plural counts and pluralises, and 0 takes the plural', () => {
  const table: [number, string, string][] = [
    [0, 'file', '0 files'],
    [1, 'file', '1 file'],
    [2, 'file', '2 files'],
    [0, 'entry', '0 entries'],
    [1, 'entry', '1 entry'],
    [2, 'entry', '2 entries'],
  ];
  for (const [count, one, want] of table) {
    assert.equal(plural(count, one), want, `plural(${count}, ${one})`);
  }
});

test('pluralise handles the endings the report actually uses', () => {
  const table: [string, string][] = [
    // The plain rule.
    ['file', 'files'],
    ['transcript', 'transcripts'],
    ['slug', 'slugs'],
    ['capture', 'captures'],
    ['window', 'windows'],
    // Consonant + y, which the first version got wrong as "entrys".
    ['entry', 'entries'],
    ['directory', 'directories'],
    ['project directory', 'project directories'],
    ['subagents directory', 'subagents directories'],
    // Vowel + y, which must not become "daies".
    ['day', 'days'],
    ['key', 'keys'],
    // Sibilants, which the first version got wrong as "processs".
    ['process', 'processes'],
    ['live process', 'live processes'],
    ['box', 'boxes'],
    ['batch', 'batches'],
    ['dash', 'dashes'],
    // The phrase rule: only the last word is inflected.
    ['session file', 'session files'],
    ['project settings file', 'project settings files'],
  ];
  for (const [one, want] of table) {
    assert.equal(pluralise(one), want, `pluralise(${one})`);
  }
});

test('an explicit plural still wins, for the words no rule covers', () => {
  assert.equal(plural(2, 'child', 'children'), '2 children');
  assert.equal(plural(1, 'child', 'children'), '1 child');
});

/* ------------------------------------------------------------------ *
 * N-WP9: relating the live sessions to the captures
 *
 * The report printed "3 live processes" in one section and "1 capture" in
 * another and never subtracted one from the other. These check that it does
 * now, and that the reason each session is given is the most specific one
 * available rather than the first one that fits.
 * ------------------------------------------------------------------ */

const NOW = Date.UTC(2026, 8, 8, 12, 0, 0);
const MINUTE = 60_000;

/** The four reasons, as `captureReason` is asked for them. */
const wrapperInstalled: UserStatusLine = {
  file: '/home/x/.claude/settings.json',
  exists: true,
  command: 'nazar-statusline',
  isWrapper: true,
  bashUnsafe: false,
  installedAt: NOW - 60 * MINUTE,
  installedAtSource: 'backup',
};

test('a project override is the reason, because it explains this session and no other', () => {
  const reason = captureReason(
    {
      pid: 1,
      startedAt: NOW - MINUTE,
      override: { file: '/proj/app/.claude/settings.json', command: 'starship prompt', overrides: true },
    },
    wrapperInstalled,
    NOW,
  );
  assert.match(reason, /this project sets its own "statusLine"/);
  assert.match(reason, /starship prompt/);
});

test('a machine with no user settings file is told so rather than blamed on a turn', () => {
  const reason = captureReason(
    { pid: 2, startedAt: NOW - MINUTE },
    { file: '/home/x/.claude/settings.json', exists: false, isWrapper: false, bashUnsafe: false },
    NOW,
  );
  assert.match(reason, /no user settings file/);
});

test('a user-level status line that is not the wrapper is named', () => {
  const reason = captureReason(
    { pid: 3, startedAt: NOW - MINUTE },
    {
      file: '/home/x/.claude/settings.json',
      exists: true,
      command: 'starship prompt',
      isWrapper: false,
      bashUnsafe: false,
      installedAt: NOW - MINUTE,
      installedAtSource: 'settings',
    },
    NOW,
  );
  assert.match(reason, /the user-level "statusLine" is "starship prompt", not nazar-statusline/);
});

test('a user settings file with no status line at all says that instead', () => {
  const reason = captureReason(
    { pid: 4 },
    { file: '/home/x/.claude/settings.json', exists: true, isWrapper: false, bashUnsafe: false },
    NOW,
  );
  assert.match(reason, /no "statusLine" is configured at the user level/);
});

test('a session older than the install is told to restart, with the age', () => {
  const reason = captureReason({ pid: 5, startedAt: NOW - 120 * MINUTE }, wrapperInstalled, NOW);
  assert.match(reason, /started 1 h before the status line was installed/);
  assert.match(reason, /restart it/);
  assert.ok(!reason.includes('dated by the settings file'), 'a backup needs no hedge');
});

test('an install dated by the settings file alone says how weak that date is', () => {
  const reason = captureReason(
    { pid: 6, startedAt: NOW - 120 * MINUTE },
    { ...wrapperInstalled, installedAtSource: 'settings' },
    NOW,
  );
  assert.match(reason, /dated by the settings file, which any other edit also moves/);
});

test('with nothing else to say, the reason is the turn that has not happened', () => {
  const reason = captureReason({ pid: 7, startedAt: NOW - 30_000 }, wrapperInstalled, NOW);
  assert.match(reason, /no status-line tick yet/);
  assert.match(reason, /30 s old/);
});

test('doctor counts sessions rather than working directories', async () => {
  // Two sessions in one project. The line used to read "none of the 1 live
  // session" on exactly this machine, because it counted the directory.
  const { dir, cleanup } = await makeProjectConfig(undefined, { second: true });
  try {
    const report = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), NAZAR_HOME: path.join(dir, '.nazar') },
      home: dir,
      agents: agentsAnswering(2),
      isAlive: () => true,
    });
    const text = report.lines.join('\n');
    assert.equal(report.liveSessions, 2);
    assert.match(text, /none of the 2 live sessions runs in a project that/);
  } finally {
    await cleanup();
  }
});

test('doctor names every live session that has no capture, and says why', async () => {
  const { dir, cleanup } = await makeProjectConfig({
    statusLine: { type: 'command', command: 'starship prompt' },
  });
  try {
    const report = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), NAZAR_HOME: path.join(dir, '.nazar') },
      home: dir,
      agents: agentsAnswering(1),
      isAlive: () => true,
    });
    const text = report.lines.join('\n');
    assert.match(text, /1 of the 1 live session has no capture:/);
    assert.match(text, /pid 1010 .* this project sets its own "statusLine"/);
    assert.match(text, /starship prompt/);
  } finally {
    await cleanup();
  }
});

test('doctor says the wrapper is not the user-level status line when it is not', async () => {
  // The captures directory exists — left behind by an uninstall — so nothing
  // about the machine looks broken from the canvas, and no project is at fault.
  const { dir, cleanup } = await makeProjectConfig(undefined, { user: { statusLine: { command: 'starship prompt' } } });
  try {
    const report = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), NAZAR_HOME: path.join(dir, '.nazar') },
      home: dir,
      agents: agentsAnswering(1),
      isAlive: () => true,
    });
    const text = report.lines.join('\n');
    assert.match(text, /pid 1010 .* the user-level "statusLine" is "starship prompt", not nazar-statusline/);
    assert.ok(!text.includes('no status-line tick yet'), 'the specific reason wins');
  } finally {
    await cleanup();
  }
});

test('a session older than the install is told to restart it', async () => {
  const { dir, cleanup } = await makeProjectConfig(undefined, {
    user: { statusLine: { command: 'nazar-statusline' } },
    userMtime: Date.now(),
    startedAt: Date.now() - 3 * 3_600_000,
  });
  try {
    const report = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), NAZAR_HOME: path.join(dir, '.nazar') },
      home: dir,
      agents: agentsAnswering(1),
      isAlive: () => true,
    });
    const text = report.lines.join('\n');
    assert.match(text, /before the status line was installed/);
    assert.match(text, /restart it/);
  } finally {
    await cleanup();
  }
});

test('a session with a capture is not listed, and the heading says so', async () => {
  // The capture fixture is keyed by the session id, so a session file carrying
  // that id is a session the wrapper has written for.
  const { dir, cleanup } = await makeProjectConfig(undefined, {
    user: { statusLine: { command: 'nazar-statusline' } },
    sessionId: '00000000-0000-4000-8000-000000000001',
  });
  try {
    const report = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), NAZAR_HOME: path.join(dir, '.nazar') },
      home: dir,
      agents: agentsAnswering(1),
      isAlive: () => true,
    });
    const text = report.lines.join('\n');
    assert.match(text, /every one of the 1 live session has a capture\./);
    assert.ok(!text.includes('has no capture'), 'nothing is missing');
  } finally {
    await cleanup();
  }
});

test('with no wrapper at all the answer is the machine, said once', async () => {
  const { dir, cleanup } = await makeProjectConfig(undefined, { captures: false });
  try {
    const report = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), NAZAR_HOME: path.join(dir, '.nazar') },
      home: dir,
      agents: agentsAnswering(1),
      isAlive: () => true,
    });
    const text = report.lines.join('\n');
    assert.match(text, /none of the 1 live session has a capture, and the reason is the/);
    assert.ok(!text.includes('pid 1010'), 'one line, not one per session');
  } finally {
    await cleanup();
  }
});

test('a status line at the top of a repository explains a session three directories down', async () => {
  // The canvas probe reads one directory; doctor walks up, because Claude Code
  // merges a directory's settings with its ancestors'.
  const { dir, cleanup } = await makeProjectConfig(
    { statusLine: { command: 'starship prompt' } },
    { deep: true },
  );
  try {
    const report = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), NAZAR_HOME: path.join(dir, '.nazar') },
      home: dir,
      agents: agentsAnswering(1),
      isAlive: () => true,
    });
    const text = report.lines.join('\n');
    assert.match(text, /1 project settings file replace the/);
    assert.match(text, /pid 1010 .* this project sets its own "statusLine"/);
  } finally {
    await cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * T-WP8: the fifth reason, and the one the fourth was hiding
 *
 * The wrapper installed itself as an unquoted Windows path, Claude Code ran
 * that through Git Bash, every backslash was read as an escape, and nothing
 * was ever spawned. The report called it "no status-line tick yet", which is
 * what a session sitting at a prompt looks like — so the maintainer waited.
 * ------------------------------------------------------------------ */

/** A Windows path as it reaches the shell: unquoted, backslashes and all. */
const UNRUNNABLE_PATH = String.raw`C:\tools\nazar\nazar-statusline.exe`;

const unrunnableWrapper: UserStatusLine = {
  file: '/home/x/.claude/settings.json',
  exists: true,
  command: UNRUNNABLE_PATH,
  isWrapper: true,
  bashUnsafe: true,
  installedAt: NOW - 60 * MINUTE,
  installedAtSource: 'backup',
};

test('a command Git Bash cannot start is the reason, not a turn that has not happened', () => {
  const reason = captureReason({ pid: 8, startedAt: NOW - 30_000 }, unrunnableWrapper, NOW);
  assert.match(reason, /Git Bash/);
  assert.match(reason, /never spawned/);
  // Quoted the way every other command in this report is quoted, so the
  // backslashes a person reads are the ones in their settings file.
  assert.ok(reason.includes(JSON.stringify(UNRUNNABLE_PATH)), reason);
  assert.ok(reason.includes(WRAPPER_DRY_RUN), reason);
  assert.ok(!reason.includes('no status-line tick yet'), 'the root cause wins');
});

test('it also outranks the install date, because restarting the session fixes nothing', () => {
  const reason = captureReason({ pid: 9, startedAt: NOW - 120 * MINUTE }, unrunnableWrapper, NOW);
  assert.match(reason, /Git Bash/);
  assert.ok(!reason.includes('restart it'), 'a restart would change nothing at all');
});

test('a project override still wins, because it explains this session and no other', () => {
  const reason = captureReason(
    {
      pid: 10,
      startedAt: NOW - MINUTE,
      override: { file: '/proj/app/.claude/settings.json', command: 'starship prompt', overrides: true },
    },
    unrunnableWrapper,
    NOW,
  );
  assert.match(reason, /this project sets its own "statusLine"/);
});

test('doctor names the shell rather than calling an installed wrapper uninstalled', async () => {
  // The live shape: the wrapper *is* the user-level status line, it has never
  // run once, so `~/.nazar/statusline` was never created either.
  const { dir, cleanup } = await makeProjectConfig(undefined, {
    captures: false,
    user: { statusLine: { type: 'command', command: UNRUNNABLE_PATH } },
  });
  try {
    const report = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), NAZAR_HOME: path.join(dir, '.nazar') },
      home: dir,
      agents: agentsAnswering(1),
      isAlive: () => true,
      platform: 'win32',
    });
    const text = report.lines.join('\n');
    assert.match(text, /\*is\* the wrapper/);
    assert.match(text, /Git Bash on Windows/);
    assert.ok(text.includes(JSON.stringify(UNRUNNABLE_PATH)), text);
    assert.ok(text.includes(WRAPPER_DRY_RUN), text);
    // The row above the explanation must not contradict it.
    assert.match(text, /captures .* the shell cannot run it/);
    assert.ok(
      !text.includes('the status-line wrapper, which belongs to'),
      'it is installed; the "not installed" advice would send a person the wrong way',
    );
    assert.match(text, /the wrapper is the status line and cannot be run/);
    assert.ok(!text.includes('no status-line tick yet'));
  } finally {
    await cleanup();
  }
});

test('the same settings file on another platform is a command line somebody meant', async () => {
  const { dir, cleanup } = await makeProjectConfig(undefined, {
    captures: false,
    user: { statusLine: { type: 'command', command: UNRUNNABLE_PATH } },
  });
  try {
    const report = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), NAZAR_HOME: path.join(dir, '.nazar') },
      home: dir,
      agents: agentsAnswering(1),
      isAlive: () => true,
      platform: 'linux',
    });
    const text = report.lines.join('\n');
    assert.ok(!text.includes('Git Bash'));
    assert.match(text, /the wrapper is not installed/);
  } finally {
    await cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * N-WP18: Codex
 * ------------------------------------------------------------------ */

test('doctor says Codex is not installed rather than saying nothing', async () => {
  const { dir, cleanup } = await makeConfigDir();
  try {
    const report = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude') },
      home: dir,
      agents: agentsMissing,
      isAlive: () => false,
      hermes: null,
    });
    const text = report.lines.join('\n');
    assert.equal(report.codexSessions, 0);
    assert.match(text, /Codex \(N-WP18\)/);
    assert.match(text, /missing, so Codex is not installed here/);
    // Not a warning, and not a row in the pinned-format checks that reads as a
    // failure: most machines running Nazar have never installed Codex.
    assert.match(text, /not validated: no rollout store/);
  } finally {
    await cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * N-WP17a: the two sections this package added
 * ------------------------------------------------------------------ */

/** A child-process double, so no ssh is ever spawned by a test. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();

  readonly stderr = new PassThrough();

  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

test('with no remote host configured, doctor says so and prints the command', async () => {
  const { dir, cleanup } = await makeConfigDir();
  try {
    const report = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude') },
      home: dir,
      agents: agentsMissing,
      isAlive: () => false,
      hermes: null,
    });
    const text = report.lines.join('\n');
    assert.match(text, /Remote hosts \(ssh\)/);
    // "none configured" rather than a missing section: a report has to let a
    // person tell nothing-configured from the check not having run.
    assert.match(text, /none configured/);
    assert.match(text, /nazar --agent --hermes/);
    assert.match(text, /No port is opened, no token is stored/);
  } finally {
    await cleanup();
  }
});

test('doctor counts the Codex threads the canvas would draw', async () => {
  const { dir, cleanup } = await makeConfigDir({ codex: true, codexLock: true });
  try {
    const report = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude') },
      home: dir,
      agents: agentsMissing,
      isAlive: () => false,
      hermes: null,
    });
    const text = report.lines.join('\n');
    assert.equal(report.codexSessions, 1);
    assert.match(text, /1 rollout in the last 7 days/);
    assert.match(text, /1 lock held right now/);
    assert.match(text, /1 Codex thread, 1 with a writer still holding the lock/);
    // The two sentences that exist because they surprise people.
    assert.match(text, /shows no pid and offers no jump/);
    assert.match(text, /never shown as waiting/);
  } finally {
    await cleanup();
  }
});

test('a remote that answers is reported with its build, machine and sources', async () => {
  const { dir, cleanup } = await makeConfigDir();
  const child = new FakeChild();
  try {
    const pending = runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude') },
      home: dir,
      agents: agentsMissing,
      isAlive: () => false,
      hermes: null,
      remotes: ['box'],
      spawn: () => child as never,
      remoteTimeoutMs: 3000,
    });
    child.stdout.write(
      `${JSON.stringify({
        type: 'hello',
        version: '0.1.0',
        host: 'buildbox',
        sources: [{ name: 'hermes:default', state: 'ok', detail: '4 sessions, 1 running' }],
        capabilities: { claude: true, hermes: true, taskText: false, jump: false },
      })}\n`,
    );
    child.stdout.write(
      `${JSON.stringify({
        type: 'state',
        state: { generatedAt: 1, sessions: [], commandAvailable: true, warnings: 0 },
      })}\n`,
    );

    const text = (await pending).lines.join('\n');
    assert.match(text, /ok {2}box {14}nazar 0\.1\.0 on buildbox/);
    assert.match(text, /hermes:default ok \(4 sessions, 1 running\)/);
    // Doctor starts nothing that outlives it.
    assert.equal(child.killed, true);
  } finally {
    await cleanup();
  }
});

test('a Codex store with no lock still draws a thread that is being written to', async () => {
  const { dir, cleanup } = await makeConfigDir({ codex: true });
  try {
    const report = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude') },
      home: dir,
      agents: agentsMissing,
      isAlive: () => false,
      hermes: null,
    });
    const text = report.lines.join('\n');
    // The fixture's own mtime is *now*, so the thread is inside the silence
    // window and keeps its card for one window — as `unknown`, never `alive`.
    assert.equal(report.codexSessions, 1);
    assert.match(text, /0 locks held right now/);
    assert.match(text, /1 Codex thread, 0 with a writer still holding the lock/);
  } finally {
    await cleanup();
  }
});

test("a remote that fails is reported with ssh's own sentence and what to check", async () => {
  const { dir, cleanup } = await makeConfigDir();
  const child = new FakeChild();
  try {
    const pending = runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude') },
      home: dir,
      agents: agentsMissing,
      isAlive: () => false,
      hermes: null,
      remotes: ['box'],
      spawn: () => child as never,
      remoteTimeoutMs: 3000,
    });
    child.stderr.write('box: Permission denied (publickey).\n');
    // Let the stderr chunk land before the close that ends the probe.
    await new Promise((resolve) => setTimeout(resolve, 20));
    child.emit('close', 255, null);

    const text = (await pending).lines.join('\n');
    assert.match(text, /-- {2}box/);
    assert.match(text, /Permission denied \(publickey\)/);
    assert.match(text, /works without a password/);
  } finally {
    await cleanup();
  }
});

test('--no-codex means doctor opens no rollout at all', async () => {
  const { dir, cleanup } = await makeConfigDir({ codex: true, codexLock: true });
  try {
    const report = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude') },
      home: dir,
      agents: agentsMissing,
      isAlive: () => false,
      codex: false,
      hermes: null,
    });
    const text = report.lines.join('\n');
    assert.equal(report.codexSessions, 0);
    assert.match(text, /reading is off for this run/);
    // And the two pinned-format rows are gone with it: a row that says "not
    // validated" would claim the store was looked at and found wanting.
    assert.equal(/rollout in the last/.test(text), false);
  } finally {
    await cleanup();
  }
});

test('the Hermes section reports the runtime and the machine separately', async () => {
  const { dir, cleanup } = await makeConfigDir();
  try {
    // A home with no Hermes in it: the normal answer for most machines, and it
    // is not printed as a failure.
    const report = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), HERMES_HOME: path.join(dir, '.hermes') },
      home: dir,
      agents: agentsMissing,
      isAlive: () => false,
    });
    const text = report.lines.join('\n');
    assert.match(text, /Hermes sessions \(read-only\)/);
    assert.match(text, /HERMES_HOME overrides it/);
    assert.match(text, /profiles {7}none found \(normal on a machine that does not run Hermes\)/);
    // The runtime question is answered whether or not there is a database.
    assert.match(text, /node:sqlite {4}(available|not available)/);
  } finally {
    await cleanup();
  }
});

test('doctor still prints no path under the home without --verbose', async () => {
  const { dir, cleanup } = await makeConfigDir();
  try {
    const report = await runDoctor({
      env: { CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), HERMES_HOME: path.join(dir, '.hermes') },
      home: dir,
      agents: agentsMissing,
      isAlive: () => false,
    });
    // The Hermes home is under the injected home, so it must be collapsed like
    // every other path in the report.
    assert.ok(!report.lines.join('\n').includes(dir), 'a home path leaked into the report');
  } finally {
    await cleanup();
  }
});
