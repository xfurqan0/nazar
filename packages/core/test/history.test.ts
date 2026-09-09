/**
 * The history scanner, over a temporary transcript store built from the
 * shipped fixtures. The real `~/.claude/projects` is never listed, opened or
 * written to here.
 *
 * Two properties get most of the weight, because both are easy to lose and
 * neither shows up as a failure until someone with a 90-day history opens the
 * panel:
 *
 * - **Listing opens nothing.** The read counters are asserted, not the timing:
 *   a slow listing is a symptom, a listing that parsed a transcript is the
 *   disease.
 * - **The cache is bounded and keyed on the file.** Past the limit the coldest
 *   entry goes, and a file whose mtime moved is re-parsed rather than served
 *   stale.
 */
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { HistoryScanner } from '../src/history.ts';
import { projectSlugFor } from '../src/project-slug.ts';
import { SessionTreeWatcher } from '../src/session-tree.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', '..', '..', 'fixtures');

const SESSIONS = [
  '00000000-0000-4000-8000-000000000005',
  '00000000-0000-4000-8000-000000000006',
  '00000000-0000-4000-8000-000000000007',
] as const;

/** A day before the tests run: these sessions are history, not live. */
const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000);

/** N-WP20: the home the scanner collapses to `~`. The same one every suite here uses. */
const HOME = 'C:\\Users\\nobody';

/**
 * Three sessions across two projects. The first has a `subagents/` directory
 * with three meta files and one agent transcript; the other two are bare.
 */
async function store(): Promise<{ root: string; projects: [string, string] }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nazar-history-'));
  const alpha = path.join(root, 'C--proj-alpha');
  const beta = path.join(root, 'C--proj-beta');
  await mkdir(alpha, { recursive: true });
  await mkdir(beta, { recursive: true });

  await copyFile(
    path.join(fixtures, 'subagents', 'parent-slice.jsonl'),
    path.join(alpha, `${SESSIONS[0]}.jsonl`),
  );
  await copyFile(
    path.join(fixtures, 'transcript-slice.jsonl'),
    path.join(alpha, `${SESSIONS[1]}.jsonl`),
  );
  await copyFile(
    path.join(fixtures, 'transcript-slice.jsonl'),
    path.join(beta, `${SESSIONS[2]}.jsonl`),
  );

  const subagents = path.join(alpha, SESSIONS[0], 'subagents');
  await mkdir(subagents, { recursive: true });
  for (const id of ['a0000000000000005', 'a0000000000000006', 'a0000000000000007']) {
    await copyFile(
      path.join(fixtures, 'subagents', `agent-${id}.meta.json`),
      path.join(subagents, `agent-${id}.meta.json`),
    );
  }
  await copyFile(
    path.join(fixtures, 'subagents', 'agent-a0000000000000006.jsonl'),
    path.join(subagents, 'agent-a0000000000000006.jsonl'),
  );

  // Distinct, old mtimes: the listing must sort by last write, and none of
  // these is a session that is still running.
  await utimes(path.join(alpha, `${SESSIONS[0]}.jsonl`), YESTERDAY, YESTERDAY);
  await utimes(
    path.join(alpha, `${SESSIONS[1]}.jsonl`),
    new Date(YESTERDAY.getTime() - 3_600_000),
    new Date(YESTERDAY.getTime() - 3_600_000),
  );
  await utimes(
    path.join(beta, `${SESSIONS[2]}.jsonl`),
    new Date(YESTERDAY.getTime() - 7_200_000),
    new Date(YESTERDAY.getTime() - 7_200_000),
  );

  return { root, projects: [alpha, beta] };
}

function scanner(root: string, options: { cacheLimit?: number } = {}): HistoryScanner {
  return new HistoryScanner({
    projectsDir: root,
    home: 'C:\\Users\\nobody',
    indexTtlMs: 0,
    ...(options.cacheLimit === undefined ? {} : { cacheLimit: options.cacheLimit }),
  });
}

