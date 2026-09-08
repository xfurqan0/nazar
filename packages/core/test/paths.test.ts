/**
 * Resolution of the `~/.claude` path literals. Nothing here touches the real
 * directory: the home and the environment are both injected.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  CLAUDE_PROJECT_DIR,
  CLAUDE_SESSION_FILE,
  CLAUDE_SESSION_KEY_FILE,
  CLAUDE_SESSIONS_DIR,
  claudeConfigDir,
  resolveClaudePath,
  sessionsDirPath,
} from '../src/paths.ts';

test('the literals are home-relative and stable', () => {
  assert.equal(CLAUDE_SESSIONS_DIR, '~/.claude/sessions');
  assert.equal(CLAUDE_SESSION_FILE, '~/.claude/sessions/<pid>.json');
  assert.equal(CLAUDE_SESSION_KEY_FILE, '~/.claude/sessions/<pid>.<hash>.key');
  assert.equal(CLAUDE_PROJECT_DIR, '~/.claude/projects/<slug>');
});

test('the config directory defaults to <home>/.claude', () => {
  assert.equal(claudeConfigDir({}, path.join('C:', 'home', 'example')), path.join('C:', 'home', 'example', '.claude'));
});

test('CLAUDE_CONFIG_DIR overrides the default', () => {
  const overridden = path.join('D:', 'claude-config');
  assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: overridden }, 'ignored'), overridden);
  assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: '' }, path.join('C:', 'home')), path.join('C:', 'home', '.claude'));
});

test('a literal resolves under the config directory', () => {
  const home = path.join('C:', 'home', 'example');
  assert.equal(
    resolveClaudePath(CLAUDE_SESSIONS_DIR, {}, home),
    path.join(home, '.claude', 'sessions'),
  );
  assert.equal(sessionsDirPath({}, home), path.join(home, '.claude', 'sessions'));
});

test('a pattern is not a directory and cannot be resolved', () => {
  assert.throws(() => resolveClaudePath(CLAUDE_SESSION_FILE), /pattern/);
  assert.throws(() => resolveClaudePath(CLAUDE_PROJECT_DIR), /pattern/);
  assert.throws(() => resolveClaudePath('/etc/passwd'), /not a Claude Code path literal/);
});
