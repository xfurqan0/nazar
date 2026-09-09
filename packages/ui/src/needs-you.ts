/**
 * N-WP21: the strip that says who is waiting for you, and for how long.
 *
 * The canvas has always shouted about a waiting session — an amber frame, an
 * expanding ring, and a banner across the top that outranks everything else on
 * the page. What it has never said is **which one to answer first**. With three
 * sessions waiting the banner is a list of three folder names in the order the
 * registry happened to return them, and the one that has been sitting on a
 * permission prompt for eleven minutes reads exactly like the one that started
 * waiting four seconds ago.
 *
 * So: a badge in the top bar, `Needs you · 2`, with the longest wait beside it,
 * and a list behind a click in the order that matters — longest first. Every
 * row says what it is waiting for and since when, and takes you to the card.
 *
 * Three limits are the whole design, and each of them is a thing this module
 * deliberately does not do:
 *
 * 1. **No inference.** A session is waiting because `claude agents --json` said
 *    `waitingFor`, or because the session's own status is `waiting`. There is no
 *    *stuck* verdict here and no *probably wants attention*: "nothing has been
 *    written for a while" is a guess, and a monitor that guesses is one you stop
 *    believing the first time it is wrong. The README says so under Known
 *    limits, because the absence is a decision rather than an omission.
 * 2. **No new persistence.** How long a session has been waiting is held in
 *    memory for as long as the page is open and nowhere else — no
 *    `localStorage` key, no wire field, nothing on disk. A reload starts the
 *    clocks again from the moment the page came up, which is honest: the page
 *    genuinely does not know what happened before it.
 * 3. **The canvas does not change.** The frame, the ring and the banner stay
 *    exactly as they are. This strip is their *index*, not a second opinion —
 *    which is why {@link isWaiting} lives in `activity.ts` and is called from
 *    both places rather than being written down twice.
 *
 * Everything here is pure: a state object, a reducer over it, and three
 * selectors. `web/needs-you.ts` is the half that owns elements.
 */
import type { ActivitySessionStatus } from './activity.js';
import { isWaiting, sessionActivity } from './activity.js';
import type { TokenLike } from './format.js';
import { basename, formatAge, formatCount, formatCostUsd, formatDuration, hostLabel, orUnknown, unknownWord } from './format.js';
import { t, tCount } from './i18n.js';

/**
 * How long a finished session stays in the second cluster.
 *
 * *While you were away* has to mean something, and the something is a window
 * rather than a session boundary: a run that ended two hours ago is not news,
 * and one that ended ninety seconds ago is the reason you looked. Ten minutes
 * is the number, chosen the way a coffee is — long enough to cover the walk to
 * the kitchen and back, short enough that the cluster is empty on a canvas
 * nobody has left. It is a constant rather than a setting because a setting
 * would be a second thing to explain for a list that clears itself anyway.
 */
export const FINISHED_WINDOW_MS = 10 * 60 * 1000;

/**
 * The catalogue for the four `waitingFor` values Claude Code writes.
 *
 * Pinned in `@nazar/core` as `KNOWN_WAITING_FOR` and translated here, because a
 * session card drawing the raw `permission prompt` in a Korean interface is the
 * one English string left on the page. **Anything else is drawn as it arrived**
 * — a fifth value from a later Claude Code is shown rather than hidden behind
 * `unknown`, since the raw words are still more use than nothing.
 */
const WAITING_KEYS: Readonly<Record<string, string>> = {
  'permission prompt': 'waitingFor.permissionPrompt',
  'input needed': 'waitingFor.inputNeeded',
  'sandbox request': 'waitingFor.sandboxRequest',
  'dialog open': 'waitingFor.dialogOpen',
};

/** What a session is waiting for, in the language the page is in. */
export function waitingForLabel(waitingFor: string | undefined): string {
  if (waitingFor === undefined || waitingFor.length === 0) return unknownWord();
  const key = WAITING_KEYS[waitingFor];
  return key === undefined ? waitingFor : t(key);
}

/** The one subagent field this module reads. `Agent` from core satisfies it. */
export interface NeedsYouAgent {
  readonly state: 'running' | 'done' | 'unknown';
}

