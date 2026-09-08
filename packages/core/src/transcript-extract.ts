/**
 * WP2: the metadata-only transcript extractor.
 *
 * This file is the privacy boundary. A transcript line carries the prompt, the
 * model's reasoning, tool inputs, tool results, file contents, the working
 * directory and the git branch. Nazar draws a canvas of *how much* and *how
 * long*, never *what*, so the extractor does not filter a parsed line: it
 * builds a new object from a closed list of fields and lets everything else
 * fall on the floor with the parse result.
 *
 * The list, verified against 49,936 assistant lines and 480 transcripts on the
 * maintainer's machine (Claude Code 2.1.263):
 *
 *   type · timestamp · uuid · parentUuid · sessionId · agentId · isSidechain ·
 *   requestId · apiBlockIndex · effort · message.id · message.model ·
 *   message.role · message.usage.{input_tokens, output_tokens,
 *   cache_creation_input_tokens, cache_read_input_tokens} ·
 *   the `name` of `tool_use` content blocks ·
 *   toolUseResult.{agentId, resolvedModel} and its duration-like numbers
 *
 * Everything else is dropped at parse time, in particular every `text`,
 * `thinking`, `input`, `content`, `tool_result`, `prompt` and `description`
 * string. `test/transcript-extract.test.ts` feeds a line whose every text field
 * holds a sentinel and asserts the sentinel reaches neither the events nor the
 * `JSON.stringify` of the accumulated state.
 *
 * One string does leave by design: a **tool name**. It is the only content-block
 * field the hover card shows, and the leak test keeps a real tool name in the
 * poisoned line precisely so the exception stays visible.
 */

/**
 * Longest string the extractor will carry out of a line. Every field it reads
 * is an id, a model name, an ISO timestamp or a tool name; none of them is
 * close to this. A longer value means the field is not what we think it is, so
 * it is dropped rather than stored.
 */
export const MAX_EXTRACTED_STRING = 200;

/** Line types Nazar reads. Everything else, `attachment` above all, is skipped. */
export const READ_LINE_TYPES = ['assistant', 'user'] as const;

export type ReadLineType = (typeof READ_LINE_TYPES)[number];

/** The four counters, renamed to Nazar's node model. */
export interface ExtractedUsage {
  readonly in?: number;
  readonly out?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

/**
 * What a parent line says about a subagent it launched. `agentId` names the
 * `subagents/agent-<id>.jsonl` file; `resolvedModel` is the full model id
 * (`claude-opus-5[1m]`), which `meta.json` only has the shortcut for.
 *
 * `status` and `async` were added in WP4b, and they matter more than they look.
 * A `toolUseResult` reads like a *result*, so it is tempting to treat it as the
 * moment the subagent finished. On Claude Code 2.1.263 that is wrong: the
 * `Agent` tool launches asynchronously and the parent writes its tool result
 * **at launch**, carrying `status: "async_launched"`, `isAsync: true` and no
 * duration at all. Measured here: **348 of 348** bridges in the whole store are
 * that shape, and none carries a duration field. Reading them as stop events
 * marked a subagent finished while it was still writing — which is exactly the
 * failure WP4b exists to avoid.
 */
export interface ExtractedToolUseResult {
  readonly agentId?: string;
  readonly resolvedModel?: string;
  /** `totalDurationMs`, `durationMs` or `durationSeconds` normalised to ms. */
  readonly durationMs?: number;
  /** `async_launched` is the only value observed. An enum, never free text. */
  readonly status?: string;
  /** `isAsync`: the tool returned at launch, so this result is not an ending. */
  readonly async?: boolean;
}

/**
 * `status` values that mean "the tool returned before the agent did". A bridge
 * carrying one of these is a launch record and must never end an agent.
 */
export const LAUNCH_STATUSES: readonly string[] = ['async_launched'];

/** One transcript line, reduced to what Nazar is allowed to know. */
export interface TranscriptEvent {
  readonly type: ReadLineType;
  readonly timestamp?: string;
  readonly uuid?: string;
  readonly parentUuid?: string;
  readonly sessionId?: string;
  /** Present on every line of a subagent transcript (70,282 of 70,282). */
  readonly agentId?: string;
  readonly isSidechain?: boolean;
  readonly requestId?: string;
  readonly apiBlockIndex?: number;
  readonly effort?: string;
  readonly messageId?: string;
  readonly model?: string;
  readonly role?: string;
  readonly usage?: ExtractedUsage;
  /** Names of the `tool_use` blocks on this line, in order. Names only. */
  readonly toolNames?: readonly string[];
  readonly toolUseResult?: ExtractedToolUseResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A short string, or nothing. Length-capped so no body can ride out here. */
function readShortString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length === 0 || value.length > MAX_EXTRACTED_STRING) return undefined;
  return value;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readLineType(value: unknown): ReadLineType | undefined {
  return value === 'assistant' || value === 'user' ? value : undefined;
}

/** The four counters and nothing else, even though `usage` carries eleven keys. */
function readUsage(value: unknown): ExtractedUsage | undefined {
  if (!isRecord(value)) return undefined;
  const input = readFiniteNumber(value['input_tokens']);
  const output = readFiniteNumber(value['output_tokens']);
  const cacheWrite = readFiniteNumber(value['cache_creation_input_tokens']);
  const cacheRead = readFiniteNumber(value['cache_read_input_tokens']);
  if (
    input === undefined &&
    output === undefined &&
    cacheWrite === undefined &&
    cacheRead === undefined
  ) {
    return undefined;
  }
  const usage: {
    in?: number;
    out?: number;
    cacheRead?: number;
    cacheWrite?: number;
  } = {};
  if (input !== undefined) usage.in = input;
  if (output !== undefined) usage.out = output;
  if (cacheRead !== undefined) usage.cacheRead = cacheRead;
  if (cacheWrite !== undefined) usage.cacheWrite = cacheWrite;
  return usage;
}

/** `tool_use` block names, in order. No id, no input, nothing else. */
function readToolNames(content: unknown): readonly string[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const names: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block['type'] !== 'tool_use') continue;
    const name = readShortString(block['name']);
    if (name !== undefined) names.push(name);
  }
  return names.length > 0 ? names : undefined;
}

