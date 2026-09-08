/**
 * The 2.08x trap.
 *
 * Claude Code writes one transcript line per content block and repeats the full
 * `usage` object on every copy. A reader that sums the lines reports more than
 * twice the real output tokens: 373,980 against 179,402 on the session measured
 * in the WP0 audit, 4799 against 1929 on the fixture slice shipped with this
 * repo. These are exact-number assertions on purpose; an approximate test would
 * not have caught the bug it exists for.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { extractTranscriptLine } from '../src/transcript-extract.ts';
import { TranscriptStats, addTotals } from '../src/transcript-stats.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', '..', '..', 'fixtures');

function statsFor(name: string): TranscriptStats {
  const stats = new TranscriptStats();
  for (const line of readFileSync(path.join(fixtures, name), 'utf8').split('\n')) {
    if (line.length === 0) continue;
    const event = extractTranscriptLine(line);
    if (event !== undefined) stats.add(event);
  }
  return stats;
}

test('the shipped slice: 11 assistant lines, 5 messages, 4799 naive against 1929 real', () => {
  const stats = statsFor('transcript-slice.jsonl');

  assert.equal(stats.assistantLineCount, 11);
  assert.equal(stats.uniqueMessageCount, 5);
  assert.equal(stats.dedupeFallbacks, 0);

  assert.deepEqual(stats.naiveTokens, { in: 262, out: 4799, cacheRead: 601297, cacheWrite: 132637 });
  assert.deepEqual(stats.tokens, { in: 130, out: 1929, cacheRead: 288511, cacheWrite: 46129 });

  const naive = stats.naiveTokens as { out: number };
  const real = stats.tokens as { out: number };
  assert.equal((naive.out / real.out).toFixed(2), '2.49', 'the inflation factor of the slice');
});

test('the parent slice inflates 2.38x and the subagent slice 1.04x', () => {
  const parent = statsFor('subagents/parent-slice.jsonl');
  assert.equal(parent.assistantLineCount, 22);
  assert.equal(parent.uniqueMessageCount, 10);
  assert.deepEqual(parent.tokens, { in: 663, out: 17371, cacheRead: 1100486, cacheWrite: 21031 });
  assert.deepEqual(parent.naiveTokens, {
    in: 1429,
    out: 41411,
    cacheRead: 2438295,
    cacheWrite: 47253,
  });

  // A subagent that mostly answers in one block inflates far less, which is
  // exactly why the factor cannot be a constant applied after the fact.
  const agent = statsFor('subagents/agent-a0000000000000006.jsonl');
  assert.equal(agent.assistantLineCount, 16);
  assert.equal(agent.uniqueMessageCount, 6);
  assert.deepEqual(agent.tokens, { in: 12, out: 1100, cacheRead: 224527, cacheWrite: 21591 });
  assert.deepEqual(agent.naiveTokens, { in: 32, out: 1140, cacheRead: 606580, cacheWrite: 48088 });
});

test('a session and its subagents add up without double counting', () => {
  const parent = statsFor('subagents/parent-slice.jsonl');
  const agent = statsFor('subagents/agent-a0000000000000006.jsonl');
  assert.deepEqual(addTotals(parent.tokens, agent.tokens), {
    in: 675,
    out: 18471,
    cacheRead: 1325013,
    cacheWrite: 42622,
  });
  assert.equal(addTotals(undefined, undefined), undefined, 'nothing seen shows nothing, not zero');
});

test('every copy of a key carries identical usage, so last-wins is safe', () => {
  const byKey = new Map<string, string>();
  for (const line of readFileSync(path.join(fixtures, 'transcript-slice.jsonl'), 'utf8').split('\n')) {
    if (line.length === 0) continue;
    const event = extractTranscriptLine(line);
    if (event?.type !== 'assistant' || event.usage === undefined) continue;
    const key = `${event.messageId ?? ''} ${event.requestId ?? ''}`;
    const usage = JSON.stringify(event.usage);
    const seen = byKey.get(key);
    if (seen === undefined) byKey.set(key, usage);
    else assert.equal(usage, seen, `copies of ${key} disagree, so "last wins" would be a guess`);
  }
  assert.equal(byKey.size, 5);
});

test('a line without a requestId falls back to message.id and is counted', () => {
  const stats = new TranscriptStats();
  const line = (extra: Record<string, unknown>): string =>
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-07T00:00:00.000Z',
      message: {
        id: 'msg_000000000000000000000001',
        model: 'claude-opus-5',
        role: 'assistant',
        usage: { input_tokens: 1, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      ...extra,
    });

  stats.add(extractTranscriptLine(line({})) as never);
  stats.add(extractTranscriptLine(line({})) as never);
  assert.equal(stats.dedupeFallbacks, 2, 'both lines took the fallback path');
  assert.equal(stats.uniqueMessageCount, 1, 'and they still deduplicate against each other');
  assert.equal((stats.tokens as { out: number }).out, 10);

  // The same message id under two request ids is two API calls, not one.
  stats.add(extractTranscriptLine(line({ requestId: 'req_000000000000000000000001' })) as never);
  assert.equal(stats.uniqueMessageCount, 2);
  assert.equal((stats.tokens as { out: number }).out, 20);
  assert.equal(stats.dedupeFallbacks, 2);
});

test('model, effort and current tool are the last ones seen', () => {
  const stats = statsFor('subagents/parent-slice.jsonl');
  assert.equal(stats.model, 'claude-fable-5-1');
  assert.equal(stats.effort, 'xhigh');
  // The slice ends on an `Agent` launch, which is what the session is doing.
  assert.equal(stats.currentTool, 'Agent');
  assert.equal(stats.toolCalls, 10);
  assert.equal(stats.startedAt, Date.parse('2026-09-03T22:21:22.453Z'));
  assert.equal(stats.lastEventAt, Date.parse('2026-09-03T23:12:22.298Z'));
});

test('the current tool clears when the latest assistant line is not a tool call', () => {
  const stats = new TranscriptStats();
  const assistant = (content: unknown, id: string): string =>
    JSON.stringify({
      type: 'assistant',
      message: { id, role: 'assistant', content, usage: { output_tokens: 1 } },
      requestId: 'req_000000000000000000000001',
    });

  stats.add(extractTranscriptLine(assistant([{ type: 'tool_use', name: 'Bash' }], 'msg_1')) as never);
  assert.equal(stats.currentTool, 'Bash');
  stats.add(extractTranscriptLine(assistant([{ type: 'text', text: '[redacted]' }], 'msg_2')) as never);
  assert.equal(stats.currentTool, undefined, 'a message that ends in text is not running a tool');
  assert.equal(stats.toolCalls, 1);
});

test('reset throws the whole file away, which is what a truncation means', () => {
  const stats = statsFor('transcript-slice.jsonl');
  assert.notEqual(stats.tokens, undefined);
  stats.reset();
  assert.equal(stats.tokens, undefined);
  assert.equal(stats.naiveTokens, undefined);
  assert.equal(stats.uniqueMessageCount, 0);
  assert.equal(stats.currentTool, undefined);
  assert.equal(stats.model, undefined);
});

test('bridges are collected from user lines, keyed by agent id', () => {
  const stats = statsFor('subagents/parent-slice.jsonl');
  assert.equal(stats.agentBridges.size, 3);
  // `completed: false` is the whole point of the WP4b correction: on Claude
  // Code 2.1.263 the `Agent` tool returns at *launch*, so a bridge supplies the
  // full model id — what WP2 wanted it for — and says nothing whatever about
  // whether the subagent has finished.
  assert.deepEqual(stats.agentBridges.get('a0000000000000005'), {
    modelId: 'claude-haiku-4-5-20251001',
    completed: false,
    status: 'async_launched',
  });
  assert.deepEqual(stats.agentBridges.get('a0000000000000006'), {
    modelId: 'claude-opus-5[1m]',
    completed: false,
    status: 'async_launched',
  });
});

test('a real ending is never overwritten by a launch record arriving after it', () => {
  const stats = new TranscriptStats();
  const line = (result: Record<string, unknown>): void => {
    const event = extractTranscriptLine(JSON.stringify({ type: 'user', toolUseResult: result }));
    if (event !== undefined) stats.add(event);
  };
  line({ agentId: 'a1', resolvedModel: 'claude-opus-5[1m]', totalDurationMs: 5000 });
  line({ agentId: 'a1', resolvedModel: 'claude-opus-5[1m]', isAsync: true, status: 'async_launched' });
  assert.equal(stats.agentBridges.get('a1')?.completed, true);
});

/**
 * A cache read is the whole prompt prefix being re-read, once per API request.
 * That makes `cacheRead` a running sum of *context sizes*, so it lands orders
 * of magnitude above the other three counters and looks, to anyone reading the
 * hover card, exactly like a double-count.
 *
 * This pins the property that says it is not one: the deduplicated total is the
 * sum of one `cache_read_input_tokens` per unique `(message.id, requestId)`,
 * with nothing added per line. It was written after a live report of 90.3 M
 * cache-read tokens on a 25-hour session; the recount there gave 96.2 M over
 * 294 requests at a median context of 335 K, and Claude Code's own status-line
 * capture for that session independently agreed on the request count and on
 * cache-write tokens to within 0.1%. The number was right.
 */