/**
 * A session, reduced to what the strip actually reads. `SessionView` satisfies
 * it, and the narrowness is the point: this module cannot start depending on a
 * field without the type saying so.
 */
export interface NeedsYouSession {
  readonly id: string;
  readonly cwd?: string;
  /**
   * N-WP17a: the ssh alias this session was read through, or absent when it is
   * on this machine. The strip draws it for the reason the card does — a mixed
   * canvas's first question is *which machine* — and it is on the session
   * rather than derived from the id so the two never disagree.
   */
  readonly host?: string;
  readonly status: ActivitySessionStatus;
  readonly state: 'alive' | 'unknown';
  readonly waitingFor?: string;
  readonly startedAt?: number;
  readonly transcriptAt?: number;
  readonly costUsd?: number;
  readonly treeTokens?: TokenLike;
  readonly agents: readonly NeedsYouAgent[];
}

/** When a session started waiting, and for what. */
export interface WaitSince {
  /**
   * The raw `waitingFor`, or the empty string for a session whose status is
   * `waiting` with no reason given. Held raw rather than translated so that
   * changing language does not read as the wait restarting.
   */
  readonly waitingFor: string;
  readonly since: number;
}

/** A session that finished while nobody was looking. */
export interface FinishedSince {
  readonly id: string;
  /** When it was first seen to have settled. */
  readonly at: number;
  readonly ranForMs?: number;
  readonly tokens?: TokenLike;
  readonly costUsd?: number;
}

/**
 * Everything the strip remembers between frames.
 *
 * In memory, for the life of the page. `active` is the previous frame's set of
 * sessions that were working or waiting, and it exists for one reason: a
 * session *finishing* is a transition, and a transition needs the frame before
 * it. Without it a canvas opened onto four idle sessions would announce all
 * four as having just finished.
 */
export interface NeedsYouState {
  readonly waiting: ReadonlyMap<string, WaitSince>;
  readonly active: ReadonlySet<string>;
  readonly finished: ReadonlyMap<string, FinishedSince>;
}

export const NO_NEEDS_YOU: NeedsYouState = {
  waiting: new Map(),
  active: new Set(),
  finished: new Map(),
};

/** True while a session has subagents still running. */
function hasRunningAgents(session: NeedsYouSession): boolean {
  // An `unknown` agent is not a running one. Nazar does not turn a missing
  // signal into a fact anywhere else and does not start here — the cost of
  // being wrong is a row that appears a little early, and the cost of the other
  // choice is a cluster that never fills on a machine with orphaned metadata.
  return session.agents.some((agent) => agent.state === 'running');
}

/**
 * Fold one frame of sessions into the memory.
 *
 * Three rules, and every one of them is a transition rather than a reading:
 *
 * - **A wait keeps its start** while the session goes on waiting *for the same
 *   thing*. A session that answers a permission prompt and immediately asks for
 *   input has been waiting for the second thing since now, not since the first
 *   — the number on the row is how long *this* question has gone unanswered.
 * - **A session that stops waiting loses its clock.** Waiting again later
 *   starts a new one, for the same reason.
 * - **A session finishes** when it had work in flight on the previous frame and
 *   has none on this one. It leaves the cluster when it picks work up again,
 *   when the window runs out, or when the machine stops listing it at all — a
 *   row whose card is gone could take you nowhere.
 *
 * One consequence of `activityOf`'s own rules is worth stating, because it
 * looks like a lag and is not: a transcript written inside the last thirty
 * seconds means *working*, so a session joins the cluster about half a minute
 * after its last write rather than the instant the model stops. That is the
 * same window the card's frame uses, and a shorter one would put sessions in
 * and out of this list while they think.
 */
