/**
 * The `~/.claude/projects` slug rule, pinned as a table.
 *
 * The rule was recovered twice under Claude Code 2.1.263 (see the module's own
 * comment): once by reproducing all 68 directory names on the maintainer's
 * machine from the `cwd` recorded inside their transcripts, and once from the
 * transform carried verbatim in the shipped binary. These cases are the second
 * half of that: they hold the shape steady so a change is a failing test rather
 * than a canvas that quietly finds no transcripts.
 *
 * Paths here are placeholders. Nothing in this repository carries a real
 * working directory.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { claudeConfigDir } from '../src/paths.ts';
import {
  PROJECT_SLUG_MAX_LENGTH,
  projectSlugFor,
  projectSlugHash,
  projectSlugIsTruncated,
} from '../src/project-slug.ts';

interface Case {
  readonly what: string;
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  readonly slug: string;
}

const cases: readonly Case[] = [
  {
    what: 'a Windows drive letter and backslashes',
    cwd: 'C:\\proj\\example',
    platform: 'win32',
    slug: 'C--proj-example',
  },
  {
    what: 'the same directory spelled with forward slashes',
    cwd: 'C:/proj/example',
    platform: 'win32',
    slug: 'C--proj-example',
  },
  {
    what: 'a second drive letter, spaces in two segments',
    cwd: 'D:\\Program Files\\proj demo',
    platform: 'win32',
    slug: 'D--Program-Files-proj-demo',
  },
  {
    what: 'a UNC path',
    cwd: '\\\\server\\share\\proj',
    platform: 'win32',
    slug: '--server-share-proj',
  },
  {
    what: 'a POSIX absolute path',
    cwd: '/opt/proj/example',
    platform: 'linux',
    slug: '-opt-proj-example',
  },
  {
    what: 'a POSIX path with a space',
    cwd: '/var/www/my site',
    platform: 'darwin',
    slug: '-var-www-my-site',
  },
  {
    // o-umlaut, c-cedilla and u-umlaut are each one UTF-16 code unit.
    what: 'non-ASCII characters inside the Basic Multilingual Plane',
    cwd: 'C:\\proj\\\u00f6l\u00e7\u00fcm',
    platform: 'win32',
    slug: 'C--proj--l--m',
  },
  {
    // U+1F4CA is a surrogate pair, so it becomes two dashes, not one: the
    // sanitizing regex in Claude Code has no `u` flag and walks code units.
    what: 'an astral emoji, which costs two dashes',
    cwd: 'C:\\proj\\\u{1F4CA} reports',
    platform: 'win32',
    slug: 'C--proj----reports',
  },
  {
    what: 'the same emoji on a POSIX path',
    cwd: '/opt/proj/\u{1F4CA} reports',
    platform: 'linux',
    slug: '-opt-proj----reports',
  },
];

for (const { what, cwd, platform, slug } of cases) {
  test(`slug for ${what}`, () => {
    assert.equal(projectSlugFor(cwd, platform), slug);
    assert.equal(projectSlugIsTruncated(cwd, platform), false);
  });
}

test('a slug holds only characters legal in a directory name', () => {
  for (const { cwd, platform } of cases) {
    assert.match(projectSlugFor(cwd, platform), /^[A-Za-z0-9-]+$/);
  }
});

test('separators are interchangeable below the length limit on every platform', () => {
  for (const platform of ['win32', 'linux', 'darwin'] as const) {
    assert.equal(
      projectSlugFor('C:\\proj\\example', platform),
      projectSlugFor('C:/proj/example', platform),
      `${platform} should slug both spellings of one Windows path the same way`,
    );
  }
});

test('the hash matches Claude Code: a 32-bit h = h * 31 + c', () => {
  assert.equal(projectSlugHash(''), 0);
  assert.equal(projectSlugHash('a'), 97);
  assert.equal(projectSlugHash('abc'), 96354);
  // Wraps to a signed 32-bit integer on every step rather than growing.
  assert.ok(projectSlugHash('a'.repeat(64)) <= 0x7fffffff);
  assert.ok(projectSlugHash('a'.repeat(64)) >= -0x80000000);
});

const long = `C:\\proj\\${'segment'.repeat(40)}\\end`;

test('past 200 characters the slug is truncated and hashed', () => {
  assert.ok(long.length > PROJECT_SLUG_MAX_LENGTH);
  assert.equal(projectSlugIsTruncated(long, 'win32'), true);

  const slug = projectSlugFor(long, 'win32');
  assert.equal(
    slug.slice(0, PROJECT_SLUG_MAX_LENGTH),
    long.replace(/[^a-zA-Z0-9]/g, '-').slice(0, PROJECT_SLUG_MAX_LENGTH),
  );
  // Math.abs(projectSlugHash(long)).toString(36) === 'gtr0pl'.
  assert.equal(slug.slice(PROJECT_SLUG_MAX_LENGTH), '-gtr0pl');
});

test('past the limit the platform decides what a backslash is', () => {
  const forwardSlashes = long.replace(/\\/g, '/');
  // On Windows the two spellings name one directory, and Claude Code hashed the
  // backslash form it got from process.cwd(), so they must agree.
  assert.equal(projectSlugFor(forwardSlashes, 'win32'), projectSlugFor(long, 'win32'));
  // On POSIX a backslash is an ordinary file name character, so folding it
  // would invent a different directory. The hashes must differ.
  assert.notEqual(projectSlugFor(forwardSlashes, 'linux'), projectSlugFor(long, 'linux'));
});

test('the real project directories on this machine have slug-shaped names', (t) => {
  // Skipped in CI and on any machine that has never run Claude Code. The full
  // check (every directory reproduced from the cwd inside its own transcripts,
  // 68 of 68) belongs to the WP1 audit, not to a portable test.
  const projects = path.join(claudeConfigDir(), 'projects');
  if (!existsSync(projects)) {
    t.skip('no ~/.claude/projects on this machine');
    return;
  }
  const names = readdirSync(projects, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.ok(names.length > 0);
  for (const name of names) {
    assert.match(name, /^[A-Za-z0-9-]+$/, `${name} is not shaped like a slug`);
  }
});
