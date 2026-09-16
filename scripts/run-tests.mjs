#!/usr/bin/env node
/**
 * `npm test`: every suite in the repository, and a verdict that has counted all
 * of them.
 *
 * **Why this is not one line of shell any more.** It used to be:
 *
 * ```
 * "test": "npm run test --workspaces && node --import tsx --test test/…"
 * ```
 *
 * `npm run --workspaces` stops at the first workspace that fails, and `&&` then
 * stops before the repository-wide gates. So a single broken assertion in
 * `packages/core` meant the licence check, the fixture scan, the no-writes gate,
 * the Hermes column check and the packaging check did not run at all — and
 * nothing said so. The run ended with one failure on screen and four silent
 * skips behind it. That was never a decision; it is what `&&` does.
 *
 * Every suite now runs, whatever the ones before it did, and the summary at the
 * end names each of them. The exit code is still the honest one: non-zero if any
 * suite failed.
 *
 * **Why it spawns `node` and not `npm`.** Each workspace's `test` script is a
 * `node --import tsx --test …` line and nothing more, so this reads that line,
 * checks that it still has that shape, and runs it directly with the same
 * interpreter this script is running under. That keeps the file list in the one
 * place a workspace's tests are already listed, and it avoids spawning `npm.cmd`
 * on Windows, which Node will not do without a shell.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The repository root: the directory this script's folder sits in. */
export const ROOT = path.join(here, '..');

/**
 * The repository-wide gates, which belong to no workspace.
 *
 * Spelled here rather than in `package.json` because that is now a single
 * command; this is the list it used to hold, moved one file across.
 */
export const ROOT_TESTS = [
  'test/fixtures.test.ts',
  'test/licenses.test.ts',
  'test/binary-paths.test.ts',
  'test/no-writes.test.ts',
  'test/hermes-columns.test.ts',
  'test/packaging.test.ts',
  'test/test-runner.test.ts',
];

/**
 * Turn a workspace's `test` script into the arguments to give `node`.
 *
 * Deliberately strict. A workspace whose script grows a pipe, a `&&` or a
 * quoted argument is one this runner would silently mis-execute, so it stops
 * and says which workspace and what it found instead.
 */
export function argumentsOf(script, where) {
  if (typeof script !== 'string' || script.trim() === '') {
    throw new Error(`${where} has no "test" script`);
  }
  if (/["'|&;<>]/.test(script)) {
    throw new Error(`${where}'s "test" script is not a plain command: ${script}`);
  }
  const parts = script.trim().split(/\s+/u);
  if (parts[0] !== 'node') {
    throw new Error(`${where}'s "test" script does not start with "node": ${script}`);
  }
  return parts.slice(1);
}

/**
 * Every suite `npm test` runs, in order: each workspace, then the gates.
 *
 * The workspace list comes from `package.json` rather than from a copy kept
 * here, so adding a workspace adds its tests to `npm test` and to the check in
 * `test/test-runner.test.ts` at the same moment.
 */
export function suites(root = ROOT) {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const found = [];
  for (const workspace of manifest.workspaces ?? []) {
    const dir = path.join(root, ...workspace.split('/'));
    const own = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    found.push({
      name: workspace,
      cwd: dir,
      args: argumentsOf(own.scripts?.test, workspace),
    });
  }
  found.push({
    name: 'repository gates',
    cwd: root,
    args: ['--import', 'tsx', '--test', ...ROOT_TESTS],
  });
  return found;
}

/**
 * Run every suite, in order, and return what each of them did.
 *
 * `spawn` is injected so the test can drive this without starting a process:
 * the thing worth pinning is that a failure does not stop the run, and that is
 * a property of this loop rather than of any suite.
 */
export function runAll(list, spawn) {
  const results = [];
  for (const suite of list) {
    const status = spawn(suite);
    results.push({ name: suite.name, ok: status === 0, status });
  }
  return results;
}

/** The closing summary, and the exit code that goes with it. */
export function summarise(results) {
  const failed = results.filter((result) => !result.ok);
  const lines = results.map((result) => `  ${result.ok ? 'pass' : 'FAIL'}  ${result.name}`);
  const verdict =
    failed.length === 0
      ? `all ${results.length} suites passed`
      : `${failed.length} of ${results.length} suites failed: ${failed
          .map((result) => result.name)
          .join(', ')}`;
  return { code: failed.length === 0 ? 0 : 1, text: `\n${lines.join('\n')}\n${verdict}\n` };
}

function main() {
  const list = suites();
  const results = runAll(list, (suite) => {
    process.stdout.write(`\n=== ${suite.name} ===\n`);
    const run = spawnSync(process.execPath, suite.args, { cwd: suite.cwd, stdio: 'inherit' });
    if (run.error !== undefined) throw run.error;
    // A suite killed by a signal has no status; that is a failure, not a pass.
    return run.status ?? 1;
  });
  const { code, text } = summarise(results);
  process.stdout.write(text);
  process.exitCode = code;
}

// Only when run, never when imported by the test beside it.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
