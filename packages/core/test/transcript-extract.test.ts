/**
 * The extractor, and the leak gate.
 *
 * Nazar's whole claim is "metadata only, never prompt or response text"
 * (docs/PROJECT.md section 2). This file is where that claim is enforced: a
 * transcript line whose every free-text field carries a sentinel is fed
 * through the parser, the accumulator and the tree builder, and the sentinel
 * must not survive anywhere — not in an event, not in the token state, not in
 * the rendered tree.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildAgentTree } from '../src/agent-tree.ts';
import { parseAgentMeta } from '../src/subagent-meta.ts';
import {
  extractTranscriptLine,
  isCompletionResult,
  LAUNCH_STATUSES,
  MAX_EXTRACTED_STRING,
  type ExtractedToolUseResult,
} from '../src/transcript-extract.ts';
import { TranscriptStats } from '../src/transcript-stats.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', '..', '..', 'fixtures');

const SENTINEL = 'LEAK-SENTINEL-7f3a';

function fixtureLines(name: string): string[] {
  return readFileSync(path.join(fixtures, name), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
}

test('an assistant line yields exactly the pinned field set', () => {
  const line = fixtureLines('subagents/agent-a0000000000000006.jsonl')[1] as string;
  const event = extractTranscriptLine(line);
  assert.ok(event !== undefined);

  assert.equal(event.type, 'assistant');
  assert.equal(event.agentId, 'a0000000000000006');
  assert.equal(event.isSidechain, true);
  assert.equal(event.sessionId, '00000000-0000-4000-8000-000000000005');
  assert.equal(event.model, 'claude-opus-5');
  assert.equal(event.role, 'assistant');
  assert.equal(event.effort, 'xhigh');
  assert.equal(event.apiBlockIndex, 0);
  assert.ok(event.messageId?.startsWith('msg_'));
  assert.ok(event.requestId?.startsWith('req_'));
  assert.deepEqual(event.usage, { in: 2, out: 1, cacheRead: 24241, cacheWrite: 12275 });

  // The field set is closed. A new key in the transcript must not appear here
  // by accident; it has to be added to the list on purpose.
  assert.deepEqual(
    Object.keys(event).sort(),
    [
      'agentId',
      'apiBlockIndex',
      'effort',
      'isSidechain',
      'messageId',
      'model',
      'parentUuid',
      'requestId',
      'role',
      'sessionId',
      'timestamp',
      'type',
      'usage',
      'uuid',
    ].sort(),
  );
});

test('tool_use blocks give up their name and nothing else', () => {
  const line = fixtureLines('subagents/agent-a0000000000000006.jsonl')[2] as string;
  const event = extractTranscriptLine(line);
  assert.deepEqual(event?.toolNames, ['ToolSearch']);
});

test('a parent tool result yields the bridge, not the body', () => {
  const bridges = fixtureLines('subagents/parent-slice.jsonl')
    .map((line) => extractTranscriptLine(line))
    .filter((event) => event?.toolUseResult !== undefined);

  assert.equal(bridges.length, 3);
  assert.deepEqual(bridges[0]?.toolUseResult, {
    agentId: 'a0000000000000005',
    resolvedModel: 'claude-haiku-4-5-20251001',
    status: 'async_launched',
    async: true,
  });
  assert.deepEqual(bridges[1]?.toolUseResult, {
    agentId: 'a0000000000000006',
    resolvedModel: 'claude-opus-5[1m]',
    status: 'async_launched',
    async: true,
  });
});

test('an asynchronous launch is not a completion, and the older shape is', () => {
  // The trap WP4b walked into: the `Agent` tool returns at launch on Claude
  // Code 2.1.263 and writes its tool result there. All 348 bridges in the
  // store on the maintainer's machine are that shape, with no duration on any
  // of them, so a reader that treats a bridge as an ending marks a subagent
  // finished while it is still writing.
  for (const line of fixtureLines('subagents/parent-slice.jsonl')) {
    const result = extractTranscriptLine(line)?.toolUseResult;
    if (result === undefined) continue;
    assert.equal(isCompletionResult(result), false, 'an async launch must not end an agent');
  }

  // The synchronous shape has neither key and does end the agent, which is
  // what a Claude Code that waits for the tool would write.
  const synchronous = extractTranscriptLine(
    JSON.stringify({
      type: 'user',
      toolUseResult: {
        agentId: 'a0000000000000009',
        resolvedModel: 'claude-opus-5[1m]',
        totalDurationMs: 91_000,
      },
    }),
  )?.toolUseResult;
  assert.deepEqual(synchronous, {
    agentId: 'a0000000000000009',
    resolvedModel: 'claude-opus-5[1m]',
    durationMs: 91_000,
  });
  assert.equal(isCompletionResult(synchronous as ExtractedToolUseResult), true);

  // A status nobody has seen is treated as a real result rather than silently
  // ignored; only the launch statuses we have actually observed are excluded.
  assert.equal(isCompletionResult({ agentId: 'a1', status: 'completed' }), true);
  assert.equal(isCompletionResult({ agentId: 'a1', status: 'async_launched' }), false);
  assert.equal(isCompletionResult({ agentId: 'a1', async: true }), false);
  assert.deepEqual(LAUNCH_STATUSES, ['async_launched']);
});

test('line types other than assistant and user are skipped whole', () => {
  for (const type of ['attachment', 'summary', 'system', 'file-history-snapshot', 'ai-title']) {
    const line = JSON.stringify({ type, uuid: 'u', message: { id: 'msg_1', usage: { output_tokens: 9 } } });
    assert.equal(extractTranscriptLine(line), undefined, `${type} must not be read`);
  }
});

test('malformed input never throws', () => {
  for (const line of ['', '{', 'null', '[]', '"a string"', '{"type":"assistant"', '{"type":42}']) {
    assert.doesNotThrow(() => extractTranscriptLine(line));
  }
  assert.equal(extractTranscriptLine('{"type":"assistant"}')?.type, 'assistant');
});

test('a string longer than the cap is not an id and is dropped', () => {
  const long = 'x'.repeat(MAX_EXTRACTED_STRING + 1);
  const event = extractTranscriptLine(
    JSON.stringify({ type: 'assistant', uuid: long, sessionId: long, message: { model: long, id: 'msg_1' } }),
  );
  assert.equal(event?.uuid, undefined);
  assert.equal(event?.sessionId, undefined);
  assert.equal(event?.model, undefined);
  assert.equal(event?.messageId, 'msg_1');
});

/**
 * The poisoned line: every free-text field a real transcript carries, filled
 * with the sentinel. Tool **names** are the one string the extractor is allowed
 * to keep, so this line keeps a real tool name — the exception has to stay
 * visible rather than be hidden by the test data.
 */
