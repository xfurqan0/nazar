/**
 * The pinned-formats gate.
 *
 * Everything Nazar reads inside `~/.claude` belongs to Claude Code and can move
 * without notice, so docs/pinned-internal-formats.md is the inventory of what
 * we depend on. This test keeps the inventory honest from the other side: it
 * greps this package's sources for every `~/.claude`-relative path literal and
 * fails when one of them is not in that document. Code that reads an unlisted
 * path breaks the test.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const pinnedDoc = path.join(here, '..', '..', '..', 'docs', 'pinned-internal-formats.md');

/** Every `~/.claude/...` literal in a source file, comments included. */
function claudePathLiterals(source: string): string[] {
  const found = source.match(/~\/\.claude\/[A-Za-z0-9._<>*/-]*/g) ?? [];
  return found.map((literal) => literal.replace(/\.+$/, ''));
}

/**
 * The same, for `~/.nazar` (WP3'/WP5).
 *
 * That directory belongs to nazar-tray rather than to Claude Code, and its
 * contract is frozen in a *second* repository — which makes an unlisted path
 * there exactly as dangerous as an unlisted one under `~/.claude`, and worth
 * the same gate. The bare root is matched too: a reader that reached for
 * `~/.nazar` itself should have to say so in the document.
 */
function nazarPathLiterals(source: string): string[] {
  const found = source.match(/~\/\.nazar(?:\/[A-Za-z0-9._<>*/-]*)?/g) ?? [];
  return found.map((literal) => literal.replace(/\.+$/, ''));
}

/**
 * The same again, for a **project's** own Claude Code settings (WP4f).
 *
 * `<cwd>/.claude/...` is a third root, and it is the one that belongs to the
 * user's repository rather than to their home directory — which makes an
 * unlisted read there more surprising than either of the other two, not less.
 * The gate is the same: name it in a source, and it has to be in the table.
 */
function projectPathLiterals(source: string): string[] {
  const found = source.match(/<cwd>\/\.claude\/[A-Za-z0-9._<>*/-]*/g) ?? [];
  return found.map((literal) => literal.replace(/\.+$/, ''));
}

