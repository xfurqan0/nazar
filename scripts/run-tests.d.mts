/**
 * Types for `run-tests.mjs`, so `test/test-runner.test.ts` can import it.
 *
 * The script itself stays plain JavaScript, for the same reason the licence
 * check does: it is the thing that starts the type-aware suites, so it cannot
 * be one of them. This declares what the test reaches for and nothing more.
 */

/** One suite `npm test` runs: a working directory and the arguments for `node`. */
export interface Suite {
  readonly name: string;
  readonly cwd: string;
  readonly args: readonly string[];
}

/** What one suite did. `status` is the child's exit code, or 1 for a signal. */
export interface SuiteResult {
  readonly name: string;
  readonly ok: boolean;
  readonly status: number;
}

/** The repository root. */
export const ROOT: string;

/** The repository-wide gates, the ones that belong to no workspace. */
export const ROOT_TESTS: readonly string[];

/** A workspace's `test` script as arguments for `node`. Throws on any other shape. */
export function argumentsOf(script: unknown, where: string): string[];

/** Every suite, in order: each workspace from `package.json`, then the gates. */
export function suites(root?: string): Suite[];

/** Run every suite in order, whatever the ones before it did. */
export function runAll(list: readonly Suite[], spawn: (suite: Suite) => number): SuiteResult[];

/** The closing summary and the exit code that goes with it. */
export function summarise(results: readonly SuiteResult[]): { code: number; text: string };