test('cache reads are counted once per request, not once per line', () => {
  for (const name of ['transcript-slice.jsonl', 'subagents/parent-slice.jsonl']) {
    const perRequest = new Map<string, number>();
    let lines = 0;
    for (const raw of readFileSync(path.join(fixtures, name), 'utf8').split('\n')) {
      if (raw.length === 0) continue;
      const parsed = JSON.parse(raw) as {
        type?: string;
        requestId?: string;
        message?: { id?: string; usage?: { cache_read_input_tokens?: number } };
      };
      if (parsed.type !== 'assistant') continue;
      const id = parsed.message?.id;
      const usage = parsed.message?.usage;
      if (id === undefined || usage === undefined) continue;
      lines += 1;
      // Last writer wins, exactly as TranscriptStats does.
      perRequest.set(`${id} ${parsed.requestId ?? ''}`, usage.cache_read_input_tokens ?? 0);
    }

    const stats = statsFor(name);
    const summed = [...perRequest.values()].reduce((total, value) => total + value, 0);

    assert.equal(perRequest.size, stats.uniqueMessageCount, `${name}: request count`);
    assert.equal(stats.tokens?.cacheRead, summed, `${name}: one cache read per request`);
    assert.ok(lines > perRequest.size, `${name}: the fixture must actually repeat lines`);
    // The naive reader is the one that inflates it, and by how much is the point.
    assert.ok(
      (stats.naiveTokens?.cacheRead ?? 0) > summed,
      `${name}: summing lines must be visibly larger`,
    );
  }
});
