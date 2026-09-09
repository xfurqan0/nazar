/**
 * WP4d: is this thing working, or is it just still there?
 *
 * The canvas already said whether a process answers a signal-0 probe
 * (`Session.state`) and whether a subagent has ended (`Agent.state`). Neither
 * of those is the question people actually ask when they glance at a wall of
 * cards, which is **"which of these is working right now"**. That question has
 * one answer per node, it is derived from three or four fields that live in
 * different places, and it is drawn in four places (the frame, the label, the
 * ring, the dot). So it is computed exactly once, here, by a pure function.
 *
 * The order of the rules is the whole design, and it is deliberate:
 *
 * 1. **A frozen tree is the past.** Nothing in history is happening, whatever
 *    the file said when it was written, so a frozen node never pulses and
 *    never claims to be working.
 * 2. **Waiting beats working.** A session waiting for a permission prompt is
 *    also `busy` in Claude Code's own status file. It is the loudest state on
 *    the canvas and it is the one the user can do something about, so it wins.
 * 3. **A failed liveness probe beats a fresh write.** `state: 'unknown'` means
 *    the process did not answer this pass. A transcript flushed two seconds
 *    before it died does not make it alive again.
 * 4. **A recent transcript write means working.** Claude Code's session file
 *    lags: it can still read `idle` while the transcript is being appended to.
 *    A write inside `RECENT_WRITE_MS` is direct evidence, so it promotes an
 *    otherwise-quiet live node to `working`. This is also the only way an
 *    agent whose end-signal is `unknown` can be called working — evidence, not
 *    a guess.
 * 5. **Otherwise say the quiet thing**, and say `unknown` rather than invent
 *    `idle` for a node no source described (docs/PROJECT.md section 5).
 *
 * The function takes `now` rather than reading the clock, because a rule about
 * a thirty-second window that cannot be tested at a chosen instant is not a
 * rule, it is a hope.
 */

import { t } from './i18n.js';

/** Every answer the canvas can draw. Exactly one applies to a node. */
export const ACTIVITIES = ['working', 'waiting', 'idle', 'done', 'unknown'] as const;

export type Activity = (typeof ACTIVITIES)[number];

/**
 * How fresh a transcript write has to be to count as "working".
 *
 * Thirty seconds, because transcripts are flushed asynchronously and a model
 * turn can easily run longer than the gap between two writes; anything much
 * shorter makes a busy session flicker between working and idle while it
 * thinks, which is exactly the noise a monitor is supposed to remove.
 */
export const RECENT_WRITE_MS = 30_000;

/** Claude Code's session status, plus Nazar's `unknown`. Mirrors `@nazar/core`. */
export type ActivitySessionStatus = 'busy' | 'idle' | 'waiting' | 'unknown';

/** A session, reduced to the fields the answer depends on. */
export interface SessionActivityNode {
  readonly kind: 'session';
  readonly status: ActivitySessionStatus;
  /** Nazar's liveness verdict, not Claude Code's status. */
  readonly state: 'alive' | 'unknown';
  readonly waitingFor?: string;
  /** `mtimeMs` of the session *transcript*, not of the session file. */
  readonly lastWriteAt?: number;
  /** True on a history tree: a session that has already ended. */
  readonly frozen?: boolean;
}

/** A subagent, reduced to the same. */
export interface AgentActivityNode {
  readonly kind: 'agent';
  readonly state: 'running' | 'done' | 'unknown';
  readonly lastWriteAt?: number;
  readonly frozen?: boolean;
}

export type ActivityNode = SessionActivityNode | AgentActivityNode;

/** The two fields the waiting question is decided from, and nothing else. */
export interface WaitingLike {
  readonly status: ActivitySessionStatus;
  readonly waitingFor?: string;
}

/**
 * A session the user has to answer. The loudest thing the canvas can say.
 *
 * N-WP21 pulled this out of `web/canvas.ts` and made rule 2 below call it, so
 * there is **one** definition of *waiting* on the page rather than two that
 * happened to agree. The frame, the ring, the banner and the Needs-you strip
 * are four drawings of this one predicate, and a card framed amber while the
 * strip says nobody is waiting would be the canvas contradicting itself.
 *
 * Two clauses, because the two sources fail in opposite directions: `status`
 * comes from the session file and `waitingFor` from `claude agents --json`, and
 * either one on its own is enough to have to answer something.
 */
