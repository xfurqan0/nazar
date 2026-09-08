/**
 * Nazar's node model. `Session` and `Agent` follow docs/PROJECT.md section 5;
 * a field no source can fill yet stays `undefined` rather than being invented,
 * and is never shown as `0` (docs/pinned-internal-formats.md, rule 3).
 */

import type { AgentDoneSignal } from './agent-done.js';

/** Providers Nazar can draw on the canvas. Codex arrives in v2. */
export const providers = ['claude'] as const;

export type Provider = (typeof providers)[number];

/**
 * The three statuses Claude Code writes for a live session, plus Nazar's
 * `unknown` for "the source did not say". A status Claude Code invents later
 * reads as `unknown`: a value we have never observed is not trusted.
 */
export const KNOWN_SESSION_STATUS = ['busy', 'idle', 'waiting'] as const;

export type KnownSessionStatus = (typeof KNOWN_SESSION_STATUS)[number];

export type SessionStatus = KnownSessionStatus | 'unknown';

export function toSessionStatus(value: unknown): SessionStatus {
  return typeof value === 'string' && (KNOWN_SESSION_STATUS as readonly string[]).includes(value)
    ? (value as KnownSessionStatus)
    : 'unknown';
}

/**
 * What a `status: "waiting"` session is waiting for. Only `claude agents --json`
 * carries it: `~/.claude/sessions/<pid>.json` has no such key, so a session can
 * be known to be waiting from the files alone while the reason stays undefined.
 *
 * These four values are the ones docs/PROJECT.md section 1 pins. The field is
 * typed as a plain string because none of them was observed on this machine and
 * an unexpected value must reach the UI rather than be dropped; the data-layer
 * audit's reading of the documentation also mentions `worker request`.
 */
export const KNOWN_WAITING_FOR = [
  'permission prompt',
  'input needed',
  'sandbox request',
  'dialog open',
] as const;

export type KnownWaitingFor = (typeof KNOWN_WAITING_FOR)[number];

/**
 * Nazar's liveness verdict, which is not Claude Code's `status`. `alive` means
 * the process answered a signal-0 probe on this pass. `unknown` means it did
 * not: never "still running". An `unknown` session survives exactly one
 * liveness gate and is then removed.
 */
export type SessionState = 'alive' | 'unknown';

/** Which of WP1's two sources a session was seen in on the last pass. */
export type SessionSource = 'files' | 'command' | 'files+command';

