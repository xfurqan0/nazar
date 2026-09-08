/**
 * WP4g, rewritten by N-WP11: the Folder tabs section of the sidebar, and the
 * session list that makes one.
 *
 * A folder tab is a folder that owns a tab, and there are two halves here:
 *
 * - {@link ProjectsPanel} shows every folder tab there is — what each one is
 *   called, how many sessions it is drawing now, how many past ones it accounts
 *   for, and the two things you can do to it (rename, remove). N-WP12 moved the
 *   one switch that changes the *rule* out of the list and into the settings
 *   panel — it is still built here, because this is the only file that knows
 *   what it says, but it is appended to whichever element `autoRoot` names.
 * - {@link SessionList} shows the sessions on the canvas, each with the folder
 *   it is running in, and **is the only way a folder tab is made**. One button
 *   per row: *Open a tab for `app`*, or *Go to tab app* when that folder
 *   already has one.
 *
 * N-WP11 took the typed form away, and the maintainer's sentence is the whole
 * reason: there should be no *creating a project* — for a session visible in
 * the left panel there should be an *open a tab*, and the tab should be named
 * after the folder. A path typed into a field can be written a way no card ever
 * writes it and then own nothing for ever; a path taken off a row on screen
 * owns that row by construction. So the field is gone, the name is not asked
 * for (it is the folder's own, disambiguated only when two folders end in the
 * same word), and the only remaining question — *which* folder, this one or one
 * of its parents — is where it always was, in the menu that offers the tree.
 *
 * The other decision worth naming, because it is about not lying: **the past
 * count is `—` until history has been read.** The listing is a walk of the
 * transcript store and it is not done unless somebody asks for it; printing `0`
 * for "not counted" would be a measurement nobody made
 * (docs/pinned-internal-formats.md, rule 3). One button asks for it.
 */
import { t, tCount } from '../src/i18n.ts';
import { clear, html, setClass, setText } from './dom.ts';
import { createSwitch, paintSwitch } from './settings.ts';

/** One folder tab, as the sidebar needs it. */
export interface ProjectView {
  readonly id: string;
  readonly name: string;
  readonly root: string;
  /** Sessions on the canvas right now. */
  readonly live: number;
  /** Past sessions the transcript store has, or `undefined` if not read yet. */
  readonly past: number | undefined;
}

export interface ProjectsPanelOptions {
  readonly root: HTMLElement;
  /**
   * Where the auto-create switch goes (N-WP12). A separate element because the
   * list belongs in the drawer and the rule belongs in the settings, and the
   * two are no longer next to each other.
   */
  readonly autoRoot: HTMLElement;
  readonly onRename: (tabId: string, name: string) => void;
  readonly onRemove: (tabId: string) => void;
  /** Show a folder tab. Clicking the name in the list is how you get there. */
  readonly onSelect: (tabId: string) => void;
  readonly onAuto: (on: boolean) => void;
  /** Read the transcript store so the past column can stop saying `—`. */
  readonly onCountPast: () => void;
}

export class ProjectsPanel {
  private readonly options: ProjectsPanelOptions;

  private readonly listNode: HTMLUListElement;

  private readonly emptyNode: HTMLParagraphElement;

  private readonly countButton: HTMLButtonElement;

  private readonly autoButton: HTMLButtonElement;

  private editing: string | undefined;

  private last: { projects: readonly ProjectView[]; auto: boolean } | undefined;

  constructor(options: ProjectsPanelOptions) {
    this.options = options;

    this.emptyNode = html('p', 'nz-about__line');
    setText(this.emptyNode, t('sidebar.noFolderTabs'));

    this.listNode = html('ul', 'nz-projects__list');

    this.countButton = html('button', 'nz-item nz-projects__count');
    this.countButton.type = 'button';
    setText(this.countButton, t('sidebar.countPast'));
    this.countButton.title = t('sidebar.countPastNote');
    this.countButton.addEventListener('click', () => this.options.onCountPast());

    this.autoButton = createSwitch(t('settings.autoTabs'));
    this.autoButton.addEventListener('click', () => {
      this.options.onAuto(this.autoButton.getAttribute('aria-checked') !== 'true');
    });

    options.root.append(this.emptyNode, this.listNode, this.countButton);
    options.autoRoot.append(this.autoButton);
  }

  /** Draw again with the last data, after the editing state changed. */
  private draw(): void {
    if (this.last !== undefined) this.render(this.last.projects, this.last.auto);
  }