/**
 * The parent-to-subagent bridge, and nothing near it. The same object also
 * carries `prompt` (the subagent's whole brief), `description`, `stdout`,
 * `stderr`, `oldString`, `newString` and `content`; none of them is read.
 */
function readToolUseResult(value: unknown): ExtractedToolUseResult | undefined {
  if (!isRecord(value)) return undefined;
  const agentId = readShortString(value['agentId']);
  const resolvedModel = readShortString(value['resolvedModel']);
  const totalDurationMs = readFiniteNumber(value['totalDurationMs']);
  const durationMs = readFiniteNumber(value['durationMs']);
  const durationSeconds = readFiniteNumber(value['durationSeconds']);
  const duration =
    totalDurationMs ??
    durationMs ??
    (durationSeconds === undefined ? undefined : durationSeconds * 1000);
  const status = readShortString(value['status']);
  const isAsync = readBoolean(value['isAsync']);
  if (agentId === undefined && resolvedModel === undefined && duration === undefined) {
    return undefined;
  }
  const result: {
    agentId?: string;
    resolvedModel?: string;
    durationMs?: number;
    status?: string;
    async?: boolean;
  } = {};
  if (agentId !== undefined) result.agentId = agentId;
  if (resolvedModel !== undefined) result.resolvedModel = resolvedModel;
  if (duration !== undefined) result.durationMs = duration;
  if (status !== undefined) result.status = status;
  if (isAsync !== undefined) result.async = isAsync;
  return result;
}

/**
 * Did this `toolUseResult` mean the subagent *ended*?
 *
 * An asynchronous launch says so in two ways and either is enough. Anything
 * else — including the shape older Claude Code wrote, which has neither key —
 * is a real result and does end the agent.
 */
export function isCompletionResult(result: ExtractedToolUseResult): boolean {
  if (result.async === true) return false;
  if (result.status !== undefined && LAUNCH_STATUSES.includes(result.status)) return false;
  return true;
}

/**
 * Parse one JSONL line into a `TranscriptEvent`, or `undefined` when the line
 * is not JSON, not an object, or not a type we read. Never throws.
 */
export function extractTranscriptLine(raw: string): TranscriptEvent | undefined {
  if (raw.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return extractTranscriptRecord(parsed);
}

/** The same, for a value that has already been parsed. */
export function extractTranscriptRecord(parsed: unknown): TranscriptEvent | undefined {
  if (!isRecord(parsed)) return undefined;
  const type = readLineType(parsed['type']);
  if (type === undefined) return undefined;

  const message = isRecord(parsed['message']) ? parsed['message'] : undefined;

  const event: {
    -readonly [K in keyof TranscriptEvent]: TranscriptEvent[K];
  } = { type };

  const timestamp = readShortString(parsed['timestamp']);
  if (timestamp !== undefined) event.timestamp = timestamp;
  const uuid = readShortString(parsed['uuid']);
  if (uuid !== undefined) event.uuid = uuid;
  const parentUuid = readShortString(parsed['parentUuid']);
  if (parentUuid !== undefined) event.parentUuid = parentUuid;
  const sessionId = readShortString(parsed['sessionId']);
  if (sessionId !== undefined) event.sessionId = sessionId;
  const agentId = readShortString(parsed['agentId']);
  if (agentId !== undefined) event.agentId = agentId;
  const isSidechain = readBoolean(parsed['isSidechain']);
  if (isSidechain !== undefined) event.isSidechain = isSidechain;
  const requestId = readShortString(parsed['requestId']);
  if (requestId !== undefined) event.requestId = requestId;
  const apiBlockIndex = readFiniteNumber(parsed['apiBlockIndex']);
  if (apiBlockIndex !== undefined) event.apiBlockIndex = apiBlockIndex;
  const effort = readShortString(parsed['effort']);
  if (effort !== undefined) event.effort = effort;

  if (message !== undefined) {
    const messageId = readShortString(message['id']);
    if (messageId !== undefined) event.messageId = messageId;
    const model = readShortString(message['model']);
    if (model !== undefined) event.model = model;
    const role = readShortString(message['role']);
    if (role !== undefined) event.role = role;
    const usage = readUsage(message['usage']);
    if (usage !== undefined) event.usage = usage;
    const toolNames = readToolNames(message['content']);
    if (toolNames !== undefined) event.toolNames = toolNames;
  }

  const toolUseResult = readToolUseResult(parsed['toolUseResult']);
  if (toolUseResult !== undefined) event.toolUseResult = toolUseResult;

  return event;
}
