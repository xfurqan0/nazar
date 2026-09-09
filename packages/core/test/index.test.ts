import assert from 'node:assert/strict';
import test from 'node:test';

import { providers, version } from '../src/index.ts';

test('core exports a semver version', () => {
  assert.match(version, /^\d+\.\d+\.\d+$/);
});

test('the canvas draws three providers, and claude is still the first', () => {
  // N-WP18 added Codex, N-WP17a Hermes read-only. The order is the order cards
  // were taught to exist in, and nothing depends on it; what this pins is that
  // a *fourth* provider cannot arrive without somebody having to look at this
  // line. A provider is a decision about what this program is, and it should
  // have to change this line to be made.
  assert.deepEqual([...providers], ['claude', 'codex', 'hermes']);
});