test('a listing finds every session, newest write first, and opens no transcript', async (t) => {
  const { root } = await store();
  t.after(async () => rm(root, { recursive: true, force: true }));

  const scan = scanner(root);
  const page = await scan.list();

  assert.equal(page.total, 3);
  assert.deepEqual(
    page.sessions.map((session) => session.sessionId),
    [SESSIONS[0], SESSIONS[1], SESSIONS[2]],
  );
  assert.deepEqual(page.projects, ['C--proj-alpha', 'C--proj-beta']);

  // The whole point of the lazy contract.
  assert.equal(scan.stats.fileReads, 0, 'a listing must not open a transcript');
  assert.equal(scan.stats.parses, 0);
  assert.ok(scan.stats.stats >= 3, 'it does stat each transcript');

  const first = page.sessions[0];
  assert.ok(first !== undefined);
  assert.equal(first.agentCount, 3, 'counted from the directory listing alone');
  assert.equal(first.hydrated, false);
  assert.equal(first.model, undefined, 'a model can only come from inside the file');
  assert.equal(first.tokens, undefined, 'and so can a token count');
  assert.ok(first.transcriptBytes > 0);
  assert.equal(page.sessions[1]?.agentCount, undefined, 'no subagents directory, no count');
});

test('opening one session parses that session and nothing else', async (t) => {
  const { root } = await store();
  t.after(async () => rm(root, { recursive: true, force: true }));

  const scan = scanner(root);
  await scan.list();
  const history = await scan.open(SESSIONS[0]);

  assert.ok(history !== undefined);
  assert.equal(history.agentCount, 3);
  assert.equal(scan.stats.parses, 1);
  assert.equal(
    scan.stats.fileReads,
    2,
    'the session transcript plus the one agent transcript that exists',
  );

  // The frozen tree: every agent done, and every one of them saying why.
  assert.deepEqual(
    [...new Set(history.agents.map((agent) => agent.state))],
    ['done'],
    'a finished session has no running agent',
  );
  for (const agent of history.agents) {
    assert.ok(agent.doneSignal !== undefined, `${agent.id} is done for no stated reason`);
  }

  assert.deepEqual(history.tokens, { in: 663, out: 17371, cacheRead: 1100486, cacheWrite: 21031 });
  assert.deepEqual(history.treeTokens, {
    in: 675,
    out: 18471,
    cacheRead: 1325013,
    cacheWrite: 42622,
  });
  assert.equal(history.model, 'claude-fable-5-1');
  assert.ok((history.durationMs ?? 0) > 0);
  assert.ok(history.firstWriteAt !== undefined && history.lastWriteAt !== undefined);
  assert.ok(history.firstWriteAt < history.lastWriteAt);
  assert.equal(history.cwd, undefined, 'history never learns a working directory');
});

test('a second open of an unchanged session is served from the cache', async (t) => {
  const { root } = await store();
  t.after(async () => rm(root, { recursive: true, force: true }));

  const scan = scanner(root);
  const first = await scan.open(SESSIONS[0]);
  const reads = scan.stats.fileReads;

  const second = await scan.open(SESSIONS[0]);
  assert.equal(scan.stats.fileReads, reads, 'nothing was opened the second time');
  assert.equal(scan.stats.cacheHits, 1);
  assert.equal(second, first, 'the same object, not a re-parse');

  // And the listing now knows what the parse learned.
  const page = await scan.list();
  const row = page.sessions.find((one) => one.sessionId === SESSIONS[0]);
  assert.equal(row?.hydrated, true);
  assert.equal(row?.model, 'claude-fable-5-1');
  assert.deepEqual(row?.tokens, first?.tokens);
});

test('a transcript that grew since the parse is read again, not served stale', async (t) => {
  const { root, projects } = await store();
  t.after(async () => rm(root, { recursive: true, force: true }));

  const scan = scanner(root);
  const before = await scan.open(SESSIONS[1]);
  assert.ok(before !== undefined);

  const file = path.join(projects[0], `${SESSIONS[1]}.jsonl`);
  const line = `${JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-07T12:00:00.000Z',
    requestId: 'req_000000000000000000009999',
    message: {
      id: 'msg_000000000000000000009999',
      model: 'claude-opus-5',
      role: 'assistant',
      usage: { output_tokens: 4242 },
    },
  })}\n`;
  const { appendFile } = await import('node:fs/promises');
  await appendFile(file, line, 'utf8');

  const after = await scan.open(SESSIONS[1]);
  assert.equal(scan.stats.parses, 2, 'the changed file was parsed again');
  assert.equal((after?.tokens?.out ?? 0) - (before.tokens?.out ?? 0), 4242);
});

