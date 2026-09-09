/**
 * WP4b: the history drawer.
 *
 * A side panel listing every session Claude Code still has a transcript for,
 * grouped by project and newest write first. Selecting one hands the frozen
 * tree back to the canvas, which draws it with the same node components as the
 * live one.
 *
 * Two properties this file is written around:
 *
 * - **It costs nothing until it is opened.** The list request is the first
 *   thing that touches the transcript store at all, and a session's transcript
 *   is not read until its row is activated. That is why a row shows `unknown`
 *   for model and tokens until it has been opened once: those numbers can only
 *   come from inside the file, and guessing them from a directory entry would
 *   be inventing a measurement (docs/pinned-internal-formats.md, rule 3).
 * - **It works from the keyboard.** Every row is a real `<button>` in a real
 *   list, the drawer takes focus when it opens and gives it back when it
 *   closes, and Escape closes it. A monitoring panel nobody can tab through is
 *   a panel half the people who need it cannot use.
 *
 * N-WP20 added two more, both of them "what the screen shows must be true":
 *
 * - **The listing reaches the whole store.** It used to ask for 200 rows and
 *   stop, on a store the server was already telling it had more — the drawer
 *   said "200 of 1 340" and offered no way to the other 1 140. Pages are now
 *   appended, by a button and by scrolling to the end of the list.
 * - **Only the newest request may write to the screen.** Selecting A and then B
 *   used to show whichever answer came back last, and an answer arriving after
 *   the drawer closed re-opened it — with the back button no longer connected
 *   to anything. Every selection carries a sequence number; a stale one is
 *   dropped rather than drawn, and closing invalidates whatever is in flight.
 */
import type { History, HistoryListPage, HistorySummary } from '@nazar/core';

import { formatCount, formatDuration, orUnknown, unknownWord } from '../src/format.ts';
import { t, tCount } from '../src/i18n.ts';
import {
  formatBytes,
  formatStamp,
  groupByProject,
  shortSessionId,
} from '../src/history-view.ts';
import { withTaskQuery } from '../src/task-text.ts';
import { clear, html, setClass, setText } from './dom.ts';

/** Sessions asked for in one page. More pages are appended on demand. */
const PAGE_SIZE = 200;

/**
 * How close to the bottom of the list counts as "at the end", in CSS pixels.
 * One row is about 44 px, so this fires with a row and a half still to go —
 * early enough that the next page is usually there before the scroll stops.
 */
const NEAR_END_PX = 64;

export interface HistoryTransport {
  list(limit: number, offset?: number): Promise<HistoryListPage>;
  /**
   * N-WP20. `signal` aborts a request whose answer nobody wants any more —
   * a second selection, or the drawer closing. Optional because the panel is
   * correct without it: a stale answer is dropped on arrival either way, and
   * aborting only saves the work.
   */
  open(sessionId: string, signal?: AbortSignal): Promise<History | undefined>;
  /**
   * Every session id the store holds, in one answer.
   *
   * Not used by the drawer at all — it is what the canvas prunes against, and
   * it lives here because this is the module that owns talking to the history
   * routes. A rejection must leave the caller forgetting nothing.
   */
  ids(): Promise<readonly string[]>;
}

export interface HistoryPanelOptions {
  readonly root: HTMLElement;
  readonly transport: HistoryTransport;
  /** A session was chosen: draw its frozen tree. */
  readonly onSelect: (history: History) => void;
  /** The drawer closed. The canvas goes back to live. */
  readonly onClose: () => void;
  /**
   * WP4g: the project a slug belongs to, when the user has made one of that
   * folder. `undefined` for every other group, which is most of them.
   *
   * The listing groups by the `~/.claude/projects` directory name and always
   * has — that is the only thing a past session carries, because a transcript's
   * `cwd` is on the never-extracted list. This does not change the grouping; it
   * puts the name you chose in front of the slug, so the drawer and the tab bar
   * use the same word for the same folder.
   */
  readonly projectNameFor?: (project: string) => string | undefined;
}

/**
 * Fetch over the local server. The only network this page ever does.
 *
 * N-WP15a: `taskText` is asked at each call rather than captured once, because
 * the switch can be thrown while the drawer is open — and a frozen session
 * opened after it was thrown has to answer the way the live canvas does. The
 * *listing* deliberately does not carry it: a listing is `readdir` and `stat`
 * and opens no transcript, so there is no task in one to ask for.
 */
