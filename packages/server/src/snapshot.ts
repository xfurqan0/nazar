/**
 * Core state to wire payload.
 *
 * The canvas is served a *whole* snapshot every time, so this function runs on
 * every SSE frame and has to stay allocation-cheap and total: no throwing on a
 * shape it has not seen, no field invented when a source did not fill it.
 *
 * What it removes, and why:
 *
 * - `agent.description` — user-authored prose from `meta.json`. The hover card
 *   specified for v1 does not show it, so it does not leave the process.
 * - `agent.toolUseId` — an id the canvas has no use for; the tree is keyed on
 *   `agent.id`.
 * - the head of `cwd` and `name` — the only free-form strings that survive, and
 *   the only two that can hold a path or a credential. Both go through
 *   `redact()`.
 *
 * There is no command string on this wire at all: `tool_input` is dropped at
 * parse time in `@nazar/core`, so the strongest statement about commands is
 * that none of them ever reaches here. The redaction is still applied to the
 * two path-shaped fields, because a working directory is a path.
 */
import type {
  Agent,
  AgentNode,
  History,
  HistoryListPage,
  HistorySummary,
  Quota,
  QuotaProvider,
  QuotaWindow,
  SessionContextWindow,
  SessionTokens,
  SessionView,
  StateSnapshot,
} from '@nazar/core';

import type { RedactOptions } from './redact.js';
import { redact } from './redact.js';

/** Longest identifier-shaped value that reaches the browser. */
export const MAX_WIRE_STRING = 80;

/**
 * Cut an enum-shaped value (`model`, `effort`, `kind`, a tool name) to length.
 * These never hold a path, so they are not swept for secrets: the sweep would
 * mangle a legitimate name such as `token-counter` for no gain.
 */
function clip(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= MAX_WIRE_STRING ? value : `${value.slice(0, MAX_WIRE_STRING)}…`;
}

function copyTokens(tokens: SessionTokens | undefined): SessionTokens | undefined {
  if (tokens === undefined) return undefined;
  const out: { in?: number; out?: number; cacheRead?: number; cacheWrite?: number } = {};
  if (tokens.in !== undefined) out.in = tokens.in;
  if (tokens.out !== undefined) out.out = tokens.out;
  if (tokens.cacheRead !== undefined) out.cacheRead = tokens.cacheRead;
  if (tokens.cacheWrite !== undefined) out.cacheWrite = tokens.cacheWrite;
  return out;
}

/** One subagent, with the two dropped fields gone and the rest length-capped. */
export function toWireAgent(agent: Agent): Agent {
  const out: {
    -readonly [K in keyof Agent]: Agent[K];
  } = {
    id: agent.id,
    sessionId: agent.sessionId,
    spawnDepth: agent.spawnDepth,
    agentType: clip(agent.agentType) ?? agent.agentType,
    state: agent.state,
  };

  if (agent.parentAgentId !== undefined) out.parentAgentId = agent.parentAgentId;
  if (agent.model !== undefined) out.model = clip(agent.model);
  if (agent.modelId !== undefined) out.modelId = clip(agent.modelId);
  if (agent.workflowRunId !== undefined) out.workflowRunId = agent.workflowRunId;
  if (agent.orphan !== undefined) out.orphan = agent.orphan;
  if (agent.startedAt !== undefined) out.startedAt = agent.startedAt;
  if (agent.endedAt !== undefined) out.endedAt = agent.endedAt;
  if (agent.durationMs !== undefined) out.durationMs = agent.durationMs;
  if (agent.toolCalls !== undefined) out.toolCalls = agent.toolCalls;
  if (agent.effort !== undefined) out.effort = clip(agent.effort);
  const tokens = copyTokens(agent.tokens);
  if (tokens !== undefined) out.tokens = tokens;
  if (agent.currentTool !== undefined) out.currentTool = clip(agent.currentTool);
  if (agent.lastWriteAt !== undefined) out.lastWriteAt = agent.lastWriteAt;
  if (agent.writeAgeMs !== undefined) out.writeAgeMs = agent.writeAgeMs;
  if (agent.doneSignal !== undefined) out.doneSignal = agent.doneSignal;

  return out;
}

function toWireNode(node: AgentNode): AgentNode {
  return { agent: toWireAgent(node.agent), children: node.children.map(toWireNode) };
}

