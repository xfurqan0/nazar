/**
 * The licence allow-list, and the parser that reads it.
 *
 * `scripts/check-licenses.mjs` used to carry its own copy of the fifteen SPDX identifiers
 * in `deny.toml`, kept in step by hand and compared by nobody. Two lists that must agree
 * and cannot be checked against each other are one list and one liability, so the script
 * reads the TOML now and this pins the reading.
 *
 * Nothing here runs the check itself: that needs `cargo metadata` and a populated
 * `node_modules`, and CI already runs it on the desktop job. What is checked is the half
 * that has no other test — the small parser, and the policy it produces.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The script is plain JavaScript on purpose — it runs on a machine with the Rust
// toolchain and nothing built. `check-licenses.d.mts` beside it declares what is used.
import { ALLOWED, DENY_TOML, isAllowed, parseAllowedLicenses } from '../scripts/check-licenses.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const denyToml = readFileSync(path.join(here, '..', 'deny.toml'), 'utf8');

test('the allow-list the script uses is the one deny.toml declares', () => {
  const declared = parseAllowedLicenses(denyToml);
  assert.deepEqual([...ALLOWED].sort(), [...declared].sort());
  assert.ok(DENY_TOML.endsWith('deny.toml'));
});

test('the allow-list is permissive, and says so by what is missing from it', () => {
  const declared = parseAllowedLicenses(denyToml);
  for (const permissive of ['MIT', 'Apache-2.0', 'ISC', 'BSD-3-Clause']) {
    assert.ok(declared.includes(permissive), `${permissive} should be allowed`);
  }
  // A copyleft dependency in an MIT product is a rewrite, not a paperwork problem.
  for (const copyleft of ['GPL-2.0', 'GPL-3.0', 'AGPL-3.0', 'LGPL-2.1', 'LGPL-3.0', 'SSPL-1.0']) {
    assert.ok(!declared.includes(copyleft), `${copyleft} must never be on the list`);
  }
});

test('the parser reads the licences table and nothing else in the file', () => {
  const toml = [
    '# a comment about the file',
    '[graph]',
    'all-features = false',
    '',
    '[licenses]',
    'version = 2',
    'allow = [',
    '    "MIT",         # the common one',
    '    # a whole-line comment naming "GPL-3.0" that is not an entry',
    '    "Apache-2.0",',
    ']',
    'exceptions = []',
    '',
    '[bans]',
    '# a second `allow` further down, which belongs to another tool entirely',
    'allow = ["something-else"]',
  ].join('\n');

  assert.deepEqual(parseAllowedLicenses(toml), ['MIT', 'Apache-2.0']);
});

test('a deny.toml the parser cannot read is an error rather than an empty policy', () => {
  // A gate that silently degrades to "allow everything I remembered" keeps printing the
  // reassuring line while checking nothing, which is worse than no gate.
  assert.throws(() => parseAllowedLicenses('[bans]\nallow = ["MIT"]\n'), /no \[licenses\] table/);
  assert.throws(() => parseAllowedLicenses('[licenses]\nversion = 2\n'), /no "allow" array/);
  assert.throws(() => parseAllowedLicenses('[licenses]\nallow = [\n]\n'), /allows no licence/);
});

test('an SPDX expression is judged the way the licence is offered', () => {
  // OR: the user picks, so one allowed side is enough.
  assert.equal(isAllowed('MIT OR Apache-2.0'), true);
  assert.equal(isAllowed('MIT OR Apache-2.0 OR LGPL-2.1-or-later'), true);
  assert.equal(isAllowed('Apache-2.0/MIT'), true, 'the slash form means OR');
  // AND: every side has to be allowed, because every side applies.
  assert.equal(isAllowed('BSD-3-Clause AND MIT'), true);
  assert.equal(isAllowed('MIT AND GPL-3.0'), false);
  assert.equal(isAllowed('(MIT OR Apache-2.0) AND Unicode-3.0'), true);
  // WITH narrows a licence, so the base decides.
  assert.equal(isAllowed('Apache-2.0 WITH LLVM-exception'), true);
  // And the cases with nothing to judge.
  assert.equal(isAllowed('GPL-3.0-only'), false);
  assert.equal(isAllowed(null), false);
  assert.equal(isAllowed(''), false);
});
