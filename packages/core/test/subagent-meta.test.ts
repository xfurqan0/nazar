/**
 * The `subagents/` reader.
 *
 * The shipped fixtures are the real directory shape; the temporary directories
 * cover the shapes this machine has never produced, workflow runs above all
 * (0 of 33 session directories here have one).
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MAX_DESCRIPTION_LENGTH, parseAgentMeta, readSubagentsDir } from '../src/subagent-meta.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureSubagents = path.join(here, '..', '..', '..', 'fixtures', 'subagents');

function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'nazar-subagents-'));
}

const META = JSON.stringify({
  agentType: 'general-purpose',
  model: 'opus',
  parentAgentId: 'a0000000000000001',
  spawnDepth: 2,
  toolUseId: 'toolu_000000000000000000000002',
  description: 'task placeholder',
});

test('the fixture directory reads back as seven agents and one transcript', async () => {
  const scan = await readSubagentsDir(fixtureSubagents);

  assert.equal(scan.missingDirectory, false);
  assert.equal(scan.warnings, 0);
  assert.equal(scan.metas.length, 7);
  assert.deepEqual(
    scan.transcripts.map((entry) => entry.agentId),
    ['a0000000000000006'],
    'parent-slice.jsonl is not an agent transcript and must be ignored',
  );
  assert.deepEqual(scan.workflowRuns, []);

  const byId = new Map(scan.metas.map((meta) => [meta.id, meta]));
  assert.equal(byId.get('a0000000000000001')?.parentAgentId, undefined, 'a root writes no parent');
  assert.equal(byId.get('a0000000000000001')?.spawnDepth, 1);
  assert.equal(byId.get('a0000000000000003')?.parentAgentId, 'a0000000000000002');
  assert.equal(byId.get('a0000000000000003')?.spawnDepth, 3);
  assert.equal(byId.get('a0000000000000005')?.model, undefined, 'a guide agent omits model');
  assert.equal(byId.get('a0000000000000005')?.agentType, 'claude-code-guide');
  assert.equal(byId.get('a0000000000000007')?.agentType, 'Explore');
});

test('a missing directory is the normal state of a session with no subagent', async () => {
  const scan = await readSubagentsDir(path.join(os.tmpdir(), 'nazar-subagents-absent-4676'));
  assert.equal(scan.missingDirectory, true);
  assert.equal(scan.warnings, 0);
  assert.deepEqual(scan.metas, []);
});

test('a malformed meta file is counted and skipped, the rest still read', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(path.join(dir, 'agent-a0000000000000001.meta.json'), META, 'utf8');
  await writeFile(path.join(dir, 'agent-a0000000000000002.meta.json'), '{ not json', 'utf8');
  await writeFile(path.join(dir, 'agent-a0000000000000001.jsonl'), '{"type":"user"}\n', 'utf8');
  await writeFile(path.join(dir, 'notes.txt'), 'ignored', 'utf8');

  const scan = await readSubagentsDir(dir);
  assert.equal(scan.warnings, 1);
  assert.equal(scan.metas.length, 1);
  assert.equal(scan.transcripts.length, 1);
});

test('workflow runs are listed and their agents tagged with the run id', async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(path.join(dir, 'agent-a0000000000000001.meta.json'), META, 'utf8');
  const runA = path.join(dir, 'workflows', 'run-0001');
  const runB = path.join(dir, 'workflows', 'run-0002');
  await mkdir(runA, { recursive: true });
  await mkdir(runB, { recursive: true });
  await writeFile(path.join(runA, 'agent-a0000000000000009.meta.json'), META, 'utf8');
  await writeFile(path.join(runA, 'agent-a0000000000000009.jsonl'), '{"type":"user"}\n', 'utf8');

  const scan = await readSubagentsDir(dir);
  assert.equal(scan.metas.length, 2);
  assert.equal(scan.metas.find((meta) => meta.id === 'a0000000000000009')?.workflowRunId, 'run-0001');
  assert.equal(scan.metas.find((meta) => meta.id === 'a0000000000000001')?.workflowRunId, undefined);
  assert.equal(scan.transcripts[0]?.workflowRunId, 'run-0001');

  // A run whose directory carries no meta file is still surfaced as a group,
  // because the canvas must be able to say "this run exists" either way.
  assert.deepEqual(
    scan.workflowRuns.map((run) => [run.runId, run.agentIds]),
    [
      ['run-0001', ['a0000000000000009']],
      ['run-0002', []],
    ],
  );
});

test('description is capped rather than truncated, and the file name is the identity', () => {
  const long = 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1);
  const meta = parseAgentMeta(
    'agent-a0000000000000001.meta.json',
    JSON.stringify({ agentType: 'general-purpose', spawnDepth: 1, description: long }),
  );
  assert.equal(meta?.id, 'a0000000000000001');
  assert.equal(meta?.description, undefined);

  assert.equal(parseAgentMeta('agent-.meta.json', META), undefined, 'an empty id is not an agent');
  assert.equal(parseAgentMeta('random.json', META), undefined);
  assert.equal(parseAgentMeta('agent-a1.meta.json', 'not json'), undefined);
  assert.equal(parseAgentMeta('agent-a1.meta.json', '[]'), undefined);
});

test('an empty parentAgentId means root, exactly as an absent one does', () => {
  const meta = parseAgentMeta(
    'agent-a0000000000000001.meta.json',
    JSON.stringify({ agentType: 'general-purpose', parentAgentId: '', spawnDepth: 1 }),
  );
  assert.equal(meta?.parentAgentId, undefined);
});