  render(projects: readonly ProjectView[], auto: boolean): void {
    this.last = { projects, auto };

    this.emptyNode.hidden = projects.length > 0;
    clear(this.listNode);

    for (const project of projects) {
      const item = html('li', 'nz-projects__item');

      if (this.editing === project.id) {
        const field = html('input', 'nz-projects__field');
        field.type = 'text';
        field.value = project.name;
        field.maxLength = 40;
        field.setAttribute('aria-label', t('sidebar.folderTabName'));
        let settled = false;
        const done = (name?: string): void => {
          if (settled) return;
          settled = true;
          this.editing = undefined;
          if (name !== undefined && name.trim().length > 0) this.options.onRename(project.id, name);
          else this.draw();
        };
        field.addEventListener('keydown', (event) => {
          event.stopPropagation();
          if (event.key === 'Enter') done(field.value);
          else if (event.key === 'Escape') done();
        });
        field.addEventListener('blur', () => done(field.value));
        window.requestAnimationFrame(() => field.focus());
        item.append(field);
        this.listNode.append(item);
        continue;
      }

      const open = html('button', 'nz-projects__name');
      open.type = 'button';
      setText(open, project.name);
      // The folder is the tooltip and not the label: it is the same redacted
      // path the cards show, and a sidebar row is not wide enough for a path.
      open.title = t('sidebar.showTab', { folder: project.root });
      open.addEventListener('click', () => this.options.onSelect(project.id));
      open.addEventListener('dblclick', () => {
        this.editing = project.id;
        this.draw();
      });

      const counts = html('span', 'nz-projects__counts');
      setText(
        counts,
        t('sidebar.tabCounts', {
          live: project.live,
          past: project.past === undefined ? '—' : project.past,
        }),
      );
      counts.title =
        project.past === undefined
          ? t('sidebar.pastUncounted')
          : tCount('sidebar.pastCounted', project.past);

      const remove = html('button', 'nz-projects__remove');
      remove.type = 'button';
      setText(remove, '×');
      remove.title = t('sidebar.closeTab', { name: project.name });
      remove.setAttribute('aria-label', t('tab.closeLabel', { name: project.name }));
      remove.addEventListener('click', () => this.options.onRemove(project.id));

      item.append(open, counts, remove);
      this.listNode.append(item);
    }

    this.countButton.hidden = projects.length === 0 || projects.every((one) => one.past !== undefined);

    paintSwitch(this.autoButton, auto);
    this.autoButton.title = t('settings.autoTabsNote');
  }
}

/* ------------------------------------------------------------------ *
 * N-WP11: the sessions, and the folder each one is running in
 * ------------------------------------------------------------------ */

/** One session on the canvas, as the sidebar's list needs it. */
export interface SessionRow {
  readonly id: string;
  /** The name the user gave the card, or the folder it is running in. */
  readonly label: string;
  /** The session's working directory, redacted exactly as the card draws it. */
  readonly folder: string;
  /** The folder's last component: what its tab would be called. */
  readonly folderName: string;
  /** The tab that already owns *this folder*, if one does. */
  readonly tab: { readonly id: string; readonly name: string } | undefined;
}

export interface SessionListOptions {
  readonly root: HTMLElement;
  /** Open a tab for this session's folder, and show it. */
  readonly onOpenFolder: (sessionId: string, root: string) => void;
  /** The folder already has a tab: show that one rather than making a second. */
  readonly onGoToTab: (tabId: string) => void;
  /**
   * The row was right-clicked. The page opens the card's own menu there, which
   * is where the whole folder tree is offered — this row's button can only
   * answer for the folder the session is actually in.
   */
  readonly onMenu: (
    sessionId: string,
    at: { readonly left: number; readonly top: number; readonly bottom: number },
  ) => void;
}

/**
 * The sessions on the canvas, one row each, with the folder under the name.
 *
 * This list exists to be right-clicked and to carry one button. It is not a
 * second canvas: it does not say what a session is doing, how many subagents it
 * has or whether it is waiting — the cards say all of that, and repeating it in
 * a drawer would be two places to keep in agreement for no gain.
 */
export class SessionList {
  private readonly options: SessionListOptions;

  private readonly listNode: HTMLUListElement;

  private readonly emptyNode: HTMLParagraphElement;

  constructor(options: SessionListOptions) {
    this.options = options;

    this.emptyNode = html('p', 'nz-about__line');
    setText(this.emptyNode, t('sidebar.noSessions'));

    this.listNode = html('ul', 'nz-sessions__list');
    options.root.append(this.emptyNode, this.listNode);
  }

  render(sessions: readonly SessionRow[]): void {
    this.emptyNode.hidden = sessions.length > 0;
    clear(this.listNode);

    for (const session of sessions) {
      const item = html('li', 'nz-sessions__item');

      const text = html('span', 'nz-sessions__text');
      const name = html('span', 'nz-sessions__name');
      setText(name, session.label);
      const folder = html('span', 'nz-sessions__folder');
      setText(folder, session.folder.length === 0 ? t('sidebar.folderUnknown') : session.folder);
      text.append(name, folder);
      text.title =
        session.folder.length === 0
          ? t('sidebar.noFolderNote', { label: session.label })
          : `${session.label} — ${session.folder}`;

      item.append(text);

      /*
       * The action, in two states and never a third: this folder has a tab, or
       * it does not. A disabled button would be a row that answers nothing, and
       * a second tab for one folder is the thing the model refuses outright.
       *
       * A real `<button>` in the drawer's own tab order, so Enter on it does
       * what a click does — the keyboard half of the gesture. A session whose
       * working directory the wire never carried gets no button at all rather
       * than one that would have nothing to open.
       */
      if (session.folder.length > 0) {
        const action = html('button', 'nz-sessions__open');
        action.type = 'button';
        const tab = session.tab;
        if (tab === undefined) {
          setText(action, '+');
          const label = t('sidebar.openTabFor', { name: session.folderName });
          action.title = `${label} — ${t('menu.openTabNote', { folder: session.folder })}`;
          action.setAttribute('aria-label', label);
          action.addEventListener('click', () => {
            this.options.onOpenFolder(session.id, session.folder);
          });
        } else {
          setText(action, '→');
          const label = t('menu.goToTab', { name: tab.name });
          action.title = `${label} — ${t('menu.hasTabNote', { folder: session.folder })}`;
          action.setAttribute('aria-label', label);
          setClass(action, 'is-current', true);
          action.addEventListener('click', () => this.options.onGoToTab(tab.id));
        }
        item.append(action);
      }

      item.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        this.options.onMenu(session.id, {
          left: event.clientX,
          top: event.clientY,
          bottom: event.clientY,
        });
      });

      this.listNode.append(item);
    }
  }
}