export function httpTransport(taskText: () => boolean = () => false): HistoryTransport {
  return {
    list: async (limit, offset = 0) => {
      const response = await fetch(`/api/history?limit=${limit}&offset=${offset}`);
      if (!response.ok) throw new Error(`history list failed: ${response.status}`);
      return (await response.json()) as HistoryListPage;
    },
    open: async (sessionId, signal) => {
      const response = await fetch(
        withTaskQuery(`/api/history/${encodeURIComponent(sessionId)}`, taskText()),
        {
          ...(signal === undefined ? {} : { signal }),
        },
      );
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`history open failed: ${response.status}`);
      return (await response.json()) as History;
    },
    ids: async () => {
      const response = await fetch('/api/history/ids');
      if (!response.ok) throw new Error(`history ids failed: ${response.status}`);
      const body = (await response.json()) as { sessionIds?: unknown };
      // A shape we do not recognise is not an empty store: answering with `[]`
      // here would tell the canvas that every session it remembers is gone.
      if (!Array.isArray(body.sessionIds)) {
        throw new Error(`history ids: expected an array, got ${typeof body.sessionIds}`);
      }
      return body.sessionIds.filter((id): id is string => typeof id === 'string');
    },
  };
}

export class HistoryPanel {
  private readonly root: HTMLElement;

  private readonly transport: HistoryTransport;

  private readonly onSelect: (history: History) => void;

  private readonly onClose: () => void;

  private readonly projectNameFor: (project: string) => string | undefined;

  private readonly listNode: HTMLDivElement;

  private readonly statusNode: HTMLParagraphElement;

  private readonly titleNode: HTMLHeadingElement;

  private readonly closeButton: HTMLButtonElement;

  private readonly rows = new Map<string, HTMLButtonElement>();

  private readonly moreButton: HTMLButtonElement;

  /** The newest page read, for the counts line and `nextOffset`. */
  private page: HistoryListPage | undefined;

  /** Every row read so far, in listing order. Pages are appended, not replaced. */
  private loaded: HistorySummary[] = [];

  private selected: string | undefined;

  private loading = false;

  /**
   * N-WP20. Bumped by every selection and by every close. An answer whose
   * number is no longer this one belongs to a question the user has moved on
   * from, and drawing it would put the wrong tree on the canvas — or re-open a
   * drawer they had closed, with a back button that no longer led anywhere.
   */
  private selectSeq = 0;

  /** Aborts the request in flight, where the browser gives us one. */
  private pending: AbortController | undefined;

  /** Where focus came from, so closing puts it back. */
  private opener: HTMLElement | undefined;

