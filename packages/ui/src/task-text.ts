/**
 * N-WP15a: whether this browser shows the task line, and where that is kept.
 *
 * Nazar's rule has always been *metadata only* — how much and how long, never
 * what. This is the one place the rule is relaxed, and the shape of the relaxing
 * is the point:
 *
 * - **Off, always, until somebody switches it on.** A fresh install, a new
 *   browser, a private window, a machine where storage was cleared: all of them
 *   show no task text. The default is never inherited from anywhere.
 * - **Per browser, and only this browser.** It lives in `localStorage` on the
 *   canvas's own origin, like the layout, the tabs, the notes and the card
 *   names. It is not sent anywhere, not written to disk by the server, and not
 *   shared with a second browser on the same machine.
 * - **The browser only gets to *ask*.** The server answers with task text only
 *   for a request that carries `?task=1`, and only when it was started without
 *   `--no-task-text`. A switch that is on in a browser talking to a server that
 *   refuses simply shows nothing, which is the correct precedence: the machine's
 *   owner outranks the page.
 *
 * The storage shape is the one every other preference in this package uses — a
 * versioned object rather than a bare `"true"` — so a later setting can join it
 * without a migration, and a value written by something else reads as off.
 */
import type { StorageLike } from './workspace.js';

/** Where the choice is kept. Absent until somebody makes one. */
export const TASK_TEXT_KEY = 'nazar.taskText.v1';

/**
 * Whether this browser wants the task line.
 *
 * Anything other than a document this function itself wrote reads as **off**: a
 * missing key, unparseable JSON, a value of the wrong shape, or a storage that
 * threw. "Off" is the safe answer to every question this can fail to answer,
 * which is why there is no third state and no error to report.
 */
export function readTaskText(storage: StorageLike): boolean {
  let raw: string | null;
  try {
    raw = storage.getItem(TASK_TEXT_KEY);
  } catch {
    return false;
  }
  if (raw === null) return false;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { on?: unknown }).on === true
    );
  } catch {
    return false;
  }
}

/** Remember the choice. A storage that refuses is not worth an error here. */
export function writeTaskText(storage: StorageLike, on: boolean): void {
  try {
    storage.setItem(TASK_TEXT_KEY, JSON.stringify({ v: 1, on }));
  } catch {
    // A private window with storage disabled still gets a working canvas; it
    // just forgets the switch on reload, which is the harmless half of the
    // trade and the same one `notes.ts` and `names.ts` make.
  }
}

/**
 * The query string a data request carries, given the choice.
 *
 * One function so the SSE subscription and the history fetch cannot drift: they
 * are two channels showing one canvas, and a card whose task line appears live
 * and vanishes in history would be a bug that only shows up in the last place
 * anybody looks.
 */
export function taskQuery(on: boolean): string {
  return on ? 'task=1' : '';
}

/** Append {@link taskQuery} to a path that may already carry a query string. */
export function withTaskQuery(path: string, on: boolean): string {
  const query = taskQuery(on);
  if (query.length === 0) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${query}`;
}