function poisonedLine(type: 'assistant' | 'user'): string {
  return JSON.stringify({
    type,
    timestamp: '2026-09-07T00:00:00.000Z',
    uuid: '00000000-0000-4000-8000-000000009001',
    parentUuid: '00000000-0000-4000-8000-000000009000',
    sessionId: '00000000-0000-4000-8000-000000000005',
    agentId: 'a0000000000000006',
    isSidechain: true,
    requestId: 'req_000000000000000000009001',
    apiBlockIndex: 0,
    effort: 'xhigh',
    cwd: `C:/${SENTINEL}`,
    gitBranch: SENTINEL,
    userType: SENTINEL,
    aiTitle: SENTINEL,
    lastPrompt: SENTINEL,
    slug: SENTINEL,
    hookAdditionalContext: SENTINEL,
    attachment: { content: SENTINEL },
    message: {
      id: 'msg_000000000000000000009001',
      model: 'claude-opus-5',
      role: type,
      stop_reason: SENTINEL,
      diagnostics: [SENTINEL],
      content: [
        { type: 'thinking', thinking: SENTINEL, signature: SENTINEL },
        { type: 'text', text: SENTINEL },
        { type: 'tool_use', name: 'Bash', id: SENTINEL, input: { command: SENTINEL, file_path: SENTINEL } },
        { type: 'tool_result', content: SENTINEL, is_error: false },
      ],
      usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 },
    },
    toolUseResult: {
      agentId: 'a0000000000000006',
      resolvedModel: 'claude-opus-5[1m]',
      durationMs: 1234,
      prompt: SENTINEL,
      description: SENTINEL,
      stdout: SENTINEL,
      stderr: SENTINEL,
      content: SENTINEL,
      filePath: `C:/${SENTINEL}`,
      oldString: SENTINEL,
      newString: SENTINEL,
      originalFile: SENTINEL,
      structuredPatch: [{ lines: [SENTINEL] }],
      outputFile: `C:/${SENTINEL}`,
    },
  });
}