/** One session, redacted. `agents` and `roots` carry the same sanitized set. */
export function toWireSession(session: SessionView, options?: RedactOptions): SessionView {
  const out: {
    -readonly [K in keyof SessionView]: SessionView[K];
  } = {
    id: session.id,
    provider: session.provider,
    pid: session.pid,
    status: session.status,
    state: session.state,
    source: session.source,
    lastSeenAt: session.lastSeenAt,
    agents: session.agents.map(toWireAgent),
    roots: session.roots.map(toWireNode),
    orphans: [...session.orphans],
    treeRead: session.treeRead,
  };

  // The two free-form fields: a real path, and a name a user may have typed.
  if (session.cwd !== undefined) out.cwd = redact(session.cwd, options);
  if (session.name !== undefined) out.name = redact(session.name, options);

  if (session.kind !== undefined) out.kind = clip(session.kind);
  if (session.waitingFor !== undefined) out.waitingFor = clip(session.waitingFor);
  if (session.model !== undefined) out.model = clip(session.model);
  if (session.effort !== undefined) out.effort = clip(session.effort);
  if (session.version !== undefined) out.version = clip(session.version);
  if (session.startedAt !== undefined) out.startedAt = session.startedAt;
  if (session.lastWriteAt !== undefined) out.lastWriteAt = session.lastWriteAt;
  if (session.statusUpdatedAt !== undefined) out.statusUpdatedAt = session.statusUpdatedAt;
  if (session.currentTool !== undefined) out.currentTool = clip(session.currentTool);
  if (session.toolCalls !== undefined) out.toolCalls = session.toolCalls;
  if (session.transcriptAt !== undefined) out.transcriptAt = session.transcriptAt;
  if (session.writeAgeMs !== undefined) out.writeAgeMs = session.writeAgeMs;

  const tokens = copyTokens(session.tokens);
  if (tokens !== undefined) out.tokens = tokens;
  const treeTokens = copyTokens(session.treeTokens);
  if (treeTokens !== undefined) out.treeTokens = treeTokens;

  // WP3'. Present only when a status-line capture named this session; absent,
  // never zero, on a machine without the wrapper.
  const contextWindow = copyContextWindow(session.contextWindow);
  if (contextWindow !== undefined) out.contextWindow = contextWindow;
  if (session.costUsd !== undefined) out.costUsd = session.costUsd;
  if (session.capturedAt !== undefined) out.capturedAt = session.capturedAt;

  /*
   * WP4f. A closed enum and nothing else: the *reason* crosses the wire, the
   * evidence does not. The settings file that produced this verdict is a path
   * inside the user's project, and the canvas has no use for it — `nazar
   * doctor` prints it, in the user's own terminal, where it belongs.
   */
  if (session.captureBlockedBy !== undefined) out.captureBlockedBy = session.captureBlockedBy;

  return out;
}

/** The three numbers, copied by name so nothing else can ride along. */
function copyContextWindow(
  window: SessionContextWindow | undefined,
): SessionContextWindow | undefined {
  if (window === undefined) return undefined;
  const out: { used?: number; size?: number; percent?: number } = {};
  if (window.used !== undefined) out.used = window.used;
  if (window.size !== undefined) out.size = window.size;
  if (window.percent !== undefined) out.percent = window.percent;
  return out;
}

/* ------------------------------------------------------------------ *
 * WP5: the quota strip
 * ------------------------------------------------------------------ */

/**
 * One window, field by field.
 *
 * `limits.json` is written to be safe to paste into a bug report — no tokens,
 * no account ids, no paths — so there is nothing here to redact. It is still
 * copied by name rather than spread: the file has one writer today and the
 * rebuild-by-name rule is what keeps a field a future writer adds from
 * reaching a browser before anyone has looked at it.
 */
export function toWireQuotaWindow(window: QuotaWindow): QuotaWindow {
  const out: { -readonly [K in keyof QuotaWindow]: QuotaWindow[K] } = {
    key: clip(window.key) ?? window.key,
    state: clip(window.state) ?? window.state,
  };
  if (window.percent !== undefined) out.percent = window.percent;
  if (window.resetsAt !== undefined) out.resetsAt = window.resetsAt;
  if (window.windowMinutes !== undefined) out.windowMinutes = window.windowMinutes;
  // A short reason, by contract. Clipped anyway, because "by contract" is a
  // statement about the writer we have and not about every writer there will be.
  if (window.error !== undefined) out.error = clip(window.error);
  if (window.model !== undefined) out.model = clip(window.model);
  if (window.detailed !== undefined) out.detailed = window.detailed;
  return out;
}

export function toWireQuotaProvider(provider: QuotaProvider): QuotaProvider {
  const out: { -readonly [K in keyof QuotaProvider]: QuotaProvider[K] } = {
    name: clip(provider.name) ?? provider.name,
    configured: provider.configured,
    windows: provider.windows.map(toWireQuotaWindow),
  };
  if (provider.plan !== undefined) out.plan = clip(provider.plan);
  if (provider.source !== undefined) out.source = clip(provider.source);
  if (provider.sourceAt !== undefined) out.sourceAt = provider.sourceAt;
  if (provider.binding !== undefined) out.binding = clip(provider.binding);
  return out;
}