export function observeSessions(
  state: NeedsYouState,
  sessions: readonly NeedsYouSession[],
  now: number,
  windowMs: number = FINISHED_WINDOW_MS,
): NeedsYouState {
  const waiting = new Map<string, WaitSince>();
  const active = new Set<string>();
  const finished = new Map<string, FinishedSince>();
  const live = new Set<string>();

  for (const session of sessions) {
    live.add(session.id);
    const activity = sessionActivity(session, now);
    /*
     * *In flight* is a wider question than the card's own activity word, and
     * deliberately so: a session whose last human turn was answered an hour ago
     * reads `idle` on the card while six subagents are still running under it,
     * because the activity of a *node* is about that node. A session is not
     * finished until its tree is, so the subagents are part of this answer.
     */
    const inFlight =
      activity === 'working' || activity === 'waiting' || hasRunningAgents(session);
    if (inFlight) active.add(session.id);

    if (isWaiting(session)) {
      const kind = session.waitingFor ?? '';
      const previous = state.waiting.get(session.id);
      waiting.set(session.id, {
        waitingFor: kind,
        since: previous !== undefined && previous.waitingFor === kind ? previous.since : now,
      });
    }

    const settled = !inFlight && activity === 'idle';
    const already = state.finished.get(session.id);
    if (already !== undefined && !inFlight) {
      finished.set(session.id, already);
    } else if (settled && state.active.has(session.id)) {
      finished.set(session.id, {
        id: session.id,
        at: now,
        ...(session.startedAt === undefined || session.transcriptAt === undefined
          ? {}
          : { ranForMs: Math.max(0, session.transcriptAt - session.startedAt) }),
        ...(session.treeTokens === undefined ? {} : { tokens: session.treeTokens }),
        ...(session.costUsd === undefined ? {} : { costUsd: session.costUsd }),
      });
    }
  }

  // The window, and the sessions the machine no longer lists. Both are removals
  // rather than filters at render time, so the memory cannot grow without bound
  // on a canvas left open for a week.
  for (const [id, record] of finished) {
    if (!live.has(id) || now - record.at > windowMs) finished.delete(id);
  }

  return { waiting, active, finished };
}

/** One row of the first cluster: a session with a question outstanding. */
export interface WaitingRow {
  readonly id: string;
  /** The card's own title: the name you typed, else the folder's last segment. */
  readonly label: string;
  /** The working directory, redacted exactly as the card draws it. */
  readonly folder: string;
  /** `@alias` when the session is on another machine, absent when it is here. */
  readonly host?: string;
  /** What it is waiting for, from the catalogue. */
  readonly what: string;
  readonly since: number;
  readonly waitedMs: number;
  /** `4m 07s`, the same formatting every other duration on the page uses. */
  readonly waited: string;
  /** The whole row as one sentence, for the button's `aria-label`. */
  readonly description: string;
}

/** The card's title for a session: the typed name first, then the folder. */
function labelFor(session: NeedsYouSession, names: Readonly<Record<string, string>>): string {
  return names[session.id] ?? basename(session.cwd);
}

/**
 * The first cluster, longest wait first.
 *
 * Ties are broken by session id rather than left to the order the registry
 * returned, so a list that is not moving does not reorder itself under the
 * pointer between two frames.
 */
export function waitingRows(
  state: NeedsYouState,
  sessions: readonly NeedsYouSession[],
  now: number,
  names: Readonly<Record<string, string>> = {},
): readonly WaitingRow[] {
  const rows: WaitingRow[] = [];
  for (const session of sessions) {
    const seen = state.waiting.get(session.id);
    if (seen === undefined) continue;
    const label = labelFor(session, names);
    const folder = orUnknown(session.cwd);
    const what = waitingForLabel(session.waitingFor);
    const waitedMs = Math.max(0, now - seen.since);
    const waited = formatDuration(waitedMs);
    const host = hostLabel(session.host);
    rows.push({
      id: session.id,
      label,
      folder,
      ...(host === undefined ? {} : { host }),
      what,
      since: seen.since,
      waitedMs,
      waited,
      description: t('needsYou.row', { name: label, folder, what, duration: waited }),
    });
  }
  rows.sort((a, b) => (a.since === b.since ? (a.id < b.id ? -1 : 1) : a.since - b.since));
  return rows;
}