  constructor(options: HistoryPanelOptions) {
    this.root = options.root;
    this.transport = options.transport;
    this.onSelect = options.onSelect;
    this.onClose = options.onClose;
    this.projectNameFor = options.projectNameFor ?? ((): undefined => undefined);

    const header = html('div', 'nz-history__head');
    const title = html('h2', 'nz-history__title');
    const close = html('button', 'nz-button');
    close.type = 'button';
    close.addEventListener('click', () => this.close());
    header.append(title, close);
    this.titleNode = title;
    this.closeButton = close;

    this.statusNode = html('p', 'nz-history__status');
    this.listNode = html('div', 'nz-history__list');

    // N-WP20. The way to the rest of the store, for anybody who does not
    // scroll — and the thing a keyboard user tabs to after the last row.
    const more = html('button', 'nz-history__more');
    more.type = 'button';
    more.hidden = true;
    more.addEventListener('click', () => {
      void this.loadMore();
    });
    this.moreButton = more;

    // And the same thing by gesture: reaching the end of the list is the other
    // way people say "show me more of this".
    this.listNode.addEventListener('scroll', () => {
      const node = this.listNode;
      if (node.scrollHeight - node.scrollTop - node.clientHeight > NEAR_END_PX) return;
      void this.loadMore();
    });

    this.root.append(header, this.statusNode, this.listNode, more);
    this.root.setAttribute('role', 'region');
    this.root.hidden = true;
    this.retranslate();

    this.root.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      this.close();
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /**
   * WP4g: the listing, if one has been read. `undefined` means nobody has
   * asked yet — which is not the same as "no past sessions", and the sidebar's
   * project counts say `—` rather than `0` because of it.
   */
  get listed(): readonly HistorySummary[] | undefined {
    return this.page === undefined ? undefined : this.loaded;
  }

  /** Rows on screen. N-WP20's paging is asserted through this, not through markup. */
  get rowCount(): number {
    return this.rows.size;
  }

  /** True while there is another page to append. */
  get hasMore(): boolean {
    return this.page?.nextOffset !== undefined;
  }

  /** Draw the listing again, after the projects it is labelled with changed. */
  repaint(): void {
    if (this.page !== undefined) this.render();
  }

  /** Open the drawer, loading the listing the first time. */
  open(opener?: HTMLElement): void {
    if (this.isOpen) return;
    this.opener = opener;
    this.root.hidden = false;
    void this.refresh();
    // The heading is not focusable, so focus lands on the first control.
    const first = this.root.querySelector<HTMLElement>('button');
    first?.focus();
  }

  close(): void {
    if (!this.root.hidden) {
      this.root.hidden = true;
      // N-WP20. Whatever was being fetched is now an answer to a question that
      // no longer exists. Invalidating it here is what stops a slow response
      // from re-opening the drawer a moment after somebody closed it.
      this.selectSeq += 1;
      this.pending?.abort();
      this.pending = undefined;
      this.onClose();
      this.opener?.focus();
    }
  }

  toggle(opener?: HTMLElement): void {
    if (this.isOpen) this.close();
    else this.open(opener);
  }

  /**
   * Rewrite every word this view owns, in the language now in force.
   *
   * The listing itself is rebuilt by `render`, which is called when there is a
   * page to redraw; the header and the region label are written once and have
   * to be rewritten here.
   */
  retranslate(): void {
    setText(this.titleNode, t('history.title'));
    setText(this.closeButton, t('frozen.back'));
    this.closeButton.setAttribute('aria-label', t('history.closeLabel'));
    this.root.setAttribute('aria-label', t('history.region'));
    if (this.page !== undefined) this.render();
  }

  /**
   * Re-read the listing. Opens no transcript: this is a directory walk.
   *
   * N-WP20: it re-reads *as many pages as are already on screen*, so the one
   * caller that refreshes for a reason — a row that has just been opened and
   * now knows its own numbers — does not silently throw the pages the user
   * loaded back away.
   */
  async refresh(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    setText(this.statusNode, t('history.reading'));
    const pages = Math.max(1, Math.ceil(this.loaded.length / PAGE_SIZE));
    try {
      const rows: HistorySummary[] = [];
      let last: HistoryListPage | undefined;
      for (let index = 0; index < pages; index += 1) {
        const page = await this.transport.list(PAGE_SIZE, index * PAGE_SIZE);
        last = page;
        rows.push(...page.sessions);
        if (page.nextOffset === undefined) break;
      }
      if (last === undefined) return;
      this.page = last;
      this.loaded = rows;
      this.render();
    } catch {
      this.page = undefined;
      this.loaded = [];
      clear(this.listNode);
      this.rows.clear();
      this.moreButton.hidden = true;
      setText(this.statusNode, t('history.unreadable'));
    } finally {
      this.loading = false;
    }
  }

  /**
   * Append the next page, if there is one.
   *
   * N-WP20. Before this, the drawer asked for 200 rows and stopped — on a
   * machine with more, it printed "200 of 1 340" and offered no route to the
   * other 1 140, while the server had been returning a `nextOffset` for them
   * the whole time.
   */
  async loadMore(): Promise<void> {
    const from = this.page?.nextOffset;
    if (this.loading || from === undefined) return;
    this.loading = true;
    setText(this.statusNode, t('history.reading'));
    try {
      const page = await this.transport.list(PAGE_SIZE, from);
      // A page that arrived for an offset we have already passed is a duplicate
      // click, not more sessions.
      if (page.offset === from) {
        this.page = page;
        this.loaded = [...this.loaded, ...page.sessions];
      }
      this.render();
    } catch {
      // The pages already read stay on screen: failing to fetch the next one is
      // not a reason to lose the ones that worked.
      setText(this.statusNode, t('history.unreadable'));
    } finally {
      this.loading = false;
    }
  }

  private render(): void {
    const page = this.page;
    clear(this.listNode);
    this.rows.clear();
    this.moreButton.hidden = true;
    if (page === undefined) return;

    if (this.loaded.length === 0) {
      setText(this.statusNode, t('history.empty'));
      return;
    }

    const shown = this.loaded.length;
    setText(
      this.statusNode,
      t('history.counts', {
        shown: formatCount(shown),
        total: formatCount(page.total),
        projects: formatCount(page.projects.length),
        ms: formatCount(page.listMs),
      }),
    );

    // N-WP20. Shown whenever the server says more follow, and labelled with how
    // many: "load more" alone leaves somebody guessing whether it is two rows
    // or two thousand.
    const remaining = Math.max(0, page.total - shown);
    this.moreButton.hidden = page.nextOffset === undefined;
    if (!this.moreButton.hidden) {
      setText(
        this.moreButton,
        tCount('history.loadMore', remaining, { count: formatCount(remaining) }),
      );
    }

    // The grouping runs over every page read so far, not over the last one: a
    // project split across a page boundary is one heading, not two.
    for (const group of groupByProject(this.loaded)) {
      const section = html('section', 'nz-history__group');
      const heading = html('h3', 'nz-history__project');
      // WP4g. The slug stays: it is the directory these transcripts are
      // actually in, and it is what `nazar doctor` prints. The project name
      // goes in front of it, and only when the user has made one.
      const projectName = this.projectNameFor(group.project);
      setText(heading, projectName ?? group.project);
      heading.title =
        projectName === undefined ? group.project : `${projectName} — ${group.project}`;
      if (projectName !== undefined) {
        setClass(heading, 'is-project', true);
        const slug = html('span', 'nz-history__slug');
        setText(slug, group.project);
        heading.append(slug);
      }

      const list = html('ul', 'nz-history__rows');
      for (const summary of group.sessions) {
        const item = html('li');
        item.append(this.rowFor(summary));
        list.append(item);
      }

      section.append(heading, list);
      this.listNode.append(section);
    }
  }

  private rowFor(summary: HistorySummary): HTMLButtonElement {
    const button = html('button', 'nz-hrow');
    button.type = 'button';
    button.dataset['sessionId'] = summary.sessionId;
    setClass(button, 'is-selected', this.selected === summary.sessionId);

    const when = html('span', 'nz-hrow__when');
    setText(when, formatStamp(summary.lastWriteAt));

    const id = html('span', 'nz-hrow__id');
    setText(id, shortSessionId(summary.sessionId));

    const facts = html('span', 'nz-hrow__facts');
    // The three cheap facts are always there; the three measured ones only
    // after this session has been opened, because only then has anything read
    // the file. `unknown` is the honest state, not a placeholder for zero.
    setText(
      facts,
      [
        t('history.agents', {
          count: summary.agentCount === undefined ? unknownWord() : formatCount(summary.agentCount),
        }),
        formatBytes(summary.transcriptBytes),
        summary.hydrated ? formatDuration(summary.durationMs) : unknownWord(),
        summary.hydrated ? orUnknown(summary.model) : unknownWord(),
        summary.hydrated
          ? t('tokens.out', { count: formatCount(summary.treeTokens?.out ?? summary.tokens?.out) })
          : t('history.tokensUnknown', { unknown: unknownWord() }),
      ].join(' · '),
    );

    button.append(when, id, facts);
    button.setAttribute(
      'aria-label',
      t('history.openLabel', {
        session: shortSessionId(summary.sessionId),
        project: summary.project,
        written: formatStamp(summary.lastWriteAt),
        subagents: tCount('history.openSubagents', summary.agentCount ?? 0, {
          count: summary.agentCount === undefined ? unknownWord() : formatCount(summary.agentCount),
        }),
      }),
    );
    button.addEventListener('click', () => {
      void this.select(summary.sessionId);
    });

    this.rows.set(summary.sessionId, button);
    return button;
  }

  /**
   * Open one session. The first read of any transcript in this whole flow.
   *
   * N-WP20. Everything after the `await` is guarded by a sequence number,
   * because between asking and answering the user may have clicked a different
   * row or closed the drawer entirely — and a transcript can take a second to
   * parse. The two bugs this closes were both "an old answer wrote to the
   * screen": clicking A then B showed A's tree because A's request finished
   * last, and closing the drawer while a request was in flight re-opened it
   * onto a frozen tree whose back button no longer led anywhere.
   */
  private async select(sessionId: string): Promise<void> {
    const seq = (this.selectSeq += 1);
    const row = this.rows.get(sessionId);
    if (row !== undefined) setClass(row, 'is-loading', true);

    this.pending?.abort();
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
    this.pending = controller;

    /** Is this answer still the one the user is waiting for? */
    const current = (): boolean => seq === this.selectSeq && this.isOpen;

    try {
      const history = await this.transport.open(sessionId, controller?.signal);
      if (!current()) return;
      if (history === undefined) {
        setText(this.statusNode, t('history.gone'));
        return;
      }
      for (const [id, node] of this.rows) setClass(node, 'is-selected', id === sessionId);
      this.selected = sessionId;
      this.onSelect(history);
      // The row now knows its own numbers, so the listing can show them.
      void this.refresh();
    } catch {
      if (current()) setText(this.statusNode, t('history.openFailed'));
    } finally {
      if (this.pending === controller) this.pending = undefined;
      if (row !== undefined) setClass(row, 'is-loading', false);
    }
  }
}
