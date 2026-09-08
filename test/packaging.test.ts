/**
 * The two files that describe the published package, checked against each other.
 *
 * `package-lock.json` is generated, so nobody reads it and everybody trusts it — which is
 * how it came to sit in the repository at version `0.0.0` with a `bin` path that had
 * moved in WP6, three work packages after the move. Neither error could break a build: the
 * lockfile's root entry is a description of the workspace, not an instruction to it, so
 * `npm ci` installs the same dependencies whatever it says. What it *would* have broken is
 * anyone reading the repository to find out what version this is, and any tooling that
 * takes a lockfile at its word.
 *
 * So the two facts a lockfile restates about its own package — the version and the
 * command it installs — are asserted rather than assumed. Regenerating after a version
 * bump is one command (`npm install --package-lock-only`); forgetting to is now a failing
 * test rather than something a release audit finds.
 *
 * This reads files and starts nothing. It is deliberately not a check that every
 * dependency in the lockfile resolves — that is `npm ci`, it needs a network, and CI runs
 * it on three platforms already.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

interface Manifest {
  readonly name?: string;
  readonly version?: string;
  readonly bin?: Readonly<Record<string, string>>;
  readonly workspaces?: readonly string[];
  readonly dependencies?: Readonly<Record<string, string>>;
}

interface Lockfile {
  readonly name?: string;
  readonly version?: string;
  readonly lockfileVersion?: number;
  readonly packages?: Readonly<Record<string, Manifest>>;
}

function read<T>(...relative: string[]): T {
  return JSON.parse(readFileSync(path.join(root, ...relative), 'utf8')) as T;
}

const manifest = read<Manifest>('package.json');
const lock = read<Lockfile>('package-lock.json');
const rootEntry = lock.packages?.[''];

test('the lockfile describes this package', () => {
  assert.equal(lock.name, manifest.name);
  assert.ok(rootEntry !== undefined, 'the lockfile has no root package entry');
  assert.equal(rootEntry.name, manifest.name);
});

test('the lockfile root version is the manifest version, in both places it appears', () => {
  assert.match(String(manifest.version), /^\d+\.\d+\.\d+/, 'the manifest has a real version');
  assert.equal(lock.version, manifest.version, 'the lockfile top-level version has drifted');
  assert.equal(rootEntry?.version, manifest.version, 'the lockfile root entry has drifted');
});

test('the lockfile bin is the manifest bin, entry for entry', () => {
  assert.deepEqual(rootEntry?.bin, manifest.bin);
  // The path WP6 moved it to, named here so a move has to be deliberate in two places.
  assert.equal(manifest.bin?.['nazar'], 'bin/nazar.mjs');
});

test('every workspace package is at the same version as the root', () => {
  for (const workspace of manifest.workspaces ?? []) {
    const own = read<Manifest>(...workspace.split('/'), 'package.json');
    assert.equal(
      own.version,
      manifest.version,
      `${workspace} is at ${String(own.version)}, the root is at ${String(manifest.version)}`,
    );
    const locked = lock.packages?.[workspace];
    assert.ok(locked !== undefined, `${workspace} is not in the lockfile`);
    assert.equal(locked.version, manifest.version, `${workspace} is stale in the lockfile`);
  }
});

test('the published package still has no runtime dependency', () => {
  // The claim `CONTRIBUTING.md` makes and the build asserts after bundling. Here it is
  // asserted before: a lockfile that grew a root `dependencies` block is the first
  // visible sign of one arriving.
  assert.deepEqual(manifest.dependencies ?? {}, {});
  assert.deepEqual(rootEntry?.dependencies ?? {}, {});
});