test('the cache drops its least recently used session past the limit', async (t) => {
  const { root } = await store();
  t.after(async () => rm(root, { recursive: true, force: true }));

  const scan = scanner(root, { cacheLimit: 2 });
  await scan.open(SESSIONS[0]);
  await scan.open(SESSIONS[1]);
  assert.equal(scan.stats.cacheSize, 2);
  assert.equal(scan.stats.evictions, 0);

  // Touch the first again so the *second* becomes the coldest.
  await scan.open(SESSIONS[0]);
  assert.equal(scan.stats.cacheHits, 1);

  await scan.open(SESSIONS[2]);
  assert.equal(scan.stats.cacheSize, 2);
  assert.equal(scan.stats.evictions, 1);

  const parsesBefore = scan.stats.parses;
  await scan.open(SESSIONS[0]);
  assert.equal(scan.stats.parses, parsesBefore, 'the recently used session survived');

  await scan.open(SESSIONS[1]);
  assert.equal(scan.stats.parses, parsesBefore + 1, 'the evicted one had to be read again');
});

test('a session id nobody has is undefined rather than an error', async (t) => {
  const { root } = await store();
  t.after(async () => rm(root, { recursive: true, force: true }));

  const scan = scanner(root);
  assert.equal(await scan.open('00000000-0000-4000-8000-00000000dead'), undefined);
  assert.equal(await scan.open('../../../etc/passwd'), undefined);
});

test('a transcript store that does not exist is an empty listing, not a throw', async () => {
  const scan = new HistoryScanner({
    projectsDir: path.join(os.tmpdir(), 'nazar-history-absent-directory'),
    home: 'C:\\Users\\nobody',
  });
  const page = await scan.list();
  assert.equal(page.total, 0);
  assert.deepEqual(page.sessions, []);
  assert.equal(page.warnings, 0, 'a fresh machine has no project store, which is not a warning');
});

test('pagination walks the whole listing exactly once', async (t) => {
  const { root } = await store();
  t.after(async () => rm(root, { recursive: true, force: true }));

  const scan = scanner(root);
  const first = await scan.list({ limit: 2 });
  assert.equal(first.sessions.length, 2);
  assert.equal(first.nextOffset, 2);

  const second = await scan.list({ limit: 2, offset: 2 });
  assert.equal(second.sessions.length, 1);
  assert.equal(second.nextOffset, undefined);
  assert.equal(second.sessions[0]?.sessionId, SESSIONS[2]);

  const filtered = await scan.list({ project: 'C--proj-beta' });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.sessions[0]?.sessionId, SESSIONS[2]);
});

test('the home directory is collapsed to ~, so a project label carries no account name', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nazar-history-home-'));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const home = 'C:\\Users\\somebody';
  const slug = `${projectSlugFor(home, 'win32')}-code-thing`;
  await mkdir(path.join(root, slug), { recursive: true });
  await writeFile(path.join(root, slug, `${SESSIONS[0]}.jsonl`), '', 'utf8');

  const scan = new HistoryScanner({ projectsDir: root, home, indexTtlMs: 0 });
  const page = await scan.list();
  assert.equal(page.sessions[0]?.project, '~/code-thing');
  assert.ok(!(page.sessions[0]?.project ?? '').includes('somebody'));
});

/**
 * The regression WP4b's brief asks for by name: a session that closed
 * *yesterday* must open with exactly the numbers WP2's live watcher counted
 * for the same files.
 *
 * It is the reason the history path reuses `TranscriptTailer`,
 * `extractTranscriptLine`, `TranscriptStats` and `buildAgentTree` rather than
 * growing a reader of its own. Two parsers would drift, and the first symptom
 * would be a history panel quietly disagreeing with the canvas about what a
 * run cost — which is worse than having no panel.
 */
test('a session closed yesterday opens with the same totals the live path counted', async (t) => {
  const { root, projects } = await store();
  t.after(async () => rm(root, { recursive: true, force: true }));

  // WP2's live path, over the same directory. Watching off: this is a
  // measurement, not a race.
  const watcher = new SessionTreeWatcher({
    sessionId: SESSIONS[0],
    projectDir: projects[0],
    watch: false,
    pollIntervalMs: 60_000,
  });
  t.after(() => watcher.stop());
  await watcher.start();
  const live = watcher.snapshot();

  const frozen = await scanner(root).open(SESSIONS[0]);
  assert.ok(frozen !== undefined);

  assert.deepEqual(frozen.tokens, live.tokens, 'session totals disagree between the two paths');
  assert.deepEqual(frozen.treeTokens, live.treeTokens, 'tree totals disagree');
  assert.equal(frozen.model, live.model);
  assert.equal(frozen.effort, live.effort);
  assert.equal(frozen.toolCalls, live.toolCalls);
  assert.equal(frozen.dedupeFallbacks, live.dedupeFallbacks);
  assert.equal(frozen.agentCount, live.agents.length);

  // Per agent, too: the whole tree, not just the top-line number.
  const liveById = new Map(live.agents.map((agent) => [agent.id, agent]));
  for (const agent of frozen.agents) {
    const same = liveById.get(agent.id);
    assert.ok(same !== undefined, `${agent.id} is missing from the live tree`);
    assert.deepEqual(agent.tokens, same.tokens, `${agent.id} token totals disagree`);
    assert.equal(agent.toolCalls, same.toolCalls, `${agent.id} tool calls disagree`);
    assert.equal(agent.spawnDepth, same.spawnDepth);
    assert.equal(agent.modelId, same.modelId);
  }

  // The one thing that must differ: yesterday's agents are finished.
  assert.deepEqual([...new Set(frozen.agents.map((agent) => agent.state))], ['done']);
});

