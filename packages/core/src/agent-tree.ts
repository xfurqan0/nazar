/**
 * WP2: the per-session subagent tree.
 *
 * The structure is read, not inferred: `parentAgentId` and `spawnDepth` are
 * both written into `agent-<id>.meta.json`. Nazar computes a depth only when
 * the file does not carry one, which has not happened in 346 files.
 *
 * The one rule that matters under failure: a `parentAgentId` naming an agent we
 * have no meta file for must never throw and must never make the node vanish.
 * It attaches to the session root with `orphan: true`. The same applies to a
 * parent chain that loops, which Claude Code cannot produce but a half-written
 * directory could imitate.
 */
import { agentDoneState, DEFAULT_RUNNING_WINDOW_MS } from './agent-done.js';
import type { AgentBridge } from './transcript-stats.js';
import type { AgentMeta } from './subagent-meta.js';
import type { Agent, AgentNode, SessionTokens } from './types.js';

export { DEFAULT_RUNNING_WINDOW_MS } from './agent-done.js';

/** What one agent's own transcript contributed, as `TranscriptStats` reports it. */
export interface AgentActivity {
  readonly tokens?: SessionTokens;
  readonly effort?: string;
  /** `message.model` from the agent's own transcript (`claude-opus-5`). */
  readonly model?: string;
  readonly currentTool?: string;
  readonly toolCalls?: number;
  readonly startedAt?: number;
  readonly lastEventAt?: number;
  /** `mtimeMs` of the agent's transcript. */
  readonly lastWriteAt?: number;
  /** Type of the transcript's last line. WP4b's `quiet-turn` signal needs it. */
  readonly lastLineType?: 'assistant' | 'user';
  /** The transcript ends on an assistant line with an unanswered `tool_use`. */
  readonly pendingToolUse?: boolean;
  /**
   * N-WP15a: the brief this agent was launched with, from the **first** human
   * turn of its own transcript. Absent unless task text was asked for.
   */
  readonly task?: string;
}

export interface BuildAgentTreeOptions {
  readonly sessionId: string;
  readonly metas: readonly AgentMeta[];
  /** Per-agent transcript stats, by agent id. */
  readonly activity?: ReadonlyMap<string, AgentActivity>;
  /** `toolUseResult` bridges collected from every transcript in the session. */
  readonly bridges?: ReadonlyMap<string, AgentBridge>;
  /** Clock, injected by tests. */
  readonly now?: number;
  readonly runningWindowMs?: number;
  /** How long a transcript must be quiet before a closing turn counts as the end. */
  readonly quietMs?: number;
  /**
   * The session that owned these agents is gone: nothing will ever be appended
   * again, so every agent is finished whatever its last line says. Set by the
   * history builder, and by the live join when a session's process stops
   * answering.
   */
  readonly sessionGone?: boolean;
  /**
   * Leave `description` off every agent this call builds.
   *
   * `meta.json`'s `description` is the one free-text field in the whole node
   * model: a person, or the model acting for them, wrote it about their own
   * work, and it is the only string here that is prose rather than an id, an
   * enum or a name. The live tree keeps it in memory for the hover card and
   * `toWireAgent` drops it before the wire; **history keeps it nowhere**. A
   * frozen session has no hover card that shows it, so carrying it is risk
   * with no reader, and `test/history-leak.test.ts` asserts the key is absent
   * from the history object itself rather than trusting a later filter.
   */
  readonly omitDescription?: boolean;
}

export interface AgentTree {
  /** Every agent, flat, sorted by depth then start then id. */
  readonly agents: readonly Agent[];
  /** The same agents as a forest hanging off the session. */
  readonly roots: readonly AgentNode[];
  /** Ids whose `parentAgentId` did not resolve. Empty in healthy data. */
  readonly orphans: readonly string[];
}

function isPositiveInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value > 0;
}

