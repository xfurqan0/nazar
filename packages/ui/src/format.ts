/**
 * Turning numbers into the strings the canvas draws.
 *
 * Two rules, both from docs/PROJECT.md, and both easy to break by accident:
 *
 * 1. **Tokens are exact.** No `k`, no `M`, no `≈`. The whole point of the
 *    `(message.id, requestId)` dedupe is that the number is right; rounding it
 *    on the way to the screen throws that away. Grouping separators are fine —
 *    they do not change the value.
 * 2. **A field no source filled reads `unknown`.** Never blank, never `0`.
 *    `0` is a measurement; `unknown` is the absence of one, and a monitoring
 *    tool that confuses the two is worse than no tool.
 */

import { t, tCount } from './i18n.js';

/** What every formatter returns when it was given nothing to format. */
/**
 * The word every reading that could not be taken falls back to.
 *
 * N-WP13 turned it from a constant into a call. It is read out of the
 * catalogue on every use rather than captured once, because the language can
 * change while the page is up and a captured word would be the old language's.
 */
export function unknownWord(): string {
  return t('word.unknown');
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * A duration, at two levels of precision: `8s`, `4m 07s`, `2h 14m`, `3d 04h`.
 * Negative and non-finite inputs are treated as absent rather than clamped,
 * because a negative elapsed time means a clock disagreement worth showing.
 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return unknownWord();
  if (ms < MINUTE) return `${Math.floor(ms / SECOND)}s`;
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ${pad(Math.floor((ms % MINUTE) / SECOND))}s`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ${pad(Math.floor((ms % HOUR) / MINUTE))}m`;
  return `${Math.floor(ms / DAY)}d ${pad(Math.floor((ms % DAY) / HOUR))}h`;
}

/** Elapsed time between a start and now. `undefined` start reads `unknown`. */
export function formatElapsed(startedAt: number | undefined, now: number): string {
  if (startedAt === undefined || !Number.isFinite(startedAt)) return unknownWord();
  return formatDuration(now - startedAt);
}

/**
 * How long ago something was written. Transcripts are flushed asynchronously,
 * so this age is shown next to every token total rather than hidden.
 */
export function formatAge(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return unknownWord();
  if (ms < 2 * SECOND) return t('time.justNow');
  return t('time.ago', { duration: formatDuration(ms) });
}

/** An exact integer with grouping separators. `undefined` reads `unknown`. */
export function formatCount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return unknownWord();
  return Math.trunc(value).toLocaleString('en-US');
}

/**
 * Why `cache r` dwarfs the other three, said in three words on the card.
 *
 * A cache read is the *whole* prompt prefix being re-read, once per request,
 * so the total is a running sum of context sizes and not a count of new
 * tokens. Measured on one real 25-hour session on the maintainer's machine:
 * 294 requests, a median context of 335 K, a cache-read total of 96.2 M
 * against 224.8 K output tokens. It looks wrong at a glance and is not, which
 * is exactly what a tooltip is for. README "Known limits" carries the long
 * version.
 */
export function cacheReadNote(): string {
  return t('hover.cacheReadNote');
}