/** Token counters, filled by the transcript reader in WP2. */
export interface SessionTokens {
  readonly in?: number;
  readonly out?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

/** A subagent under a session. Filled by WP2; WP1 always reports an empty list. */
export interface Agent {
  readonly id: string;
  readonly sessionId: string;
  readonly parentAgentId?: string;
  readonly spawnDepth: number;
  readonly agentType: string;
  /** Shortcut form from `meta.json` (`opus`). */
  readonly model?: string;
  /** Full model id from the parent's `toolUseResult.resolvedModel`. */
  readonly modelId?: string;
  /**
   * User-authored text from `meta.json`, capped at 200 characters. Hover card
   * only: it is never persisted, never sent anywhere, and dropped when longer.
   */
  readonly description?: string;
  /** The parent's `Agent` tool-use id this subagent was launched from. */
  readonly toolUseId?: string;
  /** Set when the agent lives under `subagents/workflows/<runId>/`. */
  readonly workflowRunId?: string;
  /**
   * True when `parentAgentId` names an agent this session has no meta file for.
   * The node still renders, attached to the session root. Never observed on the
   * maintainer's machine (0 dangling links in 346 meta files).
   */
  readonly orphan?: boolean;
  readonly startedAt?: number;
  /** When the agent stopped. Only ever set on a `done` agent (WP4b). */
  readonly endedAt?: number;
  readonly durationMs?: number;
  readonly toolCalls?: number;
  readonly effort?: string;
  readonly tokens?: SessionTokens;
  readonly currentTool?: string;
  /** `mtimeMs` of the agent's transcript: when Claude Code last appended. */
  readonly lastWriteAt?: number;
  /** Age of that write at snapshot time. Transcripts are written with lag. */
  readonly writeAgeMs?: number;
  readonly state: 'running' | 'done' | 'unknown';
  /**
   * Which of WP4b's three signals ended this agent. Absent unless `state` is
   * `done`, and never guessed: silence on its own produces no signal at all.
   */
  readonly doneSignal?: AgentDoneSignal;
}

/**
 * How full a session's context window is (WP3').
 *
 * Only the status-line capture knows this — the transcript counts tokens spent,
 * which is a different quantity — so the whole object is absent on a machine
 * without the wrapper. `percent` is the payload's own `used_percentage` rather
 * than `used / size` computed here: the two agree to a rounding step, and
 * showing the source's number keeps the canvas and the status line from
 * disagreeing by one.
 */
export interface SessionContextWindow {
  readonly used?: number;
  readonly size?: number;
  readonly percent?: number;
}

/**
 * WP4f: why a session has no cost and no context window, when the reason is one
 * Nazar can actually determine.
 *
 * Absent is the normal answer and it stays absent — a machine with no wrapper
 * installed has no capture for any session, which is a property of the machine
 * and not of the session. This says something narrower and much more useful:
 * *this* session, on a machine that does have the wrapper, will never produce a
 * capture, because the project it was started in replaced the status line the
 * wrapper installed itself as.
 */
export type CaptureBlockReason = 'project statusLine';

/** A node of the per-session tree: an agent plus the agents it spawned. */
export interface AgentNode {
  readonly agent: Agent;
  readonly children: readonly AgentNode[];
}

/** One Claude Code session, as far as WP1's two sources can describe it. */
export interface Session {
  /** `sessionId` when a source gave one, otherwise `pid-<pid>`. */
  readonly id: string;
  readonly provider: Provider;
  readonly pid: number;
  readonly cwd?: string;
  /** `interactive` or `background`; only `interactive` was ever observed. */
  readonly kind?: string;
  readonly name?: string;
  readonly status: SessionStatus;
  readonly waitingFor?: string;
  /** WP2 (transcript). */
  readonly model?: string;
  /** WP2 (transcript). */
  readonly effort?: string;
  readonly startedAt?: number;
  /** `updatedAt` of the session file: when Claude Code last touched it. */
  readonly lastWriteAt?: number;
  /** When the session's status last changed, per the session file. */
  readonly statusUpdatedAt?: number;
  /** Claude Code version that wrote the session file. */
  readonly version?: string;
  /** WP3' (status-line capture). Absent when no capture names this session. */
  readonly contextWindow?: SessionContextWindow;
  /** WP3' (status-line capture). Dollars, as the payload reported them. */
  readonly costUsd?: number;
  /** When the capture those two came from was taken. Absent with them. */
  readonly capturedAt?: number;
  /**
   * WP4f. Set only when this session has **no** capture and the reason is
   * knowable. Never set alongside `costUsd` or `contextWindow`.
   */
  readonly captureBlockedBy?: CaptureBlockReason;
  /** WP2 (transcript, deduplicated by `(message.id, requestId)`). */
  readonly tokens?: SessionTokens;
  /** WP2 (transcript). */
  readonly currentTool?: string;
  /** WP2. Always empty in WP1. */
  readonly agents: readonly Agent[];
  /** Nazar's liveness verdict for this pass. */
  readonly state: SessionState;
  /** Which sources described this session on this pass. */
  readonly source: SessionSource;
  /** Epoch ms of the last pass in which a source still listed this session. */
  readonly lastSeenAt: number;
}

/* ------------------------------------------------------------------ *
 * WP4b: history
 * ------------------------------------------------------------------ */

/**
 * One past session as the history list shows it, built from a directory
 * listing alone: no transcript is opened to produce this.
 *
 * The measured fields — `firstWriteAt`, `durationMs`, `model`, `tokens` — are
 * therefore absent until the session has actually been opened, and are filled
 * in from the parse cache once it has. They are never guessed from file
 * metadata and never shown as `0`.
 */
export interface HistorySummary {
  readonly sessionId: string;
  /** The project slug, with the home directory collapsed to `~`. */
  readonly project: string;
  /** Size of the session transcript on disk. */
  readonly transcriptBytes: number;
  /** `mtimeMs` of the session transcript: when Claude Code last appended. */
  readonly lastWriteAt: number;
  /** `agent-*.meta.json` files in the session's `subagents/` directory. */
  readonly agentCount?: number;
  /** True once the parsed fields below come from a real read of the file. */
  readonly hydrated: boolean;
  readonly firstWriteAt?: number;
  readonly durationMs?: number;
  readonly model?: string;
  readonly tokens?: SessionTokens;
  readonly treeTokens?: SessionTokens;
}

/**
 * One past session, frozen: the same tree the live canvas draws, built from
 * files that will never change again.
 *
 * `cwd` is declared by the node model (docs/PROJECT.md section 5) and is
 * deliberately never filled here. A transcript's `cwd` is on the
 * never-extracted list, so history knows a project only by its slug.
 */
export interface History {
  readonly sessionId: string;
  readonly project: string;
  /** Always absent: see above. */
  readonly cwd?: string;
  /** Timestamp of the transcript's first line. */
  readonly firstWriteAt?: number;
  /** `mtimeMs` of the session transcript. */
  readonly lastWriteAt?: number;
  /** First line to last, from the transcript's own timestamps. */
  readonly durationMs?: number;
  readonly model?: string;
  readonly effort?: string;
  /** The session transcript's own deduplicated totals. */
  readonly tokens?: SessionTokens;
  /** The session plus every subagent under it, each deduplicated separately. */
  readonly treeTokens?: SessionTokens;
  /** `tool_use` blocks in the session's own transcript. */
  readonly toolCalls?: number;
  readonly agentCount: number;
  readonly agents: readonly Agent[];
  readonly roots: readonly AgentNode[];
  /** Agents whose written parent did not resolve. Empty in healthy data. */
  readonly orphans: readonly string[];
  /** Lines keyed on `message.id` alone for want of a `requestId`. */
  readonly dedupeFallbacks: number;
  /** Bytes pulled off disk to build this. Zero on a cache hit. */
  readonly bytesRead: number;
}

/** Payload of the registry's `change` event. */
export interface SessionChange {
  readonly added: readonly Session[];
  readonly updated: readonly Session[];
  readonly removed: readonly Session[];
}