export function isWaiting(session: WaitingLike): boolean {
  return session.status === 'waiting' || session.waitingFor !== undefined;
}

function wroteRecently(lastWriteAt: number | undefined, now: number): boolean {
  if (lastWriteAt === undefined || !Number.isFinite(lastWriteAt)) return false;
  const age = now - lastWriteAt;
  // A negative age is a clock disagreement, not a fresh write. It is shown as
  // `unknown` everywhere else in the UI and it does not count as evidence here.
  return age >= 0 && age <= RECENT_WRITE_MS;
}

/**
 * The one decision. See the rule order at the top of this file.
 */
export function activityOf(node: ActivityNode, now: number): Activity {
  // 1. History is finished by definition. An agent the store never classified
  //    stays `unknown` there too: a frozen tree does not turn a missing signal
  //    into a fact.
  if (node.frozen === true) {
    return node.kind === 'agent' && node.state === 'unknown' ? 'unknown' : 'done';
  }

  if (node.kind === 'session') {
    // 2. Waiting wins, including over `busy`. One predicate, shared with the
    //    banner and the Needs-you strip: see `isWaiting` above.
    if (isWaiting(node)) return 'waiting';
    // 3. The process did not answer.
    if (node.state === 'unknown') return 'unknown';
    if (node.status === 'busy') return 'working';
    // 4. The status file lags; the transcript does not.
    if (wroteRecently(node.lastWriteAt, now)) return 'working';
    // 5. Quiet and alive, or quiet and undescribed.
    return node.status === 'idle' ? 'idle' : 'unknown';
  }

  if (node.state === 'done') return 'done';
  if (node.state === 'running') return 'working';
  // An agent with no end-signal, but a transcript that moved a moment ago.
  return wroteRecently(node.lastWriteAt, now) ? 'working' : 'unknown';
}

/* ------------------------------------------------------------------ *
 * Adapters. The canvas holds a `SessionView` and an `Agent`, whose write
 * timestamps live under different names; these are the two places that
 * mapping is written down.
 * ------------------------------------------------------------------ */

/** The fields `sessionActivity` reads. `SessionView` satisfies it. */
export interface SessionActivityLike {
  readonly status: ActivitySessionStatus;
  readonly state: 'alive' | 'unknown';
  readonly waitingFor?: string;
  /** `SessionView.transcriptAt`: `lastWriteAt` on a `Session` is the *file*. */
  readonly transcriptAt?: number;
}

/** The fields `agentActivity` reads. `Agent` satisfies it. */
export interface AgentActivityLike {
  readonly state: 'running' | 'done' | 'unknown';
  readonly lastWriteAt?: number;
}

export function sessionActivity(
  session: SessionActivityLike,
  now: number,
  frozen = false,
): Activity {
  const node: SessionActivityNode = {
    kind: 'session',
    status: session.status,
    state: session.state,
    frozen,
    ...(session.waitingFor === undefined ? {} : { waitingFor: session.waitingFor }),
    ...(session.transcriptAt === undefined ? {} : { lastWriteAt: session.transcriptAt }),
  };
  return activityOf(node, now);
}

export function agentActivity(agent: AgentActivityLike, now: number, frozen = false): Activity {
  const node: AgentActivityNode = {
    kind: 'agent',
    state: agent.state,
    frozen,
    ...(agent.lastWriteAt === undefined ? {} : { lastWriteAt: agent.lastWriteAt }),
  };
  return activityOf(node, now);
}

/* ------------------------------------------------------------------ *
 * How it reaches the screen
 * ------------------------------------------------------------------ */

/**
 * The class the canvas puts on a node's group. One class per activity, and the
 * renderer sets all five so exactly one is ever on — which is what keeps the
 * SSE diff path to a class toggle instead of a rebuilt node.
 */
export function activityClass(activity: Activity): string {
  return `is-${activity}`;
}

/** Every class `activityClass` can produce, for the renderer and for the tests. */
export const ACTIVITY_CLASSES: readonly string[] = ACTIVITIES.map(activityClass);

/**
 * The word on the card.
 *
 * Colour alone is not a state (styles.css says so at the top): it fails on a
 * greyscale screenshot and on a reader who cannot separate two hues. Every
 * frame colour here has this word next to it.
 */
export function activityLabel(activity: Activity): string {
  return t(`state.${activity}`);
}
