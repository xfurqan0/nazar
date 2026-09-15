/**
 * What `npm test` actually runs, and what it does when one suite fails.
 *
 * The old `npm test` was `npm run test --workspaces && node --test test/…`, and
 * both halves of that line stop early: `--workspaces` at the first workspace
 * that fails, `&&` at the first non-zero exit. A failing assertion in
 * `packages/core` therefore skipped `packages/server`, `packages/ui` and all
 * five repository gates without a word about having done so. It was measured on
 * a Linux machine where one gate was firing: the run reported one failure, and
 * seventy-one tests nobody had run.
 *
 * So the two properties worth pinning are pinned here, with no process started:
 *
 * 1. **Every suite is in the list.** Every workspace `package.json` declares,
 *    plus the repository gates — including every `test/*.test.ts` on disk, so a
 *    new gate file that nobody wired up fails this rather than sitting unrun.
 * 2. **A failure does not stop the run.** `runAll` attempts every suite and the
 *    verdict counts all of them.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Plain JavaScript on purpose: this is the script that starts the type-aware
// suites, so it cannot be one of them. `run-tests.d.mts` declares its surface.
import { argumentsOf, ROOT_TESTS, runAll, suites, summarise } from '../scripts/run-tests.mjs';
import type { Suite, SuiteResult } from '../scripts/run-tests.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

interface Manifest {
  readonly workspaces?: readonly string[];
  readonly scripts?: Readonly<Record<string, string>>;
}

function manifest(...relative: string[]): Manifest {
  return JSON.parse(readFileSync(path.join(root, ...relative), 'utf8')) as Manifest;
}

test('npm test is the runner, and the runner covers every workspace', () => {
  const rootManifest = manifest('package.json');
  assert.equal(
    rootManifest.scripts?.['test'],
    'node scripts/run-tests.mjs',
    'npm test must go through the runner, or a failing suite can hide the ones after it',
  );

  const listed = suites(root);
  const workspaces = [...(rootManifest.workspaces ?? [])];
  assert.deepEqual(
    listed.slice(0, workspaces.length).map((suite: Suite) => suite.name),
    workspaces,
    'every workspace runs, in the order package.json declares them',
  );
  assert.equal(listed.at(-1)?.name, 'repository gates', 'the gates run last, and they do run');
});

test('every repository gate on disk is one npm test runs', () => {
  const onDisk = readdirSync(path.join(root, 'test'))
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => `test/${name}`)
    .sort();
  assert.deepEqual([...ROOT_TESTS].sort(), onDisk, 'a gate file that is not in the list never runs');
});

test('a workspace script that is not a plain node command stops the runner', () => {
  assert.deepEqual(argumentsOf('node --test a.ts b.ts', 'packages/x'), [
    '--test',
    'a.ts',
    'b.ts',
  ]);
  // Anything the runner would mis-execute is named rather than half-run.
  assert.throws(() => argumentsOf('node --test a.ts && node --test b.ts', 'packages/x'), /not a plain command/u);
  assert.throws(() => argumentsOf('vitest run', 'packages/x'), /does not start with "node"/u);
  assert.throws(() => argumentsOf(undefined, 'packages/x'), /no "test" script/u);
});

test('a failing suite does not stop the ones after it', () => {
  const list: Suite[] = [
    { name: 'first', cwd: root, args: [] },
    { name: 'second', cwd: root, args: [] },
    { name: 'third', cwd: root, args: [] },
  ];
  const attempted: string[] = [];
  const results = runAll(list, (suite: Suite) => {
    attempted.push(suite.name);
    return suite.name === 'first' ? 1 : 0;
  });

  // This is the regression: under `&&`, `attempted` would have been ['first'].
  assert.deepEqual(attempted, ['first', 'second', 'third']);
  assert.deepEqual(
    results.map((result: SuiteResult) => result.ok),
    [false, true, true],
  );
});

test('the verdict counts every suite, and one failure anywhere is a failure', () => {
  const passed: SuiteResult[] = [
    { name: 'a', ok: true, status: 0 },
    { name: 'b', ok: true, status: 0 },
  ];
  assert.equal(summarise(passed).code, 0);
  assert.match(summarise(passed).text, /all 2 suites passed/u);

  const mixed: SuiteResult[] = [
    { name: 'a', ok: false, status: 1 },
    { name: 'b', ok: true, status: 0 },
    { name: 'c', ok: false, status: 1 },
  ];
  const verdict = summarise(mixed);
  assert.equal(verdict.code, 1);
  // Both failures are named, not only the first one to happen.
  assert.match(verdict.text, /2 of 3 suites failed: a, c/u);
});
