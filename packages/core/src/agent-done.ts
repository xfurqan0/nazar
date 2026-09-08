/**
 * WP4b: when is a subagent finished?
 *
 * WP2 could only say "its transcript has been quiet for a while", which is not
 * the same question and is why every quiet agent read as `unknown`. This file
 * answers the real one, from three signals and in this order of authority:
 *
 * 1. **`parent-result`** — the parent transcript carries a `toolUseResult` for
 *    the `Agent` tool call that launched this subagent. Claude Code writes that
 *    line when the tool returns, so it *is* the stop event: it needs no timeout
 *    and it cannot be wrong. The bridge is WP2's (`toolUseResult.agentId`);
 *    `agentId` and the meta file's `toolUseId` name the same launch, one to one,
 *    on all 346 launches measured on the maintainer's machine, so watching the
 *    bridge is watching the tool-use id.
 * 2. **`session-gone`** — the session that owned the agent is no longer running.
 *    Nothing will ever be appended to that transcript again, whatever its last
 *    line says.
 * 3. **`quiet-turn`** — the agent's own transcript ends on an *assistant* line
 *    with no pending `tool_use`, and nothing has been appended for at least
 *    {@link DONE_QUIET_MS}. A finished agent's last line is its closing message;
 *    an agent that is merely thinking has either a pending tool call or a `user`
 *    line (a tool result) as its last line.
 *
 * The one rule that matters more than the three: **silence alone is never
 * `done`.** A transcript that has said nothing for fifty seconds and ends on an
 * assistant turn is `unknown`, not finished — Claude Code flushes transcripts
 * asynchronously, and a monitor that calls a thinking agent dead is worse than
 * one that admits it does not know. That is the whole purpose of the guard
 * window, and `test/agent-done.test.ts` holds it to the second.
 */

/**
 * How long an agent's transcript must be quiet before its closing assistant
 * turn is accepted as the end. Sixty seconds: long enough to outlast the
 * asynchronous write lag by an order of magnitude, short enough that a finished
 * agent fades within a minute.
 */
export const DONE_QUIET_MS = 60_000;

/** How long after its last write an agent still counts as actively running. */
export const DEFAULT_RUNNING_WINDOW_MS = 30_000;

/** Which of the three signals ended an agent. Absent when it has not ended. */
export type AgentDoneSignal = 'parent-result' | 'session-gone' | 'quiet-turn';

/** Everything the verdict is allowed to depend on. No I/O, no clock of its own. */
export interface AgentDoneInput {
  /** The parent's `toolUseResult` for this agent's launch has been seen. */
  readonly hasParentResult?: boolean;
  /** The session that owned this agent is no longer running. */
  readonly sessionGone?: boolean;
  /** Type of the last line read from the agent's own transcript. */
  readonly lastLineType?: 'assistant' | 'user';
  /** The last assistant line carried a `tool_use` whose result has not landed. */
  readonly pendingToolUse?: boolean;
  /** `mtimeMs` of the agent's transcript. */
  readonly lastWriteAt?: number;
  /** Timestamp of the last line *inside* the transcript. */
  readonly lastEventAt?: number;
  readonly now: number;
  /** Guard window. Defaults to {@link DONE_QUIET_MS}. */
  readonly quietMs?: number;
  /** Defaults to {@link DEFAULT_RUNNING_WINDOW_MS}. */
  readonly runningWindowMs?: number;
}

export interface AgentDoneVerdict {
  readonly state: 'running' | 'done' | 'unknown';
  /** Which signal produced `done`. Absent for every other state. */
  readonly signal?: AgentDoneSignal;
  /**
   * When the agent stopped, as far as the transcript can say: the timestamp of
   * its last line, falling back to the file's `mtime`. Absent when neither
   * exists, which is an agent whose transcript never appeared.
   */
  readonly endedAt?: number;
}

/**
 * Decide one agent's state. Pure, total, and deliberately conservative: every
 * path that is not one of the three signals returns `running` or `unknown`.
 */
export function agentDoneState(input: AgentDoneInput): AgentDoneVerdict {
  const quietMs = input.quietMs ?? DONE_QUIET_MS;
  const runningWindowMs = input.runningWindowMs ?? DEFAULT_RUNNING_WINDOW_MS;
  const endedAt = input.lastEventAt ?? input.lastWriteAt;
  const writeAgeMs =
    input.lastWriteAt === undefined ? undefined : Math.max(0, input.now - input.lastWriteAt);

  const done = (signal: AgentDoneSignal): AgentDoneVerdict =>
    endedAt === undefined ? { state: 'done', signal } : { state: 'done', signal, endedAt };

  // (a) The parent answered the Agent tool call. Authoritative, and immediate:
  // waiting out a quiet window here would only make a known fact late.
  if (input.hasParentResult === true) return done('parent-result');

  // (c) The owning session is gone, so the file is final whatever it says.
  if (input.sessionGone === true) return done('session-gone');

  // (b) A closing assistant turn, held for the whole guard window.
  if (
    input.lastLineType === 'assistant' &&
    input.pendingToolUse !== true &&
    writeAgeMs !== undefined &&
    writeAgeMs >= quietMs
  ) {
    return done('quiet-turn');
  }

  // Not finished. Warm transcript: running. Quiet transcript with no signal:
  // unknown, which is the honest answer and never `done`.
  if (writeAgeMs !== undefined && writeAgeMs <= runningWindowMs) return { state: 'running' };
  return { state: 'unknown' };
}