/** The four counters as one line: `in / out / cache r / cache w`. */
export interface TokenLike {
  readonly in?: number;
  readonly out?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

/**
 * `12,043 in · 3,120 out · 88,410 r · 4,096 w`, or `unknown` when no transcript
 * line has been counted yet. A partially filled object still prints every
 * field, so a missing counter is visible as `unknown` instead of vanishing.
 */
export function formatTokens(tokens: TokenLike | undefined): string {
  if (tokens === undefined) return unknownWord();
  return [
    t('tokens.in', { count: formatCount(tokens.in) }),
    t('tokens.out', { count: formatCount(tokens.out) }),
    t('tokens.cacheRead', { count: formatCount(tokens.cacheRead) }),
    t('tokens.cacheWrite', { count: formatCount(tokens.cacheWrite) }),
  ].join(' · ');
}

/**
 * N-WP15: `33k`. The one number on the canvas that is deliberately rounded,
 * and the one place it is allowed to be.
 *
 * The card carries a *magnitude* — is this session a small one or a big one —
 * and `33,215` answers that question with four digits nobody reads and one they
 * do. The exact figures are one hover away, split into the four counters that
 * make them meaningful, and `formatCount` is still exact everywhere it is used.
 * So this rounds and says nothing else: no `≈`, no decimals below 10k, and
 * `unknown` rather than `0` when no transcript line has been counted.
 *
 * **Input and output only.** A cache read is the whole prompt prefix re-read
 * once per request, so adding it would put a number three orders of magnitude
 * larger on the card and call it "the tokens" — see `cacheReadNote`.
 */
export function formatTotal(tokens: TokenLike | undefined): string {
  if (tokens === undefined) return unknownWord();
  const { in: input, out } = tokens;
  if (input === undefined && out === undefined) return unknownWord();
  const total = (Number.isFinite(input) ? (input as number) : 0) +
    (Number.isFinite(out) ? (out as number) : 0);
  return formatShort(total);
}

/**
 * `912`, `33k`, `1.3M`. Whole units under a thousand, one decimal only where it
 * is the difference between `1M` and `1.3M`.
 */
function formatShort(value: number): string {
  if (!Number.isFinite(value)) return unknownWord();
  const n = Math.trunc(Math.abs(value));
  const sign = value < 0 ? '-' : '';
  if (n < 1000) return `${sign}${n}`;
  if (n < 1_000_000) {
    const thousands = n / 1000;
    return `${sign}${thousands < 10 ? trim(thousands) : Math.round(thousands)}k`;
  }
  return `${sign}${trim(n / 1_000_000)}M`;
}

/** One decimal, and not a trailing `.0`. */
function trim(value: number): string {
  const one = Math.round(value * 10) / 10;
  return Number.isInteger(one) ? String(one) : one.toFixed(1);
}

/* ------------------------------------------------------------------ *
 * WP3': the two fields the status-line capture brings
 * ------------------------------------------------------------------ */

/**
 * `$9.60`. Two decimals, because that is what money has.
 *
 * The payload reports `9.60050075`, and every digit past the cent comes from a
 * per-token price rather than from precision anyone can act on. This is the one
 * number on the canvas that is deliberately rounded, and it rounds to the
 * nearest cent rather than down: it is a cost already incurred, not a budget
 * being approached, so rounding down would be the direction that flatters.
 *
 * `undefined` in, `undefined` out — the caller draws no row at all rather than
 * a row reading `unknown`.
 */
export function formatCostUsd(usd: number | undefined): string | undefined {
  if (usd === undefined || !Number.isFinite(usd) || usd < 0) return undefined;
  return `$${usd.toFixed(2)}`;
}

/** What `formatContextWindow` needs. `SessionContextWindow` satisfies it. */
export interface ContextLike {
  readonly used?: number;
  readonly size?: number;
  readonly percent?: number;
}

/**
 * `159,283 / 1,000,000 (16%)`, and less of it when the payload said less.
 *
 * The percentage is the payload's own `used_percentage` rather than a division
 * done here, so the canvas and the status line can never disagree by a rounding
 * step about the same window. It is floored, like every other percentage Nazar
 * draws.
 */
export function formatContextWindow(context: ContextLike | undefined): string | undefined {
  if (context === undefined) return undefined;
  const { used, size, percent } = context;
  const counts =
    used !== undefined && size !== undefined
      ? `${formatCount(used)} / ${formatCount(size)}`
      : used !== undefined
        ? t('context.used', { used: formatCount(used) })
        : undefined;
  const share =
    percent === undefined || !Number.isFinite(percent) ? undefined : `${Math.floor(percent)}%`;
  if (counts === undefined) return share;
  return share === undefined ? counts : `${counts} (${share})`;
}

/**
 * WP4e: the two capture fields, as the words they are read as on a card.
 *
 * WP5 put them on the card as one muted line, `$9.60   ctx 54%`, next to four
 * token counters — and the maintainer, who has the wrapper installed, did not
 * find them. Two things were wrong with that line and both are fixed here:
 * `ctx` is jargon for a thing the rest of the interface spells out, and a
 * number with no word in front of it is invisible in a column of numbers. So
 * each is labelled, and each is its own row on the card.
 *
 * Both still answer `undefined` when there is no capture, because the rule they
 * were built under has not changed: a machine with no status-line wrapper loses
 * the row rather than gaining one that says `unknown` for ever.
 */
export function cardCostLabel(usd: number | undefined): string | undefined {
  const money = formatCostUsd(usd);
  return money === undefined ? undefined : t('card.cost', { money });
}

/**
 * `context 54 %`, or the counts when the payload gave no percentage.
 *
 * The percentage is the headline because it is the number a person acts on —
 * "am I about to be compacted" — and the exact counts stay one hover away on
 * the card, where there is room for `159,283 / 1,000,000 (16%)`.
 */
export function cardContextLabel(context: ContextLike | undefined): string | undefined {
  if (context === undefined) return undefined;
  const { percent } = context;
  if (percent !== undefined && Number.isFinite(percent)) {
    return t('card.contextPercent', { percent: Math.floor(percent) });
  }
  const full = formatContextWindow(context);
  return full === undefined ? undefined : t('card.context', { value: full });
}

/* ------------------------------------------------------------------ *
 * WP4f: a blank with a reason
 * ------------------------------------------------------------------ */

/**
 * The line a card draws where cost and context would have gone, when the reason
 * they are missing is one Nazar can actually name.
 *
 * Short, because it shares a line with nothing and still has to fit the
 * narrowest card. The sentence that says what to *do* is the tooltip below: a
 * card is not the place for a file path and a settings key.
 */
export function captureBlockedLabel(): string {
  return t('card.captureBlocked');
}

/** The whole explanation, on hover, and the fix. `nazar doctor` names the file. */
export function captureBlockedNote(): string {
  return t('card.captureBlockedNote');
}

/**
 * WP4g: what the title strip says on hover, before and after it has a name.
 *
 * The second sentence is the whole privacy statement in one line, and it is
 * said on the control rather than buried in a settings panel: a label typed
 * here is a note this browser keeps about a session, not something Nazar sends
 * anywhere or writes into anybody's terminal.
 */
export function renameNote(named: boolean): string {
  return t(named ? 'card.renameNoteSet' : 'card.renameNote');
}

/**
 * WP4g: how to make the *terminal* agree with a card's name.
 *
 * Nazar reads the machine and never writes to it, so it cannot rename a
 * session; the user can, in one line, in that session. The card menu prints
 * this instead of pretending the two titles are the same thing — and it
 * matters, because the jump matcher matches terminal titles and not card
 * labels, so a converged pair is a jump that finds the right window.
 */
export function renameTerminalHint(): string {
  return t('menu.renameTerminalHint');
}

/** What a corner grip says on hover: a corner scales the whole card. */
export function resizeNote(): string {
  return t('card.resizeCorner');
}

/** What an edge grip says on hover: one axis moves, the opposite edge holds. */
export function resizeEdgeNote(): string {
  return t('card.resizeEdge');
}

/**
 * Last segment of a path, on either separator, with any trailing separator
 * ignored. A drive root (`C:\`) keeps its drive letter rather than collapsing
 * to an empty label.
 */
export function basename(value: string | undefined): string {
  if (value === undefined || value.length === 0) return unknownWord();
  const trimmed = value.replace(/[\\/]+$/, '');
  if (trimmed.length === 0) return value;
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const name = cut === -1 ? trimmed : trimmed.slice(cut + 1);
  return name.length === 0 ? trimmed : name;
}

/**
 * The chip label for a model. `claude-opus-5[1m]` becomes `opus-5[1m]`: the
 * provider is already on the badge, so repeating it costs a chip's width for
 * nothing. The full id stays in the hover card.
 */
export function modelChip(model: string | undefined): string {
  if (model === undefined || model.length === 0) return unknownWord();
  return model.replace(/^claude-/, '').replace(/^gpt-/, '');
}

/** A label that is never empty. Used everywhere a source may have said nothing. */
export function orUnknown(value: string | undefined): string {
  return value === undefined || value.length === 0 ? unknownWord() : value;
}

/* ------------------------------------------------------------------ *
 * Collapsed trees (WP4c)
 * ------------------------------------------------------------------ */

/** The only field `summarize` reads. `Agent` from `@nazar/core` satisfies it. */
export interface StateLike {
  readonly state: 'running' | 'done' | 'unknown';
}

export interface TreeSummary {
  readonly total: number;
  readonly running: number;
  readonly done: number;
  readonly unknown: number;
}

/** Count a session's subagents by state. */
export function summarize(agents: readonly StateLike[]): TreeSummary {
  let running = 0;
  let done = 0;
  let unknown = 0;
  for (const agent of agents) {
    if (agent.state === 'running') running += 1;
    else if (agent.state === 'done') done += 1;
    else unknown += 1;
  }
  return { total: agents.length, running, done, unknown };
}

/**
 * The chips a folded card shows: `62 subagents`, `3 running`, `59 done`.
 *
 * A count of zero is left out rather than drawn as `0 running`, because the
 * point of folding a sixty-agent tree away is to get one glance-sized line —
 * except for the total, which is the reason the card is folded and is shown
 * even when it is zero.
 */
export function summaryChips(summary: TreeSummary): string[] {
  const chips = [tCount('chip.subagents', summary.total, { count: formatCount(summary.total) })];
  if (summary.running > 0) chips.push(t('chip.running', { count: formatCount(summary.running) }));
  if (summary.done > 0) chips.push(t('chip.done', { count: formatCount(summary.done) }));
  if (summary.unknown > 0) {
    chips.push(t('chip.unknown', { count: formatCount(summary.unknown) }));
  }
  return chips;
}
