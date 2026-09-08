/**
 * The `claude agents --json` runner.
 *
 * Nothing here runs the real `claude`. The runner takes the command it spawns,
 * so the tests inject this Node binary echoing a fixture: the same code path,
 * with output we control.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_AGENTS_ARGS,
  DEFAULT_AGENTS_COMMAND,
  DEFAULT_AGENTS_TIMEOUT_MS,
  createClaudeAgentsRunner,
  parseAgentsOutput,
} from '../src/claude-agents.ts';
import { KNOWN_WAITING_FOR } from '../src/types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const agentsFixture = path.join(here, '..', '..', '..', 'fixtures', 'claude-agents.json');

/** A command that writes the given file to stdout, standing in for `claude`. */
function echoFile(file: string): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: ['-e', `process.stdout.write(require("fs").readFileSync(${JSON.stringify(file)}, "utf8"))`],
  };
}

/** A command that writes a literal string to stdout. */
function echoText(text: string): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: ['-e', `process.stdout.write(${JSON.stringify(text)})`],
  };
}

test('the defaults are the documented command and a 5 s budget', () => {
  assert.equal(DEFAULT_AGENTS_COMMAND, 'claude');
  assert.deepEqual([...DEFAULT_AGENTS_ARGS], ['agents', '--json']);
  assert.equal(DEFAULT_AGENTS_TIMEOUT_MS, 5000);
});

test('an injected command echoing the fixture parses into entries', async () => {
  const runner = createClaudeAgentsRunner(echoFile(agentsFixture));
  const result = await runner();

  assert.equal(result.ok, true);
  assert.equal(result.error, undefined);
  assert.ok(result.durationMs > 0, 'the runner measures its own wall time');
  assert.equal(result.entries.length, 4);

  const first = result.entries[0];
  assert.equal(first?.pid, 1001);
  assert.equal(first?.cwd, 'C:/proj/example');
  assert.equal(first?.kind, 'interactive');
  assert.equal(first?.name, 'session-a');
  assert.equal(first?.status, 'busy');
  assert.equal(first?.sessionId, '00000000-0000-4000-8000-000000000001');
  assert.equal(first?.startedAt, 1788697701170);
  // No session was waiting when the fixture was captured.
  assert.equal(first?.waitingFor, undefined);
});

test('waitingFor survives the round trip', async () => {
  const runner = createClaudeAgentsRunner(
    echoText(
      JSON.stringify([
        {
          pid: 1001,
          cwd: 'C:/proj/example',
          kind: 'interactive',
          startedAt: 1788697701170,
          sessionId: '00000000-0000-4000-8000-000000000001',
          name: 'session-a',
          status: 'waiting',
          waitingFor: 'permission prompt',
        },
      ]),
    ),
  );
  const result = await runner();

  assert.equal(result.ok, true);
  assert.equal(result.entries[0]?.status, 'waiting');
  assert.equal(result.entries[0]?.waitingFor, 'permission prompt');
});

test('the four documented waitingFor values are pinned', () => {
  assert.deepEqual(
    [...KNOWN_WAITING_FOR],
    ['permission prompt', 'input needed', 'sandbox request', 'dialog open'],
  );
});

test('a missing command fails without throwing', async () => {
  const runner = createClaudeAgentsRunner({
    command: 'nazar-no-such-command-4676',
    args: ['agents', '--json'],
    timeoutMs: 5000,
  });
  const result = await runner();

  assert.equal(result.ok, false);
  assert.deepEqual([...result.entries], []);
  assert.ok(result.error !== undefined);
});

test('output that is not JSON, or not an array, fails without throwing', async () => {
  const notJson = await createClaudeAgentsRunner(echoText('claude: command not found'))();
  assert.equal(notJson.ok, false);
  assert.equal(notJson.error, 'output was not JSON');

  const notArray = await createClaudeAgentsRunner(echoText('{"pid":1001}'))();
  assert.equal(notArray.ok, false);
  assert.equal(notArray.error, 'output was not an array');
});

test('the parser ignores unknown keys and drops entries without a usable pid', () => {
  const parsed = parseAgentsOutput(
    JSON.stringify([
      { pid: 1001, status: 'idle', somethingNew: { deeply: ['nested'] } },
      { cwd: 'C:/proj/example' },
      { pid: 'not a number' },
      { pid: -3 },
      null,
      'a string',
      { pid: 1002, status: 'busy' },
    ]),
  );

  assert.equal(parsed.error, undefined);
  assert.deepEqual(
    parsed.entries.map((entry) => entry.pid),
    [1001, 1002],
  );
  assert.equal(parsed.entries[0]?.status, 'idle');
});
