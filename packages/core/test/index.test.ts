import assert from 'node:assert/strict';
import test from 'node:test';

import { providers, version } from '../src/index.ts';

test('core exports a semver version', () => {
  assert.match(version, /^\d+\.\d+\.\d+$/);
});

test('claude is the only v1 provider', () => {
  assert.deepEqual([...providers], ['claude']);
});
