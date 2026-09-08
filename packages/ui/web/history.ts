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
import { clear, html, setClass, setText } from './dom.ts';

/** Sessions asked for in one page. The panel scrolls; it does not paginate. */
const PAGE_SIZE = 200;

export interface HistoryTransport {
  list(limit: number): Promise<HistoryListPage>;
  open(sessionId: string): Promise<History | undefined>;
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

/** Fetch over the local server. The only network this page ever does. */
export function httpTransport(): HistoryTransport {
  return {
    list: async (limit) => {
      const response = await fetch(`/api/history?limit=${limit}`);
      if (!response.ok) throw new Error(`history list failed: ${response.status}`);
      return (await response.json()) as HistoryListPage;
    },
    open: async (sessionId) => {
      const response = await fetch(`/api/history/${encodeURIComponent(sessionId)}`);
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`history open failed: ${response.status}`);
      return (await response.json()) as History;
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

  private page: HistoryListPage | undefined;

  private selected: string | undefined;

  private loading = false;

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

    this.root.append(header, this.statusNode, this.listNode);
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
    return this.page?.sessions;
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

  /** Re-read the listing. Opens no transcript: this is a directory walk. */
  async refresh(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    setText(this.statusNode, t('history.reading'));
    try {
      this.page = await this.transport.list(PAGE_SIZE);
      this.render();
    } catch {
      this.page = undefined;
      clear(this.listNode);
      this.rows.clear();
      setText(this.statusNode, t('history.unreadable'));
    } finally {
      this.loading = false;
    }
  }

  private render(): void {
    const page = this.page;
    clear(this.listNode);
    this.rows.clear();
    if (page === undefined) return;

    if (page.sessions.length === 0) {
      setText(this.statusNode, t('history.empty'));
      return;
    }

    const shown = page.sessions.length;
    setText(
      this.statusNode,
      t('history.counts', {
        shown: formatCount(shown),
        total: formatCount(page.total),
        projects: formatCount(page.projects.length),
        ms: formatCount(page.listMs),
      }),
    );

    for (const group of groupByProject(page.sessions)) {
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

  /** Open one session. The first read of any transcript in this whole flow. */
  private async select(sessionId: string): Promise<void> {
    const row = this.rows.get(sessionId);
    if (row !== undefined) setClass(row, 'is-loading', true);
    try {
      const history = await this.transport.open(sessionId);
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
      setText(this.statusNode, t('history.openFailed'));
    } finally {
      if (row !== undefined) setClass(row, 'is-loading', false);
    }
  }
}