test('the same file read in slices equals the same file read whole', async (t) => {
  // The history reader drains a transcript in 4 MB slices so a 76 MB subagent
  // file does not become a 76 MB buffer. A slice boundary lands mid-line, and
  // mid-UTF-8-sequence, so this is where that is proved on the shipped
  // fixtures rather than only on the maintainer's machine.
  const { root, projects } = await store();
  t.after(async () => rm(root, { recursive: true, force: true }));

  const { TranscriptTailer } = await import('../src/transcript-tailer.ts');
  const file = path.join(projects[0], `${SESSIONS[0]}.jsonl`);

  const whole = await new TranscriptTailer(file).read();
  const sliced: string[] = [];
  const tailer = new TranscriptTailer(file, { maxBytesPerRead: 512 });
  for (;;) {
    const result = await tailer.read();
    sliced.push(...result.lines);
    if (result.bytesRead === 0) break;
  }
  assert.deepEqual(sliced, [...whole.lines]);
});

test('a listing is reused inside its TTL and rebuilt after it', async (t) => {
  const { root } = await store();
  t.after(async () => rm(root, { recursive: true, force: true }));

  let clock = 1_000_000;
  const scan = new HistoryScanner({
    projectsDir: root,
    home: 'C:\\Users\\nobody',
    indexTtlMs: 2000,
    now: () => clock,
  });

  await scan.list();
  await scan.list();
  assert.equal(scan.stats.walks, 1, 'a second listing inside the TTL reuses the walk');

  clock += 3000;
  await scan.list();
  assert.equal(scan.stats.walks, 2);
});

/* ------------------------------------------------------------------ *
 * N-WP20: the totals a session's subagents own
 * ------------------------------------------------------------------ */

/** One assistant line worth exactly `out` output tokens. */
function usageLine(id: string, out: number): string {
  return `${JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-01T00:00:00Z',
    requestId: `req-${id}`,
    message: { id, model: 'test-model', usage: { input_tokens: 1, output_tokens: out } },
  })}\n`;
}

/** A store with one session whose subagent transcript the test can grow. */
async function treeStore(): Promise<{ root: string; agentFile: string; sessionId: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nazar-history-tree-'));
  const project = path.join(root, 'C--proj-tree');
  const sessionId = SESSIONS[0];
  const subagents = path.join(project, sessionId, 'subagents');
  await mkdir(subagents, { recursive: true });

  await writeFile(path.join(project, `${sessionId}.jsonl`), usageLine('parent', 1), 'utf8');
  await writeFile(
    path.join(subagents, 'agent-child.meta.json'),
    JSON.stringify({ agentType: 'general-purpose', model: 'opus', spawnDepth: 1 }),
    'utf8',
  );
  const agentFile = path.join(subagents, 'agent-child.jsonl');
  await writeFile(agentFile, usageLine('child-1', 10), 'utf8');
  return { root, agentFile, sessionId };
}

test('N-WP20: a subagent gaining a line invalidates the cached tree total', async (t) => {
  /*
   * The headline number on a history row is `treeTokens` — the session *plus*
   * every subagent under it. The parse cache was keyed on the parent
   * transcript's path, size and mtime alone, so a tree whose subagents grew
   * went on answering with the total from before they did. Appending one line
   * worth 20 output tokens to a child moves the true total from 11 to 31; the
   * scanner kept saying 11, while a fresh scanner over the same directory said
   * 31 — one question, two answers, which is the whole of the bug.
   */
  const { appendFile } = await import('node:fs/promises');
  const { root, agentFile, sessionId } = await treeStore();
  t.after(async () => rm(root, { recursive: true, force: true }));

  const scan = new HistoryScanner({ projectsDir: root, home: HOME, indexTtlMs: 0 });

  const before = await scan.open(sessionId);
  assert.equal(before?.treeTokens?.out, 11, '1 from the session, 10 from its subagent');
  const parsesBefore = scan.stats.parses;

  await appendFile(agentFile, usageLine('child-2', 20), 'utf8');

  const after = await scan.open(sessionId);
  assert.equal(after?.treeTokens?.out, 31, 'the appended subagent line is counted');
  assert.equal(scan.stats.parses, parsesBefore + 1, 'the tree really was read again');

  // And this scanner now agrees with a brand new one, which is the property
  // that failed: two readers of one directory must not disagree.
  const fresh = new HistoryScanner({ projectsDir: root, home: HOME, indexTtlMs: 0 });
  assert.equal((await fresh.open(sessionId))?.treeTokens?.out, 31);
});