/**
 * Resolve each agent's parent, clearing links that dangle or loop. Returns the
 * effective parent per id, plus the ids whose written parent was rejected.
 */
function resolveParents(metas: readonly AgentMeta[]): {
  parentOf: Map<string, string | undefined>;
  orphans: Set<string>;
} {
  const known = new Set(metas.map((meta) => meta.id));
  const parentOf = new Map<string, string | undefined>();
  const orphans = new Set<string>();

  for (const meta of metas) {
    const written = meta.parentAgentId;
    if (written === undefined || written.length === 0) {
      parentOf.set(meta.id, undefined);
      continue;
    }
    if (written === meta.id || !known.has(written)) {
      parentOf.set(meta.id, undefined);
      orphans.add(meta.id);
      continue;
    }
    parentOf.set(meta.id, written);
  }

  // A cycle cannot be reached from any root, so break it at the first node that
  // sees itself again. The node becomes a root and is reported as an orphan.
  for (const meta of metas) {
    const seen = new Set<string>([meta.id]);
    let cursor = parentOf.get(meta.id);
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        parentOf.set(meta.id, undefined);
        orphans.add(meta.id);
        break;
      }
      seen.add(cursor);
      cursor = parentOf.get(cursor);
    }
  }

  return { parentOf, orphans };
}

function depthOf(
  id: string,
  metaById: ReadonlyMap<string, AgentMeta>,
  parentOf: ReadonlyMap<string, string | undefined>,
  cache: Map<string, number>,
): number {
  const cached = cache.get(id);
  if (cached !== undefined) return cached;
  // Written by Claude Code, so it wins: 287/31/28 files at depth 1/2/3.
  const written = metaById.get(id)?.spawnDepth;
  if (isPositiveInteger(written)) {
    cache.set(id, written);
    return written;
  }
  const parent = parentOf.get(id);
  const depth = parent === undefined ? 1 : depthOf(parent, metaById, parentOf, cache) + 1;
  cache.set(id, depth);
  return depth;
}

/**
 * Turn one session's meta files, transcript stats and parent bridges into the
 * tree the canvas draws. Pure: no I/O, no clock beyond the injected `now`.
 */
