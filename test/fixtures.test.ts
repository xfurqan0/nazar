/**
 * Fixtures must never carry user content off this machine. The repo is public
 * from the first release on, so this test is the gate: it walks every file
 * under fixtures/ and fails on anything that looks like a real identity, a
 * real path, or a real opaque id.
 *
 * If you add a fixture, sanitize it first and record what you removed in
 * fixtures/README.md.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', 'fixtures');

/** Every file under fixtures/, as [relative path, contents]. */
function readFixtures(dir: string, base = dir): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...readFixtures(full, base));
    } else {
      found.push([path.relative(base, full).split(path.sep).join('/'), readFileSync(full, 'utf8')]);
    }
  }
  return found;
}

const fixtures = readFixtures(fixturesDir);

const forbidden: Array<{ readonly what: string; readonly pattern: RegExp }> = [
  { what: 'an email address', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { what: 'a Windows user home path', pattern: /C:[\\/]+Users[\\/]/i },
  { what: 'a macOS user home path', pattern: /\/Users\// },
  { what: 'a Linux user home path', pattern: /\/home\// },
  { what: 'the maintainer name', pattern: /y[ıi]ld[ıi]z/i },
  { what: 'the maintainer handle "yldz"', pattern: /yldz/i },
];

/**
 * Long hexadecimal runs are opaque ids (agent keys, session key files, hashes).
 * Placeholder ids are all-zero, so only those are allowed through.
 */
const HEX_RUN = /[a-f0-9]{32,}/gi;
const ALLOWED_HEX_RUN = /^0+$/;

test('fixtures directory is not empty', () => {
  assert.ok(fixtures.length > 0, 'no fixtures found');
});

for (const [name, contents] of fixtures) {
  test(`fixture ${name} carries no user content`, () => {
    for (const { what, pattern } of forbidden) {
      const hit = pattern.exec(contents);
      assert.equal(hit, null, `${name} contains ${what}: ${hit?.[0] ?? ''}`);
    }

    for (const hit of contents.matchAll(HEX_RUN)) {
      assert.match(hit[0], ALLOWED_HEX_RUN, `${name} contains a real-looking id: ${hit[0]}`);
    }
  });
}

test('every JSON fixture parses', () => {
  for (const [name, contents] of fixtures) {
    if (!name.endsWith('.json')) continue;
    assert.doesNotThrow(() => JSON.parse(contents) as unknown, `${name} is not valid JSON`);
  }
});

test('every JSONL fixture parses line by line', () => {
  for (const [name, contents] of fixtures) {
    if (!name.endsWith('.jsonl')) continue;
    const lines = contents.split('\n').filter((line) => line.length > 0);
    assert.ok(lines.length > 0, `${name} is empty`);
    lines.forEach((line, i) => {
      assert.doesNotThrow(() => JSON.parse(line) as unknown, `${name} line ${i + 1} is not valid JSON`);
    });
  }
});

test('the transcript slice keeps the duplicate (message.id, requestId) trap', () => {
  const raw = readFileSync(path.join(fixturesDir, 'transcript-slice.jsonl'), 'utf8');
  const seen = new Map<string, number>();

  for (const line of raw.split('\n').filter((l) => l.length > 0)) {
    const entry = JSON.parse(line) as {
      type?: string;
      requestId?: string;
      message?: { id?: string };
    };
    if (entry.type !== 'assistant') continue;
    const key = `${entry.message?.id ?? ''}|${entry.requestId ?? ''}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }

  assert.ok(seen.size > 0, 'no assistant lines in the transcript slice');
  const repeated = [...seen.values()].filter((count) => count > 1);
  assert.ok(
    repeated.length > 0,
    'the slice has no repeated (message.id, requestId) key, so the WP2 dedupe test has nothing to bite on',
  );
});

test('no transcript fixture holds prompt or response text', () => {
  const slices = fixtures.filter(([name]) => name.endsWith('.jsonl'));
  assert.ok(slices.length >= 3, 'the transcript, subagent and parent slices should all be here');

  for (const [name, raw] of slices) {
    for (const line of raw.split('\n').filter((l) => l.length > 0)) {
      const entry = JSON.parse(line) as { message?: { content?: unknown } };
      const content = entry.message?.content;
      if (content === undefined) continue;

      assert.ok(Array.isArray(content), `${name}: message.content should be an array of blocks`);
      for (const block of content as Array<Record<string, unknown>>) {
        for (const [key, value] of Object.entries(block)) {
          if (key === 'type' || key === 'name') continue;
          assert.equal(value, '[redacted]', `${name}: content block field "${key}" was not redacted`);
        }
      }
    }
  }
});

test('N-WP15a: no fixture carries a task anybody actually typed', () => {
  /*
   * The test above already proves every content-block field in every transcript
   * slice was replaced with `[redacted]`, and that is where task text would come
   * from. This is the narrower claim the new feature needs, stated in its own
   * terms so that deleting it would be a visible act:
   *
   * **a fixture's `user` lines hold nothing a person wrote.** `task-text.ts`
   * reads exactly those lines, so while this holds, running the whole task-text
   * path over the fixtures cannot produce a sentence off anybody's machine — and
   * the fixtures are what the tests, the screenshots and the reviewers see.
   */
  const slices = fixtures.filter(([name]) => name.endsWith('.jsonl'));
  assert.ok(slices.length >= 3);

  for (const [name, raw] of slices) {
    for (const line of raw.split('\n').filter((l) => l.length > 0)) {
      const entry = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
      if (entry.type !== 'user') continue;
      const content = entry.message?.content;
      if (content === undefined) continue;
      // A bare string is the older shape of a typed turn, and it would be read
      // verbatim, so it must not be the shape a fixture uses.
      assert.notEqual(typeof content, 'string', `${name}: a user line carries loose text`);
      for (const block of content as Array<Record<string, unknown>>) {
        if (block['type'] !== 'text') continue;
        assert.equal(block['text'], '[redacted]', `${name}: a user text block was not redacted`);
      }
    }
  }
});

test('N-WP15a: every meta fixture carries the Agent tool description key', () => {
  /*
   * A shape check rather than a leak check, and it is here because the canvas
   * depends on it: a subagent node shows `description` — the `Agent` tool's
   * three-to-five-word label — in preference to the brief, because 156 px has
   * room for a label and not for a sentence. If the key were absent from the
   * meta files, every node would silently fall back to the brief and the choice
   * would never be exercised by anything.
   *
   * The value is the placeholder the sanitizer put there, which the chain test
   * below also asserts; what is pinned here is that the key is present at all,
   * on every meta fixture rather than on one of them.
   */
  const metas = fixtures.filter(([name]) => name.endsWith('.meta.json'));
  assert.ok(metas.length >= 5, 'the subagent meta fixtures are missing');
  for (const [name, raw] of metas) {
    const meta = JSON.parse(raw) as Record<string, unknown>;
    assert.ok('description' in meta, `${name} has no description key`);
    assert.equal(meta['description'], 'task placeholder', `${name} carries a real description`);
  }
});

test('the parent slice carries the bridge and nothing else from toolUseResult', () => {
  const raw = readFileSync(path.join(fixturesDir, 'subagents', 'parent-slice.jsonl'), 'utf8');
  const results = raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { toolUseResult?: Record<string, unknown> })
    .map((entry) => entry.toolUseResult)
    .filter((result): result is Record<string, unknown> => result !== undefined);

  assert.ok(results.length >= 3, 'the slice should show more than one Agent launch');
  for (const result of results) {
    // Four keys, all of them read. `isAsync` and `status` joined the list in
    // WP4b: the `Agent` tool returns at *launch* on Claude Code 2.1.263 and
    // says so with exactly these two, so a fixture without them would pin a
    // shape that no longer exists and would let the "a bridge means the agent
    // finished" bug back in. Everything else a real `toolUseResult` carries —
    // `prompt`, `description`, `stdout`, `outputFile` — stays out of the
    // fixture entirely.
    assert.deepEqual(
      Object.keys(result).sort(),
      ['agentId', 'isAsync', 'resolvedModel', 'status'],
      'a real toolUseResult also carries prompt, description, stdout and the rest; none of it belongs here',
    );
    assert.equal(result['isAsync'], true);
    assert.equal(result['status'], 'async_launched');
  }
  const models = new Set(results.map((result) => result['resolvedModel']));
  assert.ok(models.size > 1, 'the slice should prove the model is per agent, not per session');
});

test('the subagent slice is a sidechain and names its agent on every line', () => {
  const raw = readFileSync(
    path.join(fixturesDir, 'subagents', 'agent-a0000000000000006.jsonl'),
    'utf8',
  );
  const lines = raw.split('\n').filter((line) => line.length > 0);
  assert.ok(lines.length >= 20, 'the slice needs enough lines to exercise the tailer');

  for (const line of lines) {
    const entry = JSON.parse(line) as { agentId?: string; isSidechain?: boolean; sessionId?: string };
    assert.equal(entry.agentId, 'a0000000000000006');
    assert.equal(entry.isSidechain, true);
    // The real files record the parent session's uuid here, not the file name.
    assert.equal(entry.sessionId, '00000000-0000-4000-8000-000000000005');
  }
});

test('the subagent meta fixtures form a closed depth 1..3 chain', () => {
  const dir = path.join(fixturesDir, 'subagents');
  const metas = readdirSync(dir)
    .filter((f) => f.endsWith('.meta.json'))
    .map((f) => ({
      id: f.slice('agent-'.length, -'.meta.json'.length),
      ...(JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as {
        spawnDepth: number;
        parentAgentId?: string;
        description: string;
      }),
    }));

  const ids = new Set(metas.map((m) => m.id));
  assert.deepEqual(
    [...new Set(metas.map((m) => m.spawnDepth))].sort((a, b) => a - b),
    [1, 2, 3],
    'the chain should span depth 1 to 3',
  );

  for (const meta of metas) {
    assert.equal(meta.description, 'task placeholder', `${meta.id} kept its real description`);
    if (meta.parentAgentId === undefined || meta.parentAgentId === '') {
      assert.equal(meta.spawnDepth, 1, `${meta.id} has no parent but is not depth 1`);
    } else {
      assert.ok(ids.has(meta.parentAgentId), `${meta.id} points at a parent that is not in the fixture set`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * WP3'/WP5: the two sources under `~/.nazar`
 * ------------------------------------------------------------------ */

test('limits.sample.json is the sample nazar-tray publishes, unedited', () => {
  const raw = readFileSync(path.join(fixturesDir, 'limits.sample.json'), 'utf8');
  const document = JSON.parse(raw) as {
    schemaVersion: number;
    providers: Record<string, { configured: boolean; windows?: Record<string, unknown> }>;
  };

  // The contract asks consumers to copy this file rather than hand-write one,
  // so the point of the fixture is that it is *theirs*. Three properties make
  // it worth having: both providers, a model-scoped weekly that only the opt-in
  // detailed mode can produce, and a version to pin.
  assert.equal(document.schemaVersion, 1);
  assert.deepEqual(Object.keys(document.providers).sort(), ['claude', 'codex']);
  assert.ok('seven_day_fable' in (document.providers['claude']?.windows ?? {}));
  assert.ok('secondary' in (document.providers['codex']?.windows ?? {}));
});

test('every capture fixture is a version-1 envelope around a whole payload', () => {
  const captures = fixtures.filter(([name]) => name.startsWith('statusline-captures/'));
  assert.ok(captures.length >= 3, 'the capture reader needs more than one shape to read');

  for (const [name, raw] of captures) {
    if (name.endsWith('chain.json')) continue;
    const envelope = JSON.parse(raw) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(envelope).sort(),
      ['payload', 'schemaVersion', 'sessionId', 'updatedAt', 'wrapper'],
      `${name}: the envelope is four fields plus the payload`,
    );
    assert.equal(envelope['schemaVersion'], 1, name);
    // The file name **is** the session id. A wrapper writing one fixed path
    // would have concurrent sessions overwrite each other, which is the
    // mistake the WP0 audit found in the prototype this replaced.
    assert.equal(`statusline-captures/${String(envelope['sessionId'])}.json`, name);
  }
});

test('a capture fixture still carries the paths the parser must not read', () => {
  // The fixture would be useless as a leak test if it had been sanitized down
  // to the fields Nazar keeps: the whole risk is that the payload carries more
  // than that, and it has to go on carrying more than that.
  const raw = readFileSync(
    path.join(fixturesDir, 'statusline-captures', '00000000-0000-4000-8000-000000000001.json'),
    'utf8',
  );
  const payload = (JSON.parse(raw) as { payload: Record<string, unknown> }).payload;
  for (const key of ['cwd', 'transcript_path', 'scratchpad_dir', 'workspace', 'session_name']) {
    assert.ok(key in payload, `the fixture lost ${key}, which is what makes it a leak test`);
  }
});

test('the capture fixtures cover the three shapes the reader has to survive', () => {
  const read = (name: string): Record<string, unknown> =>
    JSON.parse(
      readFileSync(path.join(fixturesDir, 'statusline-captures', name), 'utf8'),
    ) as Record<string, unknown>;

  // One real capture with only `seven_day` — Claude Code drops a window once
  // its reset has passed, and that is what a live payload looks like.
  const one = read('00000000-0000-4000-8000-000000000001.json').payload as Record<string, unknown>;
  assert.deepEqual(Object.keys(one['rate_limits'] as object), ['seven_day']);

  // One with both windows, which the first cannot exercise.
  const two = read('00000000-0000-4000-8000-000000000002.json').payload as Record<string, unknown>;
  assert.deepEqual(Object.keys(two['rate_limits'] as object).sort(), ['five_hour', 'seven_day']);

  // And one with no cost, no context window and no rate limits at all: the
  // fields are optional, and "absent" has to be a shape the reader has seen.
  const three = read('00000000-0000-4000-8000-000000000003.json').payload as Record<string, unknown>;
  for (const key of ['cost', 'context_window', 'rate_limits']) {
    assert.equal(key in three, false, `the missing-fields fixture should not carry ${key}`);
  }
});