test('N-WP20: an unchanged tree is still answered from the cache', async (t) => {
  // The laziness contract has to survive the fix: a key that moved when nothing
  // did would re-read every subagent on every open.
  const { root, sessionId } = await treeStore();
  t.after(async () => rm(root, { recursive: true, force: true }));

  const scan = new HistoryScanner({ projectsDir: root, home: HOME, indexTtlMs: 0 });
  await scan.open(sessionId);
  const parses = scan.stats.parses;
  const reads = scan.stats.fileReads;

  await scan.open(sessionId);
  await scan.open(sessionId);

  assert.equal(scan.stats.parses, parses, 'nothing was parsed twice');
  assert.equal(scan.stats.fileReads, reads, 'and no file was opened again');
  assert.equal(scan.stats.cacheHits, 2);
});

test('N-WP20: a new subagent appearing also invalidates the total', async (t) => {
  // Not only a longer file: a *second* child is the other way a tree grows,
  // and it moves the file count rather than the byte count.
  const { root, agentFile, sessionId } = await treeStore();
  t.after(async () => rm(root, { recursive: true, force: true }));

  const scan = new HistoryScanner({ projectsDir: root, home: HOME, indexTtlMs: 0 });
  assert.equal((await scan.open(sessionId))?.treeTokens?.out, 11);

  const subagents = path.dirname(agentFile);
  await writeFile(
    path.join(subagents, 'agent-second.meta.json'),
    JSON.stringify({ agentType: 'general-purpose', model: 'opus', spawnDepth: 1 }),
    'utf8',
  );
  await writeFile(path.join(subagents, 'agent-second.jsonl'), usageLine('second-1', 5), 'utf8');

  const after = await scan.open(sessionId);
  assert.equal(after?.treeTokens?.out, 16, 'the new subagent is in the total');
  assert.equal(after?.agentCount, 2);
});

/* ------------------------------------------------------------------ *
 * N-WP20: every id, unpaged
 * ------------------------------------------------------------------ */

test('N-WP20: ids() answers for the whole store, past any page boundary', async (t) => {
  /*
   * The canvas prunes card positions, tab membership and typed names against
   * "what the machine still has". Deciding that from the first page of the
   * listing meant everything past the 200th session counted as gone. 201 is
   * the smallest store that shows it.
   */
  const root = await mkdtemp(path.join(os.tmpdir(), 'nazar-history-ids-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'C--proj-many');
  await mkdir(project, { recursive: true });
  for (let index = 0; index < 201; index += 1) {
    const id = `session-${String(index).padStart(3, '0')}`;
    await writeFile(path.join(project, `${id}.jsonl`), usageLine('parent', 1), 'utf8');
  }

  const scan = new HistoryScanner({ projectsDir: root, home: HOME, indexTtlMs: 0 });

  const page = await scan.list({ limit: 200 });
  assert.equal(page.total, 201);
  assert.equal(page.sessions.length, 200, 'a page is still a page');
  assert.equal(page.nextOffset, 200);

  const ids = await scan.ids();
  assert.equal(ids.total, 201);
  assert.equal(ids.sessionIds.length, 201, 'the sweep is not paged');
  assert.equal(new Set(ids.sessionIds).size, 201, 'and carries no duplicates');

  // The session the first page omits is the one whose customisations used to be
  // deleted. It is in this answer, and it is genuinely still openable.
  const shown = new Set(page.sessions.map((one) => one.sessionId));
  const omitted = ids.sessionIds.filter((id) => !shown.has(id));
  assert.equal(omitted.length, 1);
  const missing = omitted[0];
  assert.ok(missing !== undefined);
  assert.ok(await scan.open(missing), 'the session the old prune forgot is still on disk');

  // A listing opens no transcript, and neither does the sweep.
  const reads = scan.stats.fileReads;
  await scan.ids();
  assert.equal(scan.stats.fileReads, reads, 'the sweep opens nothing');
});
