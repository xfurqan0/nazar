import assert from 'node:assert/strict';
import test from 'node:test';

import { providers, version } from '../src/index.ts';

test('core exports a semver version', () => {
  assert.match(version, /^\d+\.\d+\.\d+$/);
});

test('the canvas draws two providers, and claude is still the first', () => {
  // N-WP18 added Codex. The order is the order cards were taught to exist in,
  // and nothing depends on it; what this pins is that a *third* provider cannot
  // arrive without somebody having to look at this line.
  assert.deepEqual([...providers], ['claude', 'codex']);
});