export function buildAgentTree(options: BuildAgentTreeOptions): AgentTree {
  const { sessionId, metas } = options;
  const activity = options.activity ?? new Map<string, AgentActivity>();
  const bridges = options.bridges ?? new Map<string, AgentBridge>();
  const now = options.now ?? Date.now();
  const runningWindowMs = options.runningWindowMs ?? DEFAULT_RUNNING_WINDOW_MS;

  const metaById = new Map(metas.map((meta) => [meta.id, meta]));
  const { parentOf, orphans } = resolveParents(metas);
  const depthCache = new Map<string, number>();

  const agents: Agent[] = metas.map((meta) => {
    const stats = activity.get(meta.id);
    const bridge = bridges.get(meta.id);
    const lastWriteAt = stats?.lastWriteAt;
    const writeAgeMs = lastWriteAt === undefined ? undefined : Math.max(0, now - lastWriteAt);

    // WP4b: the three signals, in `agent-done.ts`. Note `completed`, not merely
    // "a bridge exists": the `Agent` tool returns at *launch* on Claude Code
    // 2.1.263, so most bridges are launch records and say nothing about the
    // agent's end. The other two signals are the session ending and a closing
    // assistant turn that has been quiet for the whole guard window.
    const verdict = agentDoneState({
      hasParentResult: bridge?.completed === true,
      now,
      runningWindowMs,
      ...(options.sessionGone === undefined ? {} : { sessionGone: options.sessionGone }),
      ...(options.quietMs === undefined ? {} : { quietMs: options.quietMs }),
      ...(stats?.lastLineType === undefined ? {} : { lastLineType: stats.lastLineType }),
      ...(stats?.pendingToolUse === undefined ? {} : { pendingToolUse: stats.pendingToolUse }),
      ...(lastWriteAt === undefined ? {} : { lastWriteAt }),
      ...(stats?.lastEventAt === undefined ? {} : { lastEventAt: stats.lastEventAt }),
    });

    const agent: {
      -readonly [K in keyof Agent]: Agent[K];
    } = {
      id: meta.id,
      sessionId,
      spawnDepth: depthOf(meta.id, metaById, parentOf, depthCache),
      agentType: meta.agentType ?? 'unknown',
      state: verdict.state,
    };
    if (verdict.signal !== undefined) agent.doneSignal = verdict.signal;
    if (verdict.endedAt !== undefined && verdict.state === 'done') agent.endedAt = verdict.endedAt;

    const parent = parentOf.get(meta.id);
    if (parent !== undefined) agent.parentAgentId = parent;
    else if (meta.parentAgentId !== undefined && meta.parentAgentId.length > 0) {
      // Kept so the hover card can say who it claimed to belong to.
      agent.parentAgentId = meta.parentAgentId;
    }
    if (orphans.has(meta.id)) agent.orphan = true;
    if (meta.model !== undefined) agent.model = meta.model;
    if (bridge?.modelId !== undefined) agent.modelId = bridge.modelId;
    if (meta.description !== undefined && options.omitDescription !== true) {
      agent.description = meta.description;
    }
    if (meta.toolUseId !== undefined) agent.toolUseId = meta.toolUseId;
    if (meta.workflowRunId !== undefined) agent.workflowRunId = meta.workflowRunId;
    // N-WP15a. Absent unless the transcript reader was asked for task text, so
    // this line writes nothing on the default path.
    if (stats?.task !== undefined) agent.task = stats.task;
    if (stats?.tokens !== undefined) agent.tokens = stats.tokens;
    if (stats?.effort !== undefined) agent.effort = stats.effort;
    if (stats?.currentTool !== undefined) agent.currentTool = stats.currentTool;
    if (stats?.toolCalls !== undefined) agent.toolCalls = stats.toolCalls;
    if (stats?.startedAt !== undefined) agent.startedAt = stats.startedAt;
    if (lastWriteAt !== undefined) agent.lastWriteAt = lastWriteAt;
    if (writeAgeMs !== undefined) agent.writeAgeMs = writeAgeMs;
    // The tool's own measurement first: `toolUseResult` reports the wall time
    // Claude Code saw, which includes the setup the transcript cannot show.
    // Otherwise the span the transcript does know about, first line to last.
    if (bridge?.durationMs !== undefined) agent.durationMs = bridge.durationMs;
    else if (stats?.startedAt !== undefined) {
      const end = verdict.endedAt ?? stats.lastEventAt;
      if (end !== undefined) agent.durationMs = Math.max(0, end - stats.startedAt);
    }
    return agent;
  });

  agents.sort(
    (a, b) =>
      a.spawnDepth - b.spawnDepth ||
      (a.startedAt ?? 0) - (b.startedAt ?? 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const childrenOf = new Map<string, Agent[]>();
  const roots: Agent[] = [];
  for (const agent of agents) {
    const parent = parentOf.get(agent.id);
    if (parent === undefined) {
      roots.push(agent);
      continue;
    }
    const siblings = childrenOf.get(parent);
    if (siblings === undefined) childrenOf.set(parent, [agent]);
    else siblings.push(agent);
  }

  const build = (agent: Agent): AgentNode => ({
    agent,
    children: (childrenOf.get(agent.id) ?? []).map(build),
  });

  return {
    agents,
    roots: roots.map(build),
    orphans: [...orphans].sort(),
  };
}

/** Depth-first walk of a forest, parents before children. */
export function walkAgentTree(
  roots: readonly AgentNode[],
  visit: (node: AgentNode, depth: number) => void,
  depth = 0,
): void {
  for (const node of roots) {
    visit(node, depth);
    walkAgentTree(node.children, visit, depth + 1);
  }
}