export function toWireQuota(quota: Quota): Quota {
  const out: { -readonly [K in keyof Quota]: Quota[K] } = {
    source: quota.source,
    providers: quota.providers.map(toWireQuotaProvider),
  };
  if (quota.updatedAt !== undefined) out.updatedAt = quota.updatedAt;
  return out;
}

/** The whole snapshot, ready for `JSON.stringify`. */
export function toWireState(snapshot: StateSnapshot, options?: RedactOptions): StateSnapshot {
  const out: {
    -readonly [K in keyof StateSnapshot]: StateSnapshot[K];
  } = {
    generatedAt: snapshot.generatedAt,
    sessions: snapshot.sessions.map((session) => toWireSession(session, options)),
    commandAvailable: snapshot.commandAvailable,
    warnings: snapshot.warnings,
  };
  // Absent when neither source exists, which is how the strip stays hidden.
  if (snapshot.quota !== undefined) out.quota = toWireQuota(snapshot.quota);
  return out;
}

/* ------------------------------------------------------------------ *
 * WP4b: history
 * ------------------------------------------------------------------ */

/**
 * A project label on the wire.
 *
 * `HistoryScanner` already collapsed the home directory's own slug to `~`,
 * because a project slug carries the account name on 52 of the 68 directories
 * on the maintainer's machine. This is the second pass: the same `redact()`
 * the live canvas puts `cwd` through, so a slug that happens to contain a
 * token-shaped run is masked and an absurdly long one is cut.
 */
function wireProject(project: string, options?: RedactOptions): string {
  return redact(project, options);
}

/** One listing row. The raw slug and the project directory never leave. */
export function toWireHistorySummary(
  summary: HistorySummary,
  options?: RedactOptions,
): HistorySummary {
  const out: {
    -readonly [K in keyof HistorySummary]: HistorySummary[K];
  } = {
    sessionId: summary.sessionId,
    project: wireProject(summary.project, options),
    transcriptBytes: summary.transcriptBytes,
    lastWriteAt: summary.lastWriteAt,
    hydrated: summary.hydrated,
  };
  if (summary.agentCount !== undefined) out.agentCount = summary.agentCount;
  if (summary.firstWriteAt !== undefined) out.firstWriteAt = summary.firstWriteAt;
  if (summary.durationMs !== undefined) out.durationMs = summary.durationMs;
  if (summary.model !== undefined) out.model = clip(summary.model);
  const tokens = copyTokens(summary.tokens);
  if (tokens !== undefined) out.tokens = tokens;
  const treeTokens = copyTokens(summary.treeTokens);
  if (treeTokens !== undefined) out.treeTokens = treeTokens;
  return out;
}

/** One frozen session. Agents go through the same gate as the live canvas. */
export function toWireHistory(history: History, options?: RedactOptions): History {
  const out: {
    -readonly [K in keyof History]: History[K];
  } = {
    sessionId: history.sessionId,
    project: wireProject(history.project, options),
    agentCount: history.agentCount,
    agents: history.agents.map(toWireAgent),
    roots: history.roots.map(toWireNode),
    orphans: [...history.orphans],
    dedupeFallbacks: history.dedupeFallbacks,
    bytesRead: history.bytesRead,
  };

  // `cwd` is declared by the node model and never filled: a transcript's `cwd`
  // is on the never-extracted list, so history knows a project by slug alone.
  if (history.cwd !== undefined) out.cwd = redact(history.cwd, options);
  if (history.firstWriteAt !== undefined) out.firstWriteAt = history.firstWriteAt;
  if (history.lastWriteAt !== undefined) out.lastWriteAt = history.lastWriteAt;
  if (history.durationMs !== undefined) out.durationMs = history.durationMs;
  if (history.model !== undefined) out.model = clip(history.model);
  if (history.effort !== undefined) out.effort = clip(history.effort);
  if (history.toolCalls !== undefined) out.toolCalls = history.toolCalls;
  const tokens = copyTokens(history.tokens);
  if (tokens !== undefined) out.tokens = tokens;
  const treeTokens = copyTokens(history.treeTokens);
  if (treeTokens !== undefined) out.treeTokens = treeTokens;
  return out;
}

/** One page of the listing. */
export function toWireHistoryPage(
  page: HistoryListPage,
  options?: RedactOptions,
): HistoryListPage {
  const out: {
    -readonly [K in keyof HistoryListPage]: HistoryListPage[K];
  } = {
    generatedAt: page.generatedAt,
    total: page.total,
    offset: page.offset,
    sessions: page.sessions.map((summary) => toWireHistorySummary(summary, options)),
    projects: page.projects.map((project) => wireProject(project, options)),
    listMs: page.listMs,
    warnings: page.warnings,
  };
  if (page.nextOffset !== undefined) out.nextOffset = page.nextOffset;
  return out;
}