test('the sentinel survives nowhere: events, token state, or tree', () => {
  const stats = new TranscriptStats();
  const events = [];

  // A real fixture plus the poisoned lines, exactly as the tailer would feed
  // them: the extractor must not behave differently for either.
  for (const line of [
    ...fixtureLines('transcript-slice.jsonl'),
    ...fixtureLines('subagents/agent-a0000000000000006.jsonl'),
    poisonedLine('assistant'),
    poisonedLine('user'),
  ]) {
    const event = extractTranscriptLine(line);
    if (event === undefined) continue;
    events.push(event);
    stats.add(event);
  }

  assert.ok(events.length > 40, 'the fixtures should have produced events to check');

  for (const event of events) {
    assert.equal(
      JSON.stringify(event).includes(SENTINEL),
      false,
      `an event carried the sentinel: ${JSON.stringify(event)}`,
    );
  }

  // A `description` written by a person is capped, so a long one is dropped
  // whole. This is the meta.json field the pinned document keeps in the
  // "not read" table, and it must not reach the tree either.
  const meta = parseAgentMeta(
    'agent-a0000000000000006.meta.json',
    JSON.stringify({
      agentType: 'general-purpose',
      model: 'opus',
      spawnDepth: 1,
      toolUseId: 'toolu_000000000000000000000006',
      description: `${SENTINEL} `.repeat(20),
    }),
  );
  assert.ok(meta !== undefined);
  assert.equal(meta.description, undefined, 'an over-long description is dropped, not truncated');

  const tree = buildAgentTree({
    sessionId: '00000000-0000-4000-8000-000000000005',
    metas: [meta],
    activity: new Map([
      [
        meta.id,
        {
          tokens: stats.tokens as { in: number; out: number; cacheRead: number; cacheWrite: number },
          effort: stats.effort as string,
          currentTool: stats.currentTool as string,
          toolCalls: stats.toolCalls,
        },
      ],
    ]),
    bridges: stats.agentBridges,
    now: 1_788_800_000_000,
  });

  const wholeState = JSON.stringify({
    events,
    tokens: stats.tokens,
    naive: stats.naiveTokens,
    model: stats.model,
    effort: stats.effort,
    currentTool: stats.currentTool,
    toolCalls: stats.toolCalls,
    uniqueMessages: stats.uniqueMessageCount,
    dedupeFallbacks: stats.dedupeFallbacks,
    bridges: [...stats.agentBridges],
    agents: tree.agents,
    roots: tree.roots,
    metas: [meta],
  });

  assert.equal(wholeState.includes(SENTINEL), false, 'the sentinel reached the serialised state');
  // And the one string that is allowed through is still there, so the test is
  // proving a filter rather than an empty object.
  assert.ok(wholeState.includes('"Bash"'), 'tool names are read on purpose and must survive');
  assert.ok(wholeState.includes('claude-opus-5[1m]'), 'the resolved model must survive');
});

test('a short description is kept for the hover card', () => {
  const meta = parseAgentMeta(
    'agent-a0000000000000006.meta.json',
    JSON.stringify({ agentType: 'general-purpose', spawnDepth: 1, description: 'task placeholder' }),
  );
  assert.equal(meta?.description, 'task placeholder');
});