/** One row of the second cluster: something that ended while you were away. */
export interface FinishedRow {
  readonly id: string;
  readonly label: string;
  readonly folder: string;
  /** `@alias` when the session was on another machine, absent when it was here. */
  readonly host?: string;
  /** How long the run took, or absent when no transcript timestamps bounded it. */
  readonly ranFor?: string;
  /** `12,043 in · 3,120 out`, or absent when nothing has been counted. */
  readonly tokens?: string;
  /** `$9.60`, or absent — which is the normal answer without the wrapper. */
  readonly cost?: string;
  /** `4m 07s ago`. */
  readonly ago: string;
  readonly description: string;
}

/**
 * The second cluster, newest first.
 *
 * A row is built from the record *and* the session, because the record is a
 * snapshot of the moment it settled — the duration and the totals of that run —
 * while the label and the folder are whatever the card says now, including a
 * name typed since.
 */
export function finishedRows(
  state: NeedsYouState,
  sessions: readonly NeedsYouSession[],
  now: number,
  names: Readonly<Record<string, string>> = {},
): readonly FinishedRow[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const rows: FinishedRow[] = [];
  for (const record of state.finished.values()) {
    const session = byId.get(record.id);
    if (session === undefined) continue;
    const label = labelFor(session, names);
    const folder = orUnknown(session.cwd);
    const ago = formatAge(Math.max(0, now - record.at));
    const cost = formatCostUsd(record.costUsd);
    const host = hostLabel(session.host);
    rows.push({
      id: record.id,
      label,
      folder,
      ...(host === undefined ? {} : { host }),
      ...(record.ranForMs === undefined
        ? {}
        : { ranFor: t('needsYou.ranFor', { duration: formatDuration(record.ranForMs) }) }),
      ...(record.tokens === undefined
        ? {}
        : {
            tokens:
              `${t('tokens.in', { count: formatCount(record.tokens.in) })} · ` +
              t('tokens.out', { count: formatCount(record.tokens.out) }),
          }),
      ...(cost === undefined ? {} : { cost }),
      ago,
      description: t('needsYou.finishedRow', { name: label, folder, ago }),
    });
  }
  rows.sort((a, b) => {
    const at = (row: FinishedRow): number => state.finished.get(row.id)?.at ?? 0;
    const difference = at(b) - at(a);
    return difference === 0 ? (a.id < b.id ? -1 : 1) : difference;
  });
  return rows;
}

/** Everything the badge in the top bar needs, worked out. */
export interface NeedsYouBadge {
  readonly count: number;
  /** `Needs you · 2`. */
  readonly label: string;
  /** How long the one at the top has been waiting: `12m 04s`. */
  readonly longest: string;
  /** The whole thing as one sentence, for the button's `aria-label`. */
  readonly description: string;
}

/**
 * The badge, or `undefined` when nobody is waiting.
 *
 * `undefined` is the whole of "hide it": there is no `Needs you · 0`, for the
 * same reason there is no empty usage bead. A control that is always there and
 * usually says nothing is a control people stop reading.
 */
export function needsYouBadge(rows: readonly WaitingRow[]): NeedsYouBadge | undefined {
  const longest = rows[0];
  if (longest === undefined) return undefined;
  return {
    count: rows.length,
    label: t('needsYou.badge', { count: rows.length }),
    longest: longest.waited,
    description: tCount('needsYou.badgeLabel', rows.length, { duration: longest.waited }),
  };
}

/**
 * What a screen reader is told when the count changes.
 *
 * It is announced from a region that stays in the page whether the badge is
 * drawn or not: "nobody is waiting for you" is exactly the sentence somebody
 * wants when the badge has just gone away, and a hidden element announces
 * nothing.
 */
export function needsYouAnnouncement(rows: readonly WaitingRow[]): string {
  return rows.length === 0 ? t('needsYou.nobody') : tCount('needsYou.live', rows.length);
}

/** The panel's title. */
export function needsYouTitle(): string {
  return t('needsYou.title');
}

/** The heading over the second cluster. */
export function finishedTitle(): string {
  return t('needsYou.finished');
}

/** What an empty panel says, plus how old the reading behind it is. */
export function needsYouEmpty(generatedAt: number | undefined, now: number): string {
  if (generatedAt === undefined) return t('needsYou.nobody');
  return `${t('needsYou.nobody')} ${t('needsYou.checked', { age: formatAge(Math.max(0, now - generatedAt)) })}`;
}