/** Every backticked span in the pinned document. */
function pinnedSpans(doc: string): string[] {
  return [...doc.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? '');
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

const spans = pinnedSpans(readFileSync(pinnedDoc, 'utf8'));

function isPinned(literal: string): boolean {
  return spans.some((span) => span.includes(literal));
}

test('the pinned document has backticked paths to check against', () => {
  assert.ok(spans.length > 0);
  assert.ok(isPinned('~/.claude/sessions/<pid>.json'));
  assert.ok(isPinned('~/.claude/sessions/<pid>.<hash>.key'));
});

test('the four shapes WP2 opens each have their own row', () => {
  // Each of these is read by a different parser, so each needs its own row
  // rather than being covered by a prefix of another one.
  for (const literal of [
    '~/.claude/projects/<slug>/<session>.jsonl',
    '~/.claude/projects/<slug>/<session>/subagents',
    '~/.claude/projects/<slug>/<session>/subagents/agent-*.meta.json',
    '~/.claude/projects/<slug>/<session>/subagents/agent-*.jsonl',
    '~/.claude/projects/<slug>/<session>/subagents/workflows/<runId>',
  ]) {
    assert.ok(isPinned(literal), `${literal} is not pinned`);
  }
});

test('the transcript reader\'s "never extracted" list is in the document', () => {
  const doc = readFileSync(pinnedDoc, 'utf8');
  const index = doc.indexOf('### Never extracted from a transcript line');
  assert.ok(index > 0, 'the never-extracted list is the privacy claim in prose; it must exist');
  const section = doc.slice(index);
  for (const field of ['tool_use.input', 'prompt', 'thinking', 'stdout', 'cwd', 'attachment']) {
    assert.ok(section.includes(field), `${field} is missing from the never-extracted list`);
  }
});

test('every ~/.claude path the core reads is listed in docs/pinned-internal-formats.md', () => {
  const files = sourceFiles(srcDir);
  assert.ok(files.length > 0, 'no sources to grep');

  const seen = new Map<string, string>();
  for (const file of files) {
    for (const literal of claudePathLiterals(readFileSync(file, 'utf8'))) {
      if (!seen.has(literal)) seen.set(literal, path.relative(srcDir, file));
    }
  }

  assert.ok(seen.size > 0, 'the core reads nothing under ~/.claude, which cannot be right');
  for (const [literal, file] of seen) {
    assert.ok(
      isPinned(literal),
      `${file} names ${literal}, which is not in docs/pinned-internal-formats.md`,
    );
  }
});

test('the two files WP3\' and WP5 read under ~/.nazar each have their own row', () => {
  for (const literal of [
    '~/.nazar/statusline',
    '~/.nazar/statusline/<session_id>.json',
    '~/.nazar/statusline/chain.json',
    '~/.nazar/limits.json',
  ]) {
    assert.ok(isPinned(literal), `${literal} is not pinned`);
  }
});

test('every ~/.nazar path the core reads is listed in docs/pinned-internal-formats.md', () => {
  const files = sourceFiles(srcDir);
  const seen = new Map<string, string>();
  for (const file of files) {
    for (const literal of nazarPathLiterals(readFileSync(file, 'utf8'))) {
      if (!seen.has(literal)) seen.set(literal, path.relative(srcDir, file));
    }
  }

  assert.ok(seen.size > 0, 'the core names nothing under ~/.nazar, which cannot be right');
  for (const [literal, file] of seen) {
    assert.ok(
      isPinned(literal),
      `${file} names ${literal}, which is not in docs/pinned-internal-formats.md`,
    );
  }
});

test("the two project settings files WP4f reads each have their own row", () => {
  for (const literal of ['<cwd>/.claude/settings.json', '<cwd>/.claude/settings.local.json']) {
    assert.ok(isPinned(literal), `${literal} is not pinned`);
  }
});

test('every <cwd>/.claude path the core reads is listed in docs/pinned-internal-formats.md', () => {
  const files = sourceFiles(srcDir);
  const seen = new Map<string, string>();
  for (const file of files) {
    for (const literal of projectPathLiterals(readFileSync(file, 'utf8'))) {
      if (!seen.has(literal)) seen.set(literal, path.relative(srcDir, file));
    }
  }

  assert.ok(seen.size > 0, 'the core names nothing under a project, which cannot be right');
  for (const [literal, file] of seen) {
    assert.ok(
      isPinned(literal),
      `${file} names ${literal}, which is not in docs/pinned-internal-formats.md`,
    );
  }
});

test('the gate bites: an unlisted path is not accepted', () => {
  const literals = claudePathLiterals('const todos = "~/.claude/todos/<id>.json";');
  assert.deepEqual(literals, ['~/.claude/todos/<id>.json']);
  assert.equal(isPinned('~/.claude/todos/<id>.json'), false);

  const nazar = nazarPathLiterals('const cache = "~/.nazar/cache/<id>.bin";');
  assert.deepEqual(nazar, ['~/.nazar/cache/<id>.bin']);
  assert.equal(isPinned('~/.nazar/cache/<id>.bin'), false);

  const project = projectPathLiterals('const mcp = "<cwd>/.claude/mcp.json";');
  assert.deepEqual(project, ['<cwd>/.claude/mcp.json']);
  assert.equal(isPinned('<cwd>/.claude/mcp.json'), false);
});

test('the credential files stay in the "not read" table', () => {
  const doc = readFileSync(pinnedDoc, 'utf8');
  const notRead = doc.slice(doc.indexOf('## Not read, on purpose'));
  assert.ok(notRead.includes('~/.claude/sessions/<pid>.<hash>.key'));
});
