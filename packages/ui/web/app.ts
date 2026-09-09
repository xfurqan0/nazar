/**
 * Canvas bootstrap: the data channel, the gestures, the hover card, the
 * banner, the tabs, the sidebar, and the states that are not "everything is
 * fine".
 *
 * The data channel is `EventSource` on `/api/events`. It reconnects on its own
 * and every frame is a whole snapshot, so there is no resume logic and no
 * "catching up": a reconnect is just the next render. While it is down the
 * canvas stays on screen with a visible *disconnected* pill rather than going
 * blank, because a monitor that empties itself when its own socket drops has
 * told you something false about your machine.
 *
 * WP4c added the half of a canvas that was missing: cards go where you put
 * them, tabs are separate views of the same machine, and the arrangement lives
 * in `localStorage` — never on disk, because Nazar writes nothing to disk and a
 * static gate fails the build if it ever tries.
 *
 * `?demo=1` swaps the channel for synthetic fixtures and freezes the clock at
 * the snapshot's own timestamp, so a screenshot is identical from one run to
 * the next. `?bench=1` drives a scripted pan and zoom and reports frame times.
 */
import type { Agent, History, SessionView, StateSnapshot } from '@nazar/core';

import type { ColourOverrides } from '../src/colours.ts';
import { readColours, writeColours } from '../src/colours.ts';
import { contextActionOf } from '../src/contextmenu.ts';
import { DEMO_HISTORY_IDS, makeDemoHistory } from '../src/demo-history.ts';
import { DEMO_NOTES, DEMO_PROJECT_ROOTS, DEMO_CARD_NAMES, makeDemoState } from '../src/demo.ts';
import { emptyStateLines } from '../src/empty.ts';
import {
  basename,
  cacheReadNote,
  formatAge,
  formatContextWindow,
  formatCostUsd,
  formatCount,
  formatDuration,
  formatElapsed,
  orUnknown,
  pidLabel,
} from '../src/format.ts';
import { finishedAgentIds, hideAgents } from '../src/hidden.ts';
import { formatStamp, historySnapshot, shortSessionId } from '../src/history-view.ts';
import type { Box, ResizeBounds, ResizeBox, ResizeHandle, Viewport } from '../src/layout.ts';
import {
  changesHeight,
  changesWidth,
  fitToBox,
  initialViewport,
  isCornerHandle,
  isResizeHandle,
  MAX_SCALE,
  MIN_SCALE,
  minCardHeight,
  patternOffset,
  patternTransform,
  resizeCard,
  screenToCanvas,
  zoomAt,
} from '../src/layout.ts';
import type { NamesState } from '../src/names.ts';
import { nameOf, pruneNames, readNames, withName, writeNames } from '../src/names.ts';
import type { NotesState } from '../src/notes.ts';
import {
  addNote,
  NOTE_SIZE,
  readNotes,
  reassignNotes,
  removeNote,
  updateNote,
  writeNotes,
} from '../src/notes.ts';
import type { Placement, SizedBox } from '../src/pack.ts';
import { firstFreeSlot, packShelves, shelfWidth } from '../src/pack.ts';
import {
  ancestorPaths,
  cleanPath,
  folderName,
  historyProjectMatches,
} from '../src/projects.ts';
import { quotaSourceLabel } from '../src/quota-strip.ts';
import type { Locale } from '../src/i18n.ts';
import {
  installCatalogs,
  isLocale,
  readLocaleChoice,
  resolveLocale,
  setLocale,
  t,
  tCount,
  writeLocaleChoice,
} from '../src/i18n.ts';
import { shortcutFor } from '../src/shortcuts.ts';
import type { SoundSettings } from '../src/sound.ts';
import {
  newlyWaiting,
  readSound,
  SoundRules,
  waitingIds,
  writeSound,
} from '../src/sound.ts';
import { readTaskText, withTaskQuery, writeTaskText } from '../src/task-text.ts';
import { readUsageOpen, writeUsageOpen } from '../src/usage-popover.ts';
import type { LayoutState, TabsState } from '../src/workspace.ts';
import {
  ALL_TAB,
  clearedFor,
  createProjectTab,
  createTab,
  folderTabAt,
  followProject,
  guarded,
  isPinned,
  moveSession,
  openFolderTab,
  projectTabs,
  pruneLayout,
  pruneTabs,
  readLayout,
  readTabs,
  removeTab,
  renameTab,
  sessionsOnTab,
  setActiveTab,
  setAutoProjects,
  tabCounts,
  tabOf,
  isSized,
  withAutoSize,
  withCleared,
  withCollapsed,
  withHeight,
  withPosition,
  withRestored,
  withWidth,
  writeLayout,
  writeTabs,
} from '../src/workspace.ts';
import type { CardMetric } from './canvas.ts';
import {
  ageOf,
  CanvasRenderer,
  CARD,
  cardMinimumFor,
  isWaiting,
  MAX_CARD_HEIGHT,
  MAX_CARD_WIDTH,
  measureCards,
  type FocusTarget,
} from './canvas.ts';
import { ColourSettings } from './colours.ts';
import { html, setAttr, setClass, setText } from './dom.ts';
import { HistoryPanel, httpTransport, type HistoryTransport } from './history.ts';
import { NeedsYouStrip } from './needs-you.ts';
import { NotesLayer } from './notes.ts';
import { ProjectsPanel, SessionList, type ProjectView, type SessionRow } from './projects.ts';
import { applyStatic, fillLanguagePicker } from './lang.ts';
import { catalogs } from './locales.ts';
import { UsagePanel } from './quota.ts';
import { fillSegment, paintSwitch, SettingsPanel } from './settings.ts';
import { jumpHint, jumpNeedsShell, Shell } from './shell.ts';
import { Sidebar } from './sidebar.ts';
import { armSoundUnlock, createSoundPlayer } from './sound.ts';
import { CanvasMenu, CardMenu, LinkMenu, TabBar } from './tabbar.ts';

declare const __NAZAR_VERSION__: string;

const THEME_KEY = 'nazar.theme';
/** Which palette is on. Light/dark is `nazar.theme`; this is *which* set of colours. */
const PALETTE_KEY = 'nazar.palette';
const CANVAS_MARGIN = 28;
/**
 * Side of one background-pattern tile, in canvas units.
 *
 * It has to match the `<pattern width/height>` in `index.html` exactly: this is
 * the period the pan offset is reduced modulo, and a mismatch would make the
 * dots crawl by the difference on every wrap.
 */
const GRID_TILE = 26;
/** How long the foot-of-canvas hint stays up. Long enough to read once. */
const HINT_MS = 4200;
const EMPTY_BOX: Box = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

/**
 * The notes `?demo=1&notes=1` puts on the canvas.
 *
 * Three, because three is enough to show that they are separate objects, that
 * they carry colours, and that one of them wraps. The words are the kind of
 * thing a note on this canvas is actually for — a reminder attached to a place
 * on a map — rather than lorem ipsum, which would prove nothing about the width
 * a real sentence needs.
 */

function element<T extends Element>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`missing element #${id}`);
  return found as unknown as T;
}

function intParam(params: URLSearchParams, name: string, fallback: number): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  // Zero is meaningful: `?demo=1&sessions=0` is how the empty state is shown.
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Resolve the node under an event to the thing the hover card should show. */
function targetFrom(node: EventTarget | null): { target: FocusTarget; element: Element } | undefined {
  if (!(node instanceof Element)) return undefined;
  const agent = node.closest<SVGGElement>('.nz-agent');
  if (agent !== null) {
    const sessionId = agent.dataset['sessionId'];
    const agentId = agent.dataset['agentId'];
    if (sessionId === undefined || agentId === undefined) return undefined;
    return { target: { kind: 'agent', sessionId, agentId }, element: agent };
  }
  const session = node.closest<SVGGElement>('.nz-session');
  if (session !== null) {
    const sessionId = session.dataset['sessionId'];
    if (sessionId === undefined) return undefined;
    return { target: { kind: 'session', sessionId }, element: session };
  }
  return undefined;
}

/** The session id of the card an event happened inside, if any. */
function sessionIdOf(node: EventTarget | null): string | undefined {
  if (!(node instanceof Element)) return undefined;
  return node.closest<SVGGElement>('.nz-session')?.dataset['sessionId'];
}

/* ------------------------------------------------------------------ *
 * Theme
 * ------------------------------------------------------------------ */

type ThemeChoice = 'light' | 'dark' | 'system';

function readTheme(params: URLSearchParams): ThemeChoice {
  const forced = params.get('theme');
  if (forced === 'light' || forced === 'dark') return forced;
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // Storage can be blocked. The system preference is a fine default.
  }
  return 'system';
}

/** The three choices, in the order the segment lists them. */
const THEME_CHOICE_KEYS: readonly { readonly value: ThemeChoice; readonly key: string }[] = [
  { value: 'system', key: 'settings.mode.system' },
  { value: 'light', key: 'settings.mode.light' },
  { value: 'dark', key: 'settings.mode.dark' },
];

/** The three, with their words in the language now in force. */
function themeChoices(): readonly { readonly value: ThemeChoice; readonly label: string }[] {
  return THEME_CHOICE_KEYS.map((one) => ({ value: one.value, label: t(one.key) }));
}

/**
 * Put a choice on the document.
 *
 * N-WP12 split this in two: the attribute is written here, and *which* button
 * looks chosen is written by the painter `fillSegment` hands back. The old
 * single button carried both jobs and its label had to be read (`light or
 * dark: system`) before it could be used.
 */
function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

/* ------------------------------------------------------------------ *
 * Palette (WP4e)
 * ------------------------------------------------------------------ */

/**
 * The themes the build compiled into the stylesheet, injected at build time
 * rather than listed here.
 *
 * `build.mjs` validates every `theme.*.json` and writes its tokens into
 * `styles.css`; if this file kept its own list, adding a theme would mean
 * editing two places and a picker offering a palette with no rules behind it
 * would look exactly like one that works. So the list comes from the same array
 * the CSS was generated from, and `chrome.test.ts` checks the injection is
 * still there.
 */
declare const __NAZAR_THEMES__: readonly {
  readonly name: string;
  readonly label: string;
  readonly description?: string;
}[];

/** The first theme is the default and is written unscoped in the stylesheet. */
const DEFAULT_PALETTE = __NAZAR_THEMES__[0]?.name ?? 'nazar';

function readPalette(params: URLSearchParams): string {
  const known = (name: string | null): string | undefined =>
    __NAZAR_THEMES__.find((theme) => theme.name === name)?.name;
  const forced = known(params.get('palette'));
  if (forced !== undefined) return forced;
  try {
    const stored = known(window.localStorage.getItem(PALETTE_KEY));
    if (stored !== undefined) return stored;
  } catch {
    // Storage can be blocked; the default palette is a fine answer.
  }
  return DEFAULT_PALETTE;
}

/**
 * Apply a palette.
 *
 * The default one is the *absence* of the attribute, because its tokens are
 * written unscoped on `:root`: setting `data-palette="nazar"` would work by
 * accident (no rule matches it, so the unscoped block still wins) and would
 * stop working the day someone scopes it. Removing the attribute says what is
 * actually true.
 */
function applyPalette(name: string): void {
  const root = document.documentElement;
  if (name === DEFAULT_PALETTE) root.removeAttribute('data-palette');
  else root.setAttribute('data-palette', name);
}

/* ------------------------------------------------------------------ *
 * Hover card
 * ------------------------------------------------------------------ */

/** The message key for each row id. */
const HOVER_ROW_KEYS: Readonly<Record<string, string>> = {
  model: 'hover.model',
  effort: 'hover.effort',
  elapsed: 'hover.elapsed',
  'current tool': 'hover.currentTool',
  'tool calls': 'hover.toolCalls',
  'tokens in': 'hover.tokensIn',
  'tokens out': 'hover.tokensOut',
  'cache read': 'hover.cacheRead',
  'cache write': 'hover.cacheWrite',
  'last write': 'hover.lastWrite',
  cost: 'hover.cost',
  context: 'hover.context',
};

/**
 * The rows, by the id the code sets them by.
 *
 * N-WP13 kept the ids in English and moved the *words* into the catalogue
 * ({@link HOVER_ROW_KEYS}). `this.set('cache read', …)` is a call site, not a
 * label, and translating an internal key would have made the six catalogues
 * part of the control flow.
 */
const CARD_ROWS = [
  'model',
  'effort',
  'elapsed',
  'current tool',
  'tool calls',
  'tokens in',
  'tokens out',
  'cache read',
  'cache write',
  'last write',
  // WP3'. The two rows with an optional source: they exist only when a
  // status-line capture named this session, and are removed from the card
  // rather than filled with `unknown` when it did not. Every row above is
  // always drawn, so the card still never reflows on hover *within* a machine —
  // it is the machine that decides whether these two are there at all.
  'cost',
  'context',
] as const;

/** The rows that a machine without the wrapper simply does not have. */
const OPTIONAL_ROWS = new Set<(typeof CARD_ROWS)[number]>(['cost', 'context']);

class HoverCard {
  private readonly root: HTMLDivElement;

  private readonly title: HTMLDivElement;

  private readonly subtitle: HTMLDivElement;

  private readonly values = new Map<string, HTMLSpanElement>();

  private readonly rows = new Map<string, HTMLDivElement>();

  private readonly labels = new Map<string, HTMLSpanElement>();

  private readonly note: HTMLDivElement;

  /**
   * N-WP15a: the task, in full.
   *
   * A row would be wrong — every row here is a label and a short value on one
   * line, and this is up to 300 characters of somebody's prose — so it is its
   * own block under the subtitle, above the measurements. Hidden when there is
   * nothing to show, which is the same rule the two capture rows follow and
   * which keeps the card from reflowing into an empty gap.
   */
  private readonly task: HTMLDivElement;

  constructor(root: HTMLDivElement) {
    this.root = root;
    this.title = html('div', 'nz-card__title');
    this.subtitle = html('div', 'nz-card__subtitle');
    this.task = html('div', 'nz-card__task');
    this.task.hidden = true;
    const body = html('div', 'nz-card__body');
    // "cache read" is the one row nobody believes: it is the whole prompt
    // prefix re-read once per request, so it sits three orders of magnitude
    // above "tokens out" and reads like a double-count. The card itself is
    // `pointer-events: none` — it follows the cursor — so a native tooltip on
    // that row could never be hovered. The note is printed instead, and the
    // `title` attribute is set anyway for anything reading the DOM.
    const note = html('div', 'nz-card__note');
    this.note = note;
    root.append(this.title, this.subtitle, this.task, body, note);

    // Every row is created once and only written to. The two optional ones are
    // hidden rather than filled with `unknown`: a row that says "unknown"
    // forever on a machine that has no source for it is a promise the product
    // cannot keep, and a placeholder row is worse than no row.
    for (const label of CARD_ROWS) {
      const row = html('div', 'nz-card__row');
      if (OPTIONAL_ROWS.has(label)) row.hidden = true;
      const name = html('span', 'nz-card__label');
      const value = html('span', 'nz-card__value');
      row.append(name, value);
      body.append(row);
      this.values.set(label, value);
      this.rows.set(label, row);
      this.labels.set(label, name);
    }
    this.retranslate();
  }

  /**
   * Rewrite the twelve row names and the cache-read note.
   *
   * The values are rewritten by the next hover, which is a frame away; these
   * are written once when the card is built and would otherwise stay in the
   * language the page loaded in.
   */
  retranslate(): void {
    setText(this.note, t('hover.cacheReadLine', { note: cacheReadNote() }));
    for (const [label, name] of this.labels) {
      setText(name, t(HOVER_ROW_KEYS[label] ?? label));
      const row = this.rows.get(label);
      if (row !== undefined && label === 'cache read') row.title = cacheReadNote();
    }
  }

  /**
   * Show the task, or take the block off the card.
   *
   * The text is written with `setText`, so it is a text node and nothing else:
   * whatever a transcript happens to contain — angle brackets, an entity, a
   * script tag — arrives as the characters somebody typed. That is the reason
   * `task-text.ts` deliberately does *not* escape anything on the way out: the
   * two places this string is drawn are an SVG text node and this one, and
   * neither interprets markup.
   */
  private setTask(text: string | undefined): void {
    this.task.hidden = text === undefined;
    setText(this.task, text ?? '');
  }

  private set(label: (typeof CARD_ROWS)[number], value: string): void {
    const node = this.values.get(label);
    if (node !== undefined) setText(node, value);
  }

  /** Write an optional row, or take it off the card when there is no value. */
  private setOptional(label: (typeof CARD_ROWS)[number], value: string | undefined): void {
    const row = this.rows.get(label);
    if (row !== undefined) row.hidden = value === undefined;
    if (value !== undefined) this.set(label, value);
  }

  showSession(
    session: SessionView,
    anchor: DOMRect,
    now: number,
    frozen: boolean,
    name?: string,
  ): void {
    // WP4g: the card's own name when it has one, and the folder when it does
    // not — the same rule the card title follows, so hovering a card never
    // renames it under the cursor.
    setText(this.title, name !== undefined && name.length > 0 ? name : basename(session.cwd));
    setText(
      this.subtitle,
      frozen
        ? t('hover.subtitleFrozen', {
            folder: orUnknown(session.cwd),
            session: shortSessionId(session.id),
          })
        : t('hover.subtitleLive', {
            folder: orUnknown(session.cwd),
            pid: pidLabel(session.pid),
            status: session.status,
            state: session.state,
          }),
    );
    // N-WP15a. `session.task` is present only when this browser asked for it
    // and the server agreed, so there is nothing more to decide here.
    this.setTask(session.task);
    this.set('model', orUnknown(session.model));
    this.set('effort', orUnknown(session.effort));
    // Frozen: how long the run took, and when it ended. A relative age on a
    // finished session measures the clock, not the run.
    this.set(
      'elapsed',
      frozen
        ? formatDuration(
            session.startedAt === undefined || session.transcriptAt === undefined
              ? undefined
              : session.transcriptAt - session.startedAt,
          )
        : formatElapsed(session.startedAt, now),
    );
    this.set('current tool', frozen ? '—' : orUnknown(session.currentTool));
    this.set('tool calls', formatCount(session.toolCalls));
    this.set('tokens in', formatCount(session.tokens?.in));
    this.set('tokens out', formatCount(session.tokens?.out));
    this.set('cache read', formatCount(session.tokens?.cacheRead));
    this.set('cache write', formatCount(session.tokens?.cacheWrite));
    this.set(
      'last write',
      frozen ? formatStamp(session.transcriptAt) : formatAge(ageOf(session.transcriptAt, now)),
    );
    // WP3'. A frozen session predates its capture — captures are deleted seven
    // days after a session stops writing, and a past run's cost is not in the
    // transcript — so the two rows belong to the live canvas only.
    this.setOptional('cost', frozen ? undefined : formatCostUsd(session.costUsd));
    this.setOptional(
      'context',
      frozen ? undefined : formatContextWindow(session.contextWindow),
    );
    this.place(anchor);
  }

  showAgent(agent: Agent, anchor: DOMRect, now: number, frozen: boolean): void {
    setText(this.title, orUnknown(agent.agentType));
    setText(
      this.subtitle,
      t('hover.agentSubtitle', { depth: agent.spawnDepth, state: agent.state }) +
        (agent.doneSignal === undefined ? '' : ` (${agent.doneSignal})`) +
        (agent.orphan === true ? ` · ${t('agent.orphan')}` : '') +
        (agent.workflowRunId === undefined
          ? ''
          : ` · ${t('hover.workflow', { id: agent.workflowRunId })}`),
    );
    /*
     * N-WP15a. The **brief**, not the label — the opposite choice to the node,
     * and for the opposite reason: the node has 156 px and shows the three-word
     * `description`, and this card has room for the 300 characters that say what
     * the job actually was. The label is already on the node the pointer is
     * sitting on, so repeating it here would spend the space saying nothing new.
     */
    this.setTask(agent.task ?? agent.description);
    this.set('model', orUnknown(agent.modelId ?? agent.model));
    this.set('effort', orUnknown(agent.effort));
    this.set(
      'elapsed',
      agent.state === 'done' || frozen
        ? formatDuration(agent.durationMs)
        : formatElapsed(agent.startedAt, now),
    );
    this.set('current tool', frozen ? '—' : orUnknown(agent.currentTool));
    this.set('tool calls', formatCount(agent.toolCalls));
    this.set('tokens in', formatCount(agent.tokens?.in));
    this.set('tokens out', formatCount(agent.tokens?.out));
    this.set('cache read', formatCount(agent.tokens?.cacheRead));
    this.set('cache write', formatCount(agent.tokens?.cacheWrite));
    this.set(
      'last write',
      frozen
        ? formatStamp(agent.endedAt ?? agent.lastWriteAt)
        : formatAge(ageOf(agent.lastWriteAt, now)),
    );
    // A subagent has no capture of its own: the status line reports the
    // session, and splitting one session's cost across its tree would be an
    // invented number. Both rows come off the card.
    this.setOptional('cost', undefined);
    this.setOptional('context', undefined);
    this.place(anchor);
  }

  private place(anchor: DOMRect): void {
    this.root.hidden = false;
    const width = this.root.offsetWidth || 268;
    const height = this.root.offsetHeight || 240;
    let left = anchor.right + 12;
    if (left + width > window.innerWidth - 8) left = Math.max(8, anchor.left - width - 12);
    let top = anchor.top;
    if (top + height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - height - 8);
    this.root.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  hide(): void {
    this.root.hidden = true;
  }
}

/* ------------------------------------------------------------------ *
 * Application
 * ------------------------------------------------------------------ */

function start(): void {
  const params = new URLSearchParams(window.location.search);
  const demo = params.get('demo') === '1';
  const bench = params.get('bench') === '1';

  /*
   * N-WP13. The catalogues go in before a single element is looked up, because
   * `HoverCard`, `HistoryPanel` and the colour rows all write their labels in
   * their constructors — with nothing installed they would be built out of
   * message keys and only fixed by the first language change.
   *
   * `?lang=` is a screenshot switch, in the shape of `?theme=` and `?palette=`:
   * six screenshots of the settings panel are six URLs rather than six sequences
   * of clicks. It does not become the stored choice.
   *
   * N-WP13b: there is one language here rather than a choice that might be
   * *system*. Nothing stored still means the machine decides — that is what
   * `resolveLocale` does with an `undefined` choice — but the answer is a real
   * language from this line on, so the picker has something to tick and the
   * page has nothing to explain.
   */
  installCatalogs(catalogs);
  let localeStorage;
  try {
    localeStorage = window.localStorage;
  } catch {
    localeStorage = undefined;
  }
  const machineLanguages: readonly string[] =
    window.navigator.languages ?? [window.navigator.language];
  const forcedLocale = params.get('lang');
  let localeChoice: Locale = resolveLocale(
    forcedLocale !== null && isLocale(forcedLocale)
      ? forcedLocale
      : readLocaleChoice(localeStorage),
    machineLanguages,
  );
  setLocale(localeChoice);
  applyStatic();

  const host = element<HTMLDivElement>('canvas-host');
  const viewportGroup = element<SVGGElement>('viewport');
  // WP4f: the background dots. Not drawn by the viewport group — one `<rect>`
  // fills the window and this `<pattern>` tiles it — so the transform reaches
  // them through `patternTransform` rather than through the group.
  const gridPattern = element<SVGPatternElement>('nz-grid');
  const banner = element<HTMLDivElement>('banner');
  const bannerText = element<HTMLSpanElement>('banner-text');
  const empty = element<HTMLDivElement>('empty');
  const emptyTitle = element<HTMLParagraphElement>('empty-title');
  const emptyHint = element<HTMLParagraphElement>('empty-hint');
  const emptyTabHint = element<HTMLParagraphElement>('empty-tab-hint');
  // N-WP20: why the canvas is empty, what to do about it, and what is merely
  // worth knowing while it is.
  const emptyWhy = element<HTMLParagraphElement>('empty-why');
  const emptyNext = element<HTMLParagraphElement>('empty-next');
  const emptyNote = element<HTMLParagraphElement>('empty-note');
  const conn = element<HTMLDivElement>('conn');
  const counts = element<HTMLDivElement>('counts');
  const cardRoot = element<HTMLDivElement>('card');
  const historyRoot = element<HTMLElement>('history');
  const historyButton = element<HTMLButtonElement>('history-toggle');
  const frozenBar = element<HTMLDivElement>('frozen-bar');
  const frozenText = element<HTMLSpanElement>('frozen-text');
  const frozenBack = element<HTMLButtonElement>('frozen-back');
  const menuToggle = element<HTMLButtonElement>('menu-toggle');
  const sidebarRoot = element<HTMLElement>('sidebar');
  const usageButton = element<HTMLButtonElement>('usage-bead');
  const usagePercent = element<HTMLSpanElement>('usage-bead-percent');
  const usageRoot = element<HTMLElement>('usage');
  const usageList = element<HTMLElement>('usage-list');
  const usageExplainer = element<HTMLParagraphElement>('usage-explainer');
  const usageClose = element<HTMLButtonElement>('usage-close');
  const usageSourceNode = element<HTMLSpanElement>('usage-source');
  const quotaSource = element<HTMLSpanElement>('quota-source');
  // N-WP21: the Needs-you badge, its live region, and the list behind it.
  const needsYouButton = element<HTMLButtonElement>('needs-you');
  const needsYouCount = element<HTMLSpanElement>('needs-you-count');
  const needsYouLongest = element<HTMLSpanElement>('needs-you-longest');
  const needsYouLive = element<HTMLParagraphElement>('needs-you-live');
  const needsYouRoot = element<HTMLElement>('needs-you-panel');
  const needsYouTitleNode = element<HTMLHeadingElement>('needs-you-title');
  const needsYouList = element<HTMLElement>('needs-you-list');
  const needsYouEmptyNode = element<HTMLParagraphElement>('needs-you-empty');
  const needsYouClose = element<HTMLButtonElement>('needs-you-close');
  const needsYouFinished = element<HTMLElement>('needs-you-finished');
  const needsYouFinishedToggle = element<HTMLButtonElement>('needs-you-finished-toggle');
  const needsYouFinishedList = element<HTMLElement>('needs-you-finished-list');
  const themeGroup = element<HTMLElement>('theme-toggle');
  const paletteRoot = element<HTMLElement>('palette');
  const coloursRoot = element<HTMLElement>('colours');
  const arrangeButton = element<HTMLButtonElement>('arrange');
  const fitButton = element<HTMLButtonElement>('fit');
  const addNoteButton = element<HTMLButtonElement>('add-note');
  const demoButton = element<HTMLButtonElement>('demo-toggle');
  const tabsRoot = element<HTMLElement>('tabs');
  const projectsRoot = element<HTMLElement>('projects');
  const sessionsRoot = element<HTMLElement>('sessions');
  const renameField = element<HTMLInputElement>('rename');
  const cardMenuRoot = element<HTMLDivElement>('cardmenu');
  const canvasMenuRoot = element<HTMLDivElement>('canvasmenu');
  const notesRoot = element<HTMLDivElement>('notes');
  const versionNode = element<HTMLSpanElement>('version');
  const aboutVersionNode = element<HTMLSpanElement>('about-version');
  const hintNode = element<HTMLDivElement>('hint');
  const shellGroup = element<HTMLElement>('shell-group');
  const shellAbout = element<HTMLParagraphElement>('shell-about');
  const autostartButton = element<HTMLButtonElement>('autostart-toggle');
  // N-WP15a: the two halves of one setting. The first is this browser's and is
  // always there; the second is the machine's and only the shell can answer it.
  const taskTextButton = element<HTMLButtonElement>('task-text-toggle');
  const recordingButton = element<HTMLButtonElement>('recording-toggle');
  const linkMenuRoot = element<HTMLDivElement>('linkmenu');
  // N-WP12: the drawer's two views, the gear that swaps them, and the slot the
  // folder-tab rule sits in now that it is a setting rather than a list row.
  const sidebarMain = element<HTMLElement>('sidebar-main');
  const settingsRoot = element<HTMLElement>('settings');
  const settingsToggle = element<HTMLButtonElement>('settings-toggle');
  const settingsBack = element<HTMLButtonElement>('settings-back');
  const autoTabsRoot = element<HTMLElement>('auto-tabs');
  const languageRoot = element<HTMLElement>('language');
  // N-WP16: three switches, two clock fields and a button that proves the
  // browser will actually make a noise.
  const soundEndButton = element<HTMLButtonElement>('sound-end-toggle');
  const soundWaitingButton = element<HTMLButtonElement>('sound-waiting-toggle');
  const soundQuietButton = element<HTMLButtonElement>('sound-quiet-toggle');
  const soundQuietRow = element<HTMLDivElement>('sound-quiet-row');
  const soundFrom = element<HTMLInputElement>('sound-from');
  const soundTo = element<HTMLInputElement>('sound-to');
  const soundTestButton = element<HTMLButtonElement>('sound-test');

  setText(versionNode, __NAZAR_VERSION__);
  setText(aboutVersionNode, __NAZAR_VERSION__);

  /* ---- the desktop shell, if this page is inside one --------------- */

  // One detection, at start-up, and everything the shell adds hangs off it. In a browser
  // `shell` is `undefined` and the code below simply does less; nothing is disabled,
  // greyed out, or drawn and then refused.
  const shell = Shell.detect();

  /**
   * N-WP21: whether this shell can jump at all.
   *
   * `ShellInfo.jumpSupported` has been on the wire since WP8 and nothing read
   * it. That was harmless while Windows was the only bundle and became a bug
   * the day N-WP19a shipped macOS and Linux ones: `apps/desktop/src/jump.rs` is
   * `cfg!(windows)`, its own doc comment says *the canvas asks `supported()`
   * before offering the entry*, and the canvas never asked — so a mac user got
   * a **Jump to terminal** menu item whose only possible answer was "not available
   * on this platform yet", plus a double-click gesture that did nothing visible.
   *
   * It starts `true` inside the shell and is corrected by the first
   * `shell_info`. That direction on purpose: a shell that fails to answer keeps
   * the behaviour every Windows machine has today, and the window in which a
   * mac could be wrong is one round trip at start-up.
   */
  let jumpSupported = shell !== undefined;

  /** One line at the foot of the canvas, gone again a few seconds later. */
  let hintTimer = 0;
  const showHint = (text: string): void => {
    setText(hintNode, text);
    hintNode.hidden = false;
    window.clearTimeout(hintTimer);
    hintTimer = window.setTimeout(() => {
      hintNode.hidden = true;
    }, HINT_MS);
  };

  /**
   * Bring the terminal running a session to the front.
   *
   * Frozen sessions are refused before anything else: a session opened out of history
   * ended some time ago, its pid belongs to whatever the machine has started since, and
   * raising a window for it would be raising the wrong window with confidence.
   */
  const jumpToTerminal = (sessionId: string): void => {
    if (isFrozen()) {
      showHint(t('hint.frozenNoTerminal'));
      return;
    }
    const session = drawn().sessions.find((one) => one.id === sessionId);
    if (session === undefined) return;
    // N-WP18: a Codex session names no process, so there is nothing to raise.
    // Refused before the shell is consulted, and refused with a sentence: the
    // jump is *absent* on such a card rather than offered and then failed.
    if (session.pid <= 0) {
      showHint(t('hint.noPidNoTerminal'));
      return;
    }
    if (shell === undefined) {
      showHint(`${jumpNeedsShell()} — ${t('hint.inABrowser')}`);
      return;
    }
    // N-WP21. A shell that cannot jump does nothing, silently: the menu entry
    // is not drawn either, and a double-click is the same gesture as a click as
    // far as this machine is concerned. A hint would fire on every double-click
    // of a card to repeat a fact about the platform that does not change.
    if (!jumpSupported) return;
    void shell.jump(session.pid).then((outcome) => showHint(jumpHint(outcome)));
  };

  /* ---- persisted workspace ---------------------------------------- */

  let browserStorage;
  try {
    browserStorage = window.localStorage;
  } catch {
    browserStorage = undefined;
  }
  // The demo canvas gets a storage of its own. Screenshots and the frame-rate
  // check must be the same every run, and they must not leave synthetic session
  // ids in the arrangement of a real machine.
  const storage = guarded(demo ? undefined : browserStorage);
  let layout: LayoutState = readLayout(storage);
  let tabs: TabsState = readTabs(storage);
  // WP4e. Notes are the user's own words rather than a reading of the machine,
  // so they follow the same rule as the arrangement: the browser keeps them, and
  // nothing about them ever reaches the disk or the wire.
  let notes: NotesState = readNotes(storage);
  // WP4g. A card's name is the same kind of thing as a note — the user's word
  // rather than a reading of the machine — and it follows the same rule: this
  // browser keeps it, nothing else ever sees it.
  let names: NamesState = readNames(storage);
  /*
   * N-WP15a: does this browser want the task line?
   *
   * One variable, read once at start-up and written when the switch moves. It
   * reaches four places and they all have to agree on the same frame: the
   * *measure* pass (a node showing a task is one line taller), the *draw* pass,
   * the SSE subscription (the server sends the field only for `?task=1`) and
   * the history fetch. A disagreement between the first two draws a tree
   * outside its card; between the last two, a card whose task line appears live
   * and vanishes in history.
   */
  let taskText = readTaskText(storage);

  /*
   * N-WP16: the sound, in three pieces.
   *
   * `sound` is the stored preferences, `soundPlayer` owns the audio context and
   * the one decoded clip, and `sounds` owns the rules — one tick per session,
   * two seconds of debounce, five seconds of silence after the page opens,
   * quiet hours, and nothing at all in the demo.
   *
   * The player is built now and unlocked later: every browser refuses to start
   * audio on a page nobody has touched, so `armSoundUnlock` waits for the first
   * `pointerdown` or `keydown` and builds the context there. Until then
   * `soundPlayer.play()` answers `false`, which is what the line below turns
   * into the one sentence this feature owes the user — said once, and then
   * never again in this browser.
   */
  let sound: SoundSettings = readSound(storage);
  const soundPlayer = createSoundPlayer();
  // The demo canvas is silent by rule, so it does not arm the gesture either:
  // a screenshot run must build no audio graph and fetch no clip. Its Test
  // button still works — that press unlocks the player itself.
  if (!demo) armSoundUnlock(soundPlayer);
  const playTick = (): void => {
    if (soundPlayer.play()) return;
    // Only one of the two ways `play()` can say no is worth a sentence: the page
    // has not been touched yet. A clip that could not be fetched is a broken
    // build, and telling somebody to click would be pointing at the wrong thing.
    if (soundPlayer.unlocked || sound.hinted) return;
    sound = { ...sound, hinted: true };
    writeSound(storage, sound);
    showHint(t('hint.soundNeedsAClick'));
  };
  const sounds = new SoundRules({
    play: playTick,
    settings: () => sound,
    now: () => Date.now(),
    demo,
  });

  /*
   * Re-open the SSE stream at a URL that matches the current setting.
   *
   * The subscription's shape is fixed by the request that opened it — the
   * server reads `?task=1` once, at subscribe — so changing the setting means
   * a new connection rather than a new frame on the old one. Declared here and
   * filled in at the bottom of this function, where the stream is created: the
   * settings panel is built long before that and would otherwise have to be
   * moved for the sake of one call.
   *
   * In demo mode there is no stream at all and this stays the no-op it starts
   * as, which is correct — the demo data is already in the page.
   */
  let restartStream = (): void => {};

  const saveLayout = (): void => writeLayout(storage, layout);
  const saveTabs = (): void => writeTabs(storage, tabs);
  const saveNotes = (): void => writeNotes(storage, notes);
  const saveNames = (): void => writeNames(storage, names);

  /* ---- theme, palette and chrome ---------------------------------- */

  // The five frame colours, overridden per browser. Built first and applied
  // before the first frame, so a stored override is never visibly replaced by
  // the theme's own colour for a moment on load.
  const colours = new ColourSettings(
    {
      root: coloursRoot,
      onChange: (next: ColourOverrides) => writeColours(storage, next),
    },
    readColours(storage),
  );
  colours.apply();

  let theme = readTheme(params);
  applyTheme(theme);
  const paintTheme = fillSegment(themeGroup, themeChoices(), (choice: ThemeChoice) => {
    theme = choice;
    applyTheme(theme);
    paintTheme(theme);
    // The card ground every contrast hint is measured against just changed, and
    // so did every colour a picker with no override is showing.
    colours.refresh();
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Nothing to do: the choice simply does not survive a reload.
    }
  });
  paintTheme(theme);

  // The palette picker: one button per theme the build compiled in. Buttons and
  // not a `<select>` because there are four of them, each has a sentence worth
  // showing as a tooltip, and the chosen one has to be visible without opening
  // anything.
  let palette = readPalette(params);
  applyPalette(palette);
  const paletteButtons = new Map<string, HTMLButtonElement>();
  const paintPalette = (): void => {
    for (const [name, button] of paletteButtons) {
      const on = name === palette;
      setClass(button, 'is-current', on);
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  };
  for (const one of __NAZAR_THEMES__) {
    const button = html('button', 'nz-palette');
    button.type = 'button';
    /*
     * `data-theme-name`, and **not** `data-palette`.
     *
     * The first version used `data-palette`, which is the attribute the token
     * stylesheet scopes a theme by — so every button became a palette root and
     * took that theme's tokens for itself. Invisible in the default theme and
     * obvious in Sepia, where the chosen button drew itself out of the *dark*
     * block: the generated guard is
     * `[data-palette="sepia"]:not([data-theme="light"])`, and a button carries
     * no `data-theme` of its own, so the `:not` matched even though the
     * document had asked for light. A scoping attribute is not a free label.
     */
    button.dataset['themeName'] = one.name;
    setText(button, one.label);
    if (one.description !== undefined) button.title = one.description;
    button.addEventListener('click', () => {
      palette = one.name;
      applyPalette(palette);
      paintPalette();
      colours.refresh();
      try {
        window.localStorage.setItem(PALETTE_KEY, palette);
      } catch {
        // The choice simply does not survive a reload.
      }
    });
    paletteRoot.append(button);
    paletteButtons.set(one.name, button);
  }
  paintPalette();
  colours.refresh();

  /*
   * N-WP12. Built before the drawer, though the order does not decide the
   * Escape race — the panel catches Escape on the way *down* (capture) rather
   * than relying on having registered first. See `web/settings.ts`.
   */
  const settings = new SettingsPanel({
    sidebar: sidebarRoot,
    main: sidebarMain,
    panel: settingsRoot,
    gear: settingsToggle,
    back: settingsBack,
  });

  const sidebar = new Sidebar({
    root: sidebarRoot,
    toggle: menuToggle,
    onChange: (open) => {
      layout = { ...layout, sidebar: open };
      saveLayout();
      // Open or closed is remembered for the drawer and deliberately not for the
      // panel, so shutting the drawer resets it to the menu.
      if (!open) settings.set(false, false);
      // WP4g: the folder-tab list and the session list are only drawn while
      // the drawer is open, so opening it is what fills them in.
      if (open) schedule();
    },
  });
  sidebar.set(layout.sidebar, false);

  /*
   * N-WP15a: the everyday switch.
   *
   * Three things happen on a click and all three are needed. The choice is
   * remembered for this browser; the stream is re-opened, because the server
   * decides whether to send the field from the URL that subscribed; and the
   * canvas is re-measured, because a node carrying a task is a line taller and
   * the cards have to be sized around the tree again.
   *
   * The card the user placed does not move: the session card's task line lives
   * in a gap the header already had, so `CARD.headerHeight` — which is what
   * every stored width and dragged height is held against — is the same number
   * in both states.
   */
  paintSwitch(taskTextButton, taskText);
  taskTextButton.addEventListener('click', () => {
    taskText = !taskText;
    writeTaskText(storage, taskText);
    paintSwitch(taskTextButton, taskText);
    restartStream();
    schedule();
  });

  /*
   * N-WP16: the sound settings.
   *
   * One document in `localStorage` and one paint function, so a switch cannot
   * be drawn out of step with what the rules read — `sounds` asks `() => sound`
   * on every event rather than being handed a copy at construction.
   *
   * The two clock fields are `<input type="time">`, which hands back exactly the
   * `HH:MM` that `inQuietHours` parses; a value it cannot parse suppresses
   * nothing, so an empty field is a quiet range that never bites rather than one
   * that silences the day.
   */
  const paintSound = (): void => {
    paintSwitch(soundEndButton, sound.onSessionEnd);
    paintSwitch(soundWaitingButton, sound.onWaiting);
    paintSwitch(soundQuietButton, sound.quietHours);
    soundQuietRow.hidden = !sound.quietHours;
    soundFrom.value = sound.from;
    soundTo.value = sound.to;
  };
  const saveSound = (next: SoundSettings): void => {
    sound = next;
    writeSound(storage, sound);
    paintSound();
  };
  paintSound();
  soundEndButton.addEventListener('click', () =>
    saveSound({ ...sound, onSessionEnd: !sound.onSessionEnd }),
  );
  soundWaitingButton.addEventListener('click', () =>
    saveSound({ ...sound, onWaiting: !sound.onWaiting }),
  );
  soundQuietButton.addEventListener('click', () =>
    saveSound({ ...sound, quietHours: !sound.quietHours }),
  );
  soundFrom.addEventListener('change', () => saveSound({ ...sound, from: soundFrom.value }));
  soundTo.addEventListener('change', () => saveSound({ ...sound, to: soundTo.value }));
  // The Test button is a gesture, so it both unlocks the audio and skips every
  // rule: somebody pressing it is asking what the sound is, not being told
  // something. It is also the reliable way out of the autoplay lock for anyone
  // who has kept their hands off the canvas.
  soundTestButton.addEventListener('click', () => {
    void soundPlayer.unlock().then(() => sounds.demonstrate());
  });

  paintSwitch(demoButton, demo);
  demoButton.addEventListener('click', () => {
    const next = new URLSearchParams(window.location.search);
    if (demo) next.delete('demo');
    else next.set('demo', '1');
    const query = next.toString();
    window.location.href = `${window.location.pathname}${query.length > 0 ? `?${query}` : ''}`;
  });

  /* ---- the desktop group, when there is a desktop ------------------ */

  // The whole group appears only inside the shell. The label says *Windows* because that
  // is the only platform the startup entry is wired for; the shell reports its own
  // platform so the day the others land, this line moves with them.
  if (shell !== undefined) {
    shellGroup.hidden = false;
    // The one sentence about double-clicking a card belongs with the shell too:
    // in a browser there is no terminal to raise. N-WP21 gave it a second
    // condition — a shell that cannot jump has no more use for the sentence
    // than a browser does — and it is hidden again below if `shell_info` says
    // so, which is a frame later than this line and invisible either way.
    shellAbout.hidden = false;
    const paintAutostart = (on: boolean, platform: string): void => {
      // The label names the machine, because "start with Windows" is a sentence
      // and "start with login" is what the same setting is called on Linux.
      const key =
        platform === 'macos'
          ? 'settings.autostart.macos'
          : platform === 'linux'
            ? 'settings.autostart.linux'
            : 'settings.autostart.windows';
      paintSwitch(autostartButton, on, t(key));
    };

    let autostartOn = false;
    let platform = 'windows';
    void shell.info().then((info) => {
      if (info !== undefined) {
        platform = info.platform;
        // N-WP21: the field WP8 put on the wire and nobody read. A shell that
        // says it cannot jump loses the menu entry, the strip's jump and the
        // sentence in About; the gesture itself becomes an ordinary click.
        jumpSupported = info.jumpSupported;
        shellAbout.hidden = !jumpSupported;
      }
      return shell.autostart();
    }).then((enabled) => {
      autostartOn = enabled ?? false;
      paintAutostart(autostartOn, platform);
    });

    autostartButton.addEventListener('click', () => {
      const wanted = !autostartOn;
      void shell.setAutostart(wanted).then((now) => {
        // The registry is the truth, so the button paints what came back rather than
        // what was asked for. A switch that lies about a setting is worse than no switch.
        if (now === undefined) {
          showHint(t('hint.autostartFailed'));
          return;
        }
        autostartOn = now;
        paintAutostart(autostartOn, platform);
      });
    });

    /*
     * N-WP15a: recording mode — the hard switch, and the one control here that
     * changes what the machine does rather than what this browser shows.
     *
     * On means the shell writes `taskText: "off"` into `desktop.json` and
     * **restarts the child server with `--no-task-text`**, so the readers come
     * back up unable to take transcript text out of a file at all. That is why
     * it is worth a restart: a switch that only stopped sending the field would
     * leave the text in memory, and the sentence this mode exists to be able to
     * say is *nothing was read*.
     *
     * The shell answers with what the setting is **now**, and the button paints
     * that rather than what was asked for — the same rule as the autostart
     * switch above, for the same reason. The stream is re-opened afterwards
     * because the server behind it is a new process.
     */
    let recordingOn = false;
    const paintRecording = (on: boolean): void => {
      recordingOn = on;
      paintSwitch(recordingButton, on);
      // A machine in recording mode makes the browser's own switch pointless:
      // it can be on and still show nothing. Saying so beats leaving somebody
      // to wonder why the line they switched on is not there.
      taskTextButton.disabled = on;
    };
    void shell.taskTextOff().then((off) => paintRecording(off ?? false));

    recordingButton.addEventListener('click', () => {
      const wanted = !recordingOn;
      void shell.setTaskTextOff(wanted).then((now) => {
        if (now === undefined) {
          showHint(t('hint.recordingFailed'));
          return;
        }
        paintRecording(now);
        restartStream();
        schedule();
      });
    });
  }

  const card = new HoverCard(cardRoot);
  const renderer = new CanvasRenderer(viewportGroup);

  /*
   * WP4e. The strip became a bead in the bar and a panel behind it, and open or
   * closed is a mode rather than a click — so it is remembered. The demo canvas
   * gets its own storage, so a screenshot of the panel is a URL and not a
   * sequence of clicks.
   */
  const usage = new UsagePanel({
    button: usageButton,
    buttonPercent: usagePercent,
    panel: usageRoot,
    list: usageList,
    explainer: usageExplainer,
    source: usageSourceNode,
    onToggle: (open) => writeUsageOpen(storage, open),
  });
  usageClose.addEventListener('click', () => usage.set(false, true));
  const usageWanted = params.get('usage') === '1' || readUsageOpen(storage);
  let usageRestored = false;

  /*
   * N-WP21: the Needs-you strip.
   *
   * Same shape as the usage popover and, unlike it, **nothing is remembered**:
   * there is no `open` to restore because there is no key to restore it from.
   * How long each session has been waiting lives in the strip's own memory for
   * as long as the page is up, and a reload starts those clocks again — which
   * is the honest answer, because the page genuinely does not know what
   * happened before it was opened.
   */
  const needsYou = new NeedsYouStrip({
    button: needsYouButton,
    count: needsYouCount,
    longest: needsYouLongest,
    live: needsYouLive,
    panel: needsYouRoot,
    title: needsYouTitleNode,
    list: needsYouList,
    empty: needsYouEmptyNode,
    finishedGroup: needsYouFinished,
    finishedToggle: needsYouFinishedToggle,
    finishedList: needsYouFinishedList,
    names: () => names.names,
    onGo: (sessionId) => focusSession(sessionId),
    // The jump exists only where it can be answered, exactly as the card menu's
    // own entry does — no shell, or a shell whose platform has no jump, and the
    // row takes you to the card and stops there.
    canJump: () => jumpSupported,
    ...(shell === undefined ? {} : { onJump: (sessionId: string) => jumpToTerminal(sessionId) }),
  });
  needsYouClose.addEventListener('click', () => needsYou.set(false, true));

  let state: StateSnapshot = {
    generatedAt: Date.now(),
    sessions: [],
    commandAvailable: false,
    warnings: 0,
  };
  let view: Viewport = { x: CANVAS_MARGIN, y: CANVAS_MARGIN, scale: 1 };
  let content: Box = EMPTY_BOX;
  let pendingFrame = 0;
  let fitted = false;
  let panning = false;
  /** What the last frame measured and drew. Read by the resize gesture. */
  let drawnMetrics: ReadonlyMap<string, CardMetric> = new Map();
  let drawnCards: readonly SessionView[] = [];
  /**
   * N-WP21: where the last frame put each card, so a row of the Needs-you list
   * can bring one into view. Held for the same reason the metrics are: it is
   * already computed, and recomputing it would be recomputing the whole layout.
   */
  let drawnPlacements: ReadonlyMap<string, Placement> = new Map();
  /**
   * A session the canvas has been asked to bring into view, honoured at the end
   * of the next frame. It is a *pending* thing and not a call because the card
   * may not be on this tab yet: switching tabs is a redraw, and the placement to
   * centre on only exists once that redraw has happened.
   */
  let pendingFocus: string | undefined;

  /**
   * The canvas draws one of two things. `live` is the SSE stream; `frozen` is
   * one finished session read from disk. They share every node component and
   * every gesture — only the data and the styling differ.
   */
  let frozenState: StateSnapshot | undefined;
  const isFrozen = (): boolean => frozenState !== undefined;
  const drawn = (): StateSnapshot => frozenState ?? state;

  const clock = (): number => (demo || isFrozen() ? drawn().generatedAt : Date.now());

  /*
   * WP4e: sticky notes.
   *
   * The layer is HTML on top of the SVG and it carries the *same* transform, so
   * a note sits in canvas coordinates exactly as a card does — see the header of
   * `web/notes.ts` for why a text box cannot be SVG. One consequence lands here:
   * `applyView` now moves two things, and they have to move in the same frame or
   * a note visibly lags its card during a pan.
   */
  const notesLayer = new NotesLayer({
    root: notesRoot,
    scale: () => view.scale,
    onChange: (change) => {
      notes =
        change.kind === 'remove'
          ? removeNote(notes, change.id)
          : change.kind === 'move'
            ? updateNote(notes, change.id, { x: change.x, y: change.y })
            : change.kind === 'resize'
              ? updateNote(notes, change.id, { width: change.width, height: change.height })
              : change.kind === 'colour'
                ? updateNote(notes, change.id, { colour: change.colour })
                : updateNote(notes, change.id, { text: change.text });
      saveNotes();
      // A move or a resize has already happened on screen under the pointer; a
      // remove and a colour have not, and repainting is how they appear.
      if (change.kind === 'remove' || change.kind === 'colour') schedule();
    },
  });

  /*
   * WP4f. Three layers move together on every pan and every zoom: the SVG
   * group, the HTML note layer on top of it, and — new here — the background
   * pattern underneath. The dots used to be nailed to the window, so panning
   * read as the cards sliding *over* a fixed grid rather than as the eye
   * travelling across a canvas, which is the one thing a canvas has to get
   * right. Three attribute writes, no re-render, no reflow.
   */
  const applyView = (): void => {
    setAttr(viewportGroup, 'transform', `translate(${view.x} ${view.y}) scale(${view.scale})`);
    setAttr(gridPattern, 'patternTransform', patternTransform(patternOffset(view, GRID_TILE)));
    notesLayer.applyView(view);
  };

  /** Put a new note on the current tab, at a point on the canvas, and type into it. */
  const addNoteAt = (x: number, y: number): void => {
    if (isFrozen()) {
      showHint(t('hint.frozenNoNotes'));
      return;
    }
    const made = addNote(notes, { tab: tabs.active, x: Math.round(x), y: Math.round(y) });
    notes = made.state;
    saveNotes();
    schedule();
    // The element exists only after the next paint, so the caret waits for it.
    window.requestAnimationFrame(() => notesLayer.focus(made.id));
  };

  /** A note dropped in the middle of what is on screen, for the sidebar button. */
  const addNoteInView = (): void => {
    const area = viewportBox();
    const centre = screenToCanvas(
      view,
      area.left + area.width / 2 - NOTE_SIZE.width / 2,
      area.height / 2 - NOTE_SIZE.height / 2,
    );
    addNoteAt(centre.x, centre.y);
  };

  /* ---- which sessions this tab shows ------------------------------ */

  const visible = (): readonly SessionView[] => {
    const shown = drawn();
    if (isFrozen()) return shown.sessions;
    // The whole session and not its id: a project tab is decided by the working
    // directory, so the filter needs the field the rule reads.
    const wanted = new Set(sessionsOnTab(tabs, tabs.active, shown.sessions));
    return shown.sessions.filter((session) => wanted.has(session.id));
  };

  /* ---- WP4g: projects --------------------------------------------- */

  /**
   * The label a card carries on a tab tooltip and in a project's session list:
   * the name the user typed, or the folder it is running in.
   */
  const cardLabel = (session: SessionView): string =>
    nameOf(names, session.id) ?? basename(session.cwd);

  /** Card labels per tab, so a tooltip can say who is on a tab you cannot see. */
  const tabTitles = (): Map<string, string[]> => {
    const titles = new Map<string, string[]>();
    for (const session of drawn().sessions) {
      const tabId = tabOf(tabs, session);
      const list = titles.get(tabId);
      if (list === undefined) titles.set(tabId, [cardLabel(session)]);
      else list.push(cardLabel(session));
    }
    return titles;
  };

  /**
   * How many past sessions a folder accounts for.
   *
   * `undefined` until the transcript store has been listed once, and `undefined`
   * is not `0`: nobody has counted, and printing a number nobody measured is
   * the one thing this canvas does not do. History knows a folder by its
   * `~/.claude/projects` slug and by nothing else, so the match is an exact
   * slug comparison — see `src/projects.ts` for why a prefix would be wrong.
   */
  const pastCount = (root: string): number | undefined => {
    const listed = panel.listed;
    if (listed === undefined) return undefined;
    return listed.filter((summary) => historyProjectMatches(root, summary.project)).length;
  };

  /** The name of the project that owns a history slug, for the drawer's headings. */
  const projectNameForSlug = (project: string): string | undefined =>
    projectTabs(tabs).find((tab) => tab.root !== undefined && historyProjectMatches(tab.root, project))
      ?.name;

  /** Every project, with what it is drawing now and what it accounts for. */
  const projectViews = (): ProjectView[] =>
    projectTabs(tabs).map((tab) => {
      const root = tab.root ?? '';
      return {
        id: tab.id,
        name: tab.name,
        root,
        live: drawn().sessions.filter((session) => tabOf(tabs, session) === tab.id).length,
        past: pastCount(root),
      };
    });

  /**
   * N-WP11: open the tab of a folder, put it in front, and say what it took.
   *
   * The count is the point of the sentence. A tab is opened from a session that
   * is on screen, so it can no longer own nothing — the typed form could do
   * that and this is half of why it went — but it can own *more* than the row
   * it was opened from, and that is worth saying at the moment it happens
   * rather than four sessions later.
   *
   * The name is never asked for: {@link openFolderTab} calls the tab after the
   * folder, and adds the parent folder to it only when another tab already has
   * that name. Renaming is unchanged, and still a double-click away.
   */
  const openFolder = (root: string): void => {
    const opened = openFolderTab(tabs, root);
    if (opened === undefined) return;
    tabs = setActiveTab(opened.state, opened.id);
    saveTabs();
    fitted = false;
    schedule();
    panel.repaint();
    projects.render(projectViews(), tabs.autoProjects);
    sessionList.render(sessionRows());
    const name = tabs.tabs.find((tab) => tab.id === opened.id)?.name ?? folderName(root);
    // The live sessions and not `drawn()`: a tab can be opened while a past
    // tree is frozen on screen, and the count is about the machine either way.
    const owned = state.sessions.filter((session) => tabOf(tabs, session) === opened.id).length;
    showHint(
      opened.created
        ? tCount('hint.tabOpened', owned, { name, count: owned })
        : t('hint.tabExists', { name }),
    );
  };

  /** Show a tab that already exists. Both sidebar lists and the menu use it. */
  const goToTab = (tabId: string): void => {
    tabs = setActiveTab(tabs, tabId);
    saveTabs();
    // A different set of cards deserves a fresh frame, exactly as the tab bar's
    // own click does.
    fitted = false;
    schedule();
  };

  /**
   * N-WP11: the sessions the sidebar lists, and the folder each one runs in.
   *
   * The live sessions, always — a frozen tree is a read of the past whose
   * `cwd` is a `~/.claude/projects` slug rather than a folder, and offering
   * *open a tab for* on that would make a tab out of a directory name that does
   * not exist. The drawer describes the machine; the canvas describes whatever
   * is on it.
   */
  const sessionRows = (): SessionRow[] =>
    state.sessions.map((session) => {
      const folder = cleanPath(session.cwd ?? '');
      const owner = folderTabAt(tabs, folder);
      return {
        id: session.id,
        label: cardLabel(session),
        folder,
        folderName: folderName(folder),
        tab: owner === undefined ? undefined : { id: owner.id, name: owner.name },
      };
    });

  /**
   * WP4f: the sessions as this tab actually draws them.
   *
   * One filter on top of `visible()`, and the only one that changes what a card
   * *contains* rather than which cards there are: finished subagents the user
   * cleared away are taken out of the tree here, before anything is measured.
   * Before, because the card's size is a function of its tree — clearing forty
   * finished agents has to make the card smaller, or it has not cleared
   * anything anyone can see.
   *
   * A frozen session is skipped entirely. A read of the past shows what
   * happened; hiding the finished agents of a run in which *everything* is
   * finished would leave an empty frame.
   */
  const shownSessions = (): {
    readonly sessions: readonly SessionView[];
    readonly hidden: Record<string, number>;
  } => {
    const base = visible();
    if (isFrozen()) return { sessions: base, hidden: {} };
    const sessions: SessionView[] = [];
    const hidden: Record<string, number> = {};
    for (const session of base) {
      const result = hideAgents(session, clearedFor(layout, session.id));
      sessions.push(result.session);
      if (result.hidden > 0) hidden[session.id] = result.hidden;
    }
    return { sessions, hidden };
  };

  const boxesOf = (
    sessions: readonly SessionView[],
    metrics: ReadonlyMap<string, CardMetric>,
  ): SizedBox[] => {
    const boxes: SizedBox[] = [];
    for (const session of sessions) {
      const metric = metrics.get(session.id);
      if (metric === undefined) continue;
      boxes.push({ id: session.id, width: metric.box.width, height: metric.box.height });
    }
    return boxes;
  };

  /**
   * The part of the canvas nothing is sitting on top of.
   *
   * Both drawers overlay the canvas rather than pushing it, which keeps the
   * cards from jumping when one opens. The cost is that "fit" has to know they
   * are there, or it frames the content behind the sidebar.
   */
  const viewportBox = (): { left: number; width: number; height: number } => {
    const left = sidebarRoot.hidden ? 0 : sidebarRoot.offsetWidth;
    const right = historyRoot.hidden ? 0 : historyRoot.offsetWidth;
    return {
      left,
      width: Math.max(240, host.clientWidth - left - right),
      height: host.clientHeight,
    };
  };

  const packSpec = (boxes: readonly SizedBox[]): { shelfWidth: number; gap: number } => ({
    shelfWidth: shelfWidth(boxes, viewportBox().width - CANVAS_MARGIN * 2, CARD.gap),
    gap: CARD.gap,
  });

  /**
   * Where each card goes.
   *
   * A card the user has placed keeps its place. A session that has just
   * appeared takes the first free slot among the ones already down, and that
   * slot is then stored — so the canvas looks the same after a reload, and a
   * new session never lands on top of one you arranged.
   */
  const resolvePlacements = (
    sessions: readonly SessionView[],
    metrics: ReadonlyMap<string, CardMetric>,
  ): Map<string, Placement> => {
    const result = new Map<string, Placement>();
    const settled: Placement[] = [];
    const pending: SizedBox[] = [];

    for (const box of boxesOf(sessions, metrics)) {
      const stored = layout.positions[box.id];
      if (stored === undefined) {
        pending.push(box);
        continue;
      }
      const placement: Placement = { ...box, x: stored.x, y: stored.y };
      result.set(box.id, placement);
      settled.push(placement);
    }

    if (pending.length > 0) {
      const spec = packSpec(boxesOf(sessions, metrics));
      for (const box of pending) {
        const at = firstFreeSlot(settled, box, spec);
        const placement: Placement = { ...box, ...at };
        result.set(box.id, placement);
        settled.push(placement);
        layout = withPosition(layout, box.id, at);
      }
      saveLayout();
    }

    return result;
  };

  /** A frozen tree is one card, and it always sits at the origin. */
  const frozenPlacements = (
    sessions: readonly SessionView[],
    metrics: ReadonlyMap<string, CardMetric>,
  ): Map<string, Placement> => {
    const result = new Map<string, Placement>();
    for (const box of boxesOf(sessions, metrics)) result.set(box.id, { ...box, x: 0, y: 0 });
    return result;
  };

  /* ---- the frame -------------------------------------------------- */

  const tabBar = new TabBar({
    root: tabsRoot,
    onSelect: (tabId) => {
      if (tabId.length === 0) return;
      tabs = setActiveTab(tabs, tabId);
      saveTabs();
      // A different set of cards deserves a fresh frame rather than whatever
      // corner of the canvas the previous tab happened to be showing.
      fitted = false;
      schedule();
    },
    onCreate: (name) => {
      const made = createTab(tabs, name);
      tabs = setActiveTab(made.state, made.id);
      saveTabs();
      fitted = false;
      schedule();
    },
    onRename: (tabId, name) => {
      tabs = renameTab(tabs, tabId, name);
      saveTabs();
      schedule();
    },
    onRemove: (tabId) => {
      tabs = removeTab(tabs, tabId);
      // The tab's sessions fall back to `All`, and so do its notes. Deleting
      // somebody's own sentences as a side effect of closing a view would be
      // the one destructive gesture on this canvas.
      notes = reassignNotes(notes, tabId, ALL_TAB);
      saveTabs();
      saveNotes();
      fitted = false;
      schedule();
    },
  });

  /*
   * WP4g, N-WP11: the Folder tabs section of the sidebar.
   *
   * It draws the same list the tab bar does, from the same state, and every
   * control on it goes through the same functions the card menu does — there is
   * exactly one place a folder tab is opened, renamed or closed, and this panel
   * is a view of it rather than a second implementation. Opening is not one of
   * its controls any more: that gesture moved to the session list below, where
   * the folder is a fact on screen rather than a string somebody typed.
   */
  const projects = new ProjectsPanel({
    autoRoot: autoTabsRoot,
    root: projectsRoot,
    onRename: (tabId, name) => {
      tabs = renameTab(tabs, tabId, name);
      saveTabs();
      panel.repaint();
      schedule();
      projects.render(projectViews(), tabs.autoProjects);
    },
    onRemove: (tabId) => {
      tabs = removeTab(tabs, tabId);
      notes = reassignNotes(notes, tabId, ALL_TAB);
      saveTabs();
      saveNotes();
      fitted = false;
      panel.repaint();
      schedule();
      projects.render(projectViews(), tabs.autoProjects);
    },
    onSelect: (tabId) => goToTab(tabId),
    onAuto: (on) => {
      tabs = setAutoProjects(tabs, on);
      saveTabs();
      schedule();
      projects.render(projectViews(), tabs.autoProjects);
      showHint(t(on ? 'hint.autoTabsOn' : 'hint.autoTabsOff'));
    },
    onCountPast: () => {
      void panel.refresh().then(() => projects.render(projectViews(), tabs.autoProjects));
    },
  });

  /*
   * N-WP11: the sessions, and the one gesture that makes a folder tab.
   *
   * The maintainer's sentence was that a tab should come from a session he can
   * already see, not from a path he has to write out, so this list is where the
   * feature lives now: one row per live session, the folder underneath the
   * name, and a button that opens a tab for that folder — or goes to the tab it
   * already has. Right-clicking a row opens the card's own menu, which is the
   * only place the folders *above* this one are offered.
   */
  const sessionList = new SessionList({
    root: sessionsRoot,
    onOpenFolder: (sessionId, root) => {
      openFolder(root);
      // A card pinned to a tab by hand would not join the tab it was just used
      // to open, which reads as the button having done nothing.
      if (isPinned(tabs, sessionId)) {
        tabs = followProject(tabs, sessionId);
        saveTabs();
        schedule();
      }
    },
    onGoToTab: (tabId) => goToTab(tabId),
    // The card menu, at the pointer. `openCardMenu` is the same call the canvas
    // makes on a right-click, so the two gestures cannot drift apart — and it
    // reads the card off the canvas, which is why it is refused while a frozen
    // tree is on screen: half its entries act on a card that is not drawn.
    onMenu: (sessionId, at) => {
      if (isFrozen()) {
        showHint(t('hint.frozenNoMenu'));
        return;
      }
      openCardMenu(sessionId, at);
    },
  });

  const cardMenu = new CardMenu({
    root: cardMenuRoot,
    onMove: (sessionId, tabId) => {
      tabs = moveSession(tabs, sessionId, tabId);
      saveTabs();
      schedule();
    },
    onNewTab: (sessionId) => {
      const made = createTab(tabs, basename(drawn().sessions.find((s) => s.id === sessionId)?.cwd));
      tabs = moveSession(made.state, sessionId, made.id);
      saveTabs();
      schedule();
    },
    onCollapse: (sessionId) => toggleCollapse(sessionId),
    onClearFinished: (sessionId) => clearFinished(sessionId),
    onRestore: (sessionId) => restoreHidden(sessionId),
    onResetSize: (sessionId) => resetSize(sessionId),
    // WP4g. The menu closes before the editor opens, so the input is not
    // placed under a popup that is about to be removed from under it.
    onRename: (sessionId) => window.requestAnimationFrame(() => beginRename(sessionId)),
    onClearName: (sessionId) => setName(sessionId, ''),
    onOpenFolder: (sessionId, root) => {
      openFolder(root);
      // A card that was pinned somewhere by hand would not join the tab it was
      // just used to open, which reads as the entry having done nothing.
      if (isPinned(tabs, sessionId)) {
        tabs = followProject(tabs, sessionId);
        saveTabs();
        schedule();
      }
    },
    onGoToTab: (tabId) => goToTab(tabId),
    onFollowProject: (sessionId) => {
      tabs = followProject(tabs, sessionId);
      saveTabs();
      schedule();
      const session = drawn().sessions.find((one) => one.id === sessionId);
      const tab = session === undefined ? undefined : tabs.tabs.find((one) => one.id === tabOf(tabs, session));
      showHint(
        tab === undefined
          ? t('hint.followsRules')
          : t('hint.followsTab', { name: tab.name }),
      );
    },
    // Only in the shell, and — N-WP21 — only in a shell that can actually jump.
    // In a browser the entry is not drawn, so the menu has no dead item in it
    // and the double-click hint is the only place the feature is mentioned; on
    // a mac or Linux bundle it is not drawn either, because `jump.rs` is
    // Windows-only and an item whose one answer is "not on this platform" is
    // exactly the dead item that rule exists to avoid.
    canJump: () => jumpSupported,
    ...(shell === undefined ? {} : { onJump: (sessionId: string) => jumpToTerminal(sessionId) }),
  });

  const toggleCollapse = (sessionId: string): void => {
    layout = withCollapsed(layout, sessionId, !layout.collapsed.includes(sessionId));
    saveLayout();
    schedule();
  };

  /* ---- WP4g: naming a card ---------------------------------------- */

  /** Which card the inline editor is open on. */
  let renaming: string | undefined;

  const setName = (sessionId: string, value: string): void => {
    const before = nameOf(names, sessionId);
    names = withName(names, sessionId, value);
    saveNames();
    schedule();
    const after = nameOf(names, sessionId);
    if (before !== undefined && after === undefined) showHint(t('hint.nameCleared'));
  };

  const endRename = (commit: boolean): void => {
    const sessionId = renaming;
    if (sessionId === undefined) return;
    renaming = undefined;
    const value = renameField.value;
    renameField.hidden = true;
    renameField.value = '';
    // Committing an empty field is how a name is removed, which is why the
    // commit path does not check for one: `setName` treats empty as "clear".
    if (commit) setName(sessionId, value);
  };

  /**
   * Open the editor over a card's title.
   *
   * An HTML `<input>` laid over the SVG text rather than an SVG editor: there
   * is no such thing as an editable `<text>`, and a `<foreignObject>` inside
   * the pan-and-zoom group would be a text box that scales with the canvas —
   * unreadable at 0.4x and enormous at 2x. The field is positioned from the
   * title's screen rectangle every time it opens, so it lands exactly on the
   * words it replaces whatever the view is.
   */
  const beginRename = (sessionId: string): void => {
    if (isFrozen()) {
      showHint(t('hint.frozenNoNames'));
      return;
    }
    const anchor = renderer.nameAnchor(sessionId);
    if (anchor === undefined) return;
    renaming = sessionId;
    const session = drawn().sessions.find((one) => one.id === sessionId);
    renameField.value = nameOf(names, sessionId) ?? '';
    renameField.placeholder = basename(session?.cwd);
    renameField.hidden = false;
    renameField.style.transform = `translate(${Math.round(anchor.left)}px, ${Math.round(anchor.top)}px)`;
    renameField.style.width = `${Math.max(90, Math.round(anchor.width))}px`;
    renameField.focus();
    renameField.select();
  };

  renameField.addEventListener('keydown', (event) => {
    // The canvas has single-key shortcuts. Every one of them would fire into
    // this field if the event were allowed to reach the document.
    event.stopPropagation();
    if (event.key === 'Enter') endRename(true);
    else if (event.key === 'Escape') endRename(false);
  });
  // Clicking away commits, which is what every inline editor on this canvas
  // does — the tab title, the note, the project name.
  renameField.addEventListener('blur', () => endRename(true));

  /**
   * How many subagents *Clear finished* would actually take off this card.
   *
   * Not the number of finished agents: a finished agent that spawned one that
   * is still running stays, because hiding it would either orphan its child or
   * take the child with it. So the answer is the difference the filter makes,
   * measured by running it — which is what keeps the menu entry, the hint and
   * the chip from quoting three different numbers for one action.
   */
  const clearableCount = (session: SessionView, already: ReadonlySet<string>): number => {
    const now = hideAgents(session, already).hidden;
    const after = hideAgents(session, new Set([...already, ...finishedAgentIds(session)])).hidden;
    return after - now;
  };

  /**
   * WP4f: put every finished subagent on one card away.
   *
   * The ids are taken from the session as it is *now* — hiding what has
   * finished, not "everything that ever finishes here" — and the set is the
   * union with whatever was already hidden, so clicking it again after ten more
   * agents finish does the obvious thing.
   */
  const clearFinished = (sessionId: string): void => {
    const session = drawn().sessions.find((one) => one.id === sessionId);
    if (session === undefined) return;
    const already = clearedFor(layout, sessionId);
    const going = clearableCount(session, already);
    if (going === 0) {
      showHint(
        t(finishedAgentIds(session).length === 0 ? 'hint.noneFinished' : 'hint.allHaveChildren'),
      );
      return;
    }
    layout = withCleared(layout, sessionId, finishedAgentIds(session));
    saveLayout();
    schedule();
    showHint(tCount('hint.cleared', going));
  };

  const restoreHidden = (sessionId: string): void => {
    layout = withRestored(layout, sessionId);
    saveLayout();
    schedule();
  };

  const resetSize = (sessionId: string): void => {
    layout = withAutoSize(layout, sessionId);
    saveLayout();
    schedule();
  };

  /**
   * WP4g: make a project of every folder a session is running in.
   *
   * Only when the switch is on, only for folders no project already owns, and
   * only from the session's own `cwd` — never from a parent, because guessing
   * how far up somebody's repository starts is exactly the guess the ⋯ menu's
   * dropdown exists to let a person make themselves.
   *
   * It runs before the frame is drawn so a session that has just appeared lands
   * on its project's tab immediately rather than one frame later on `All`.
   */
  const autoCreateProjects = (): boolean => {
    if (!tabs.autoProjects || isFrozen()) return false;
    let changed = false;
    for (const session of drawn().sessions) {
      const cwd = session.cwd;
      if (cwd === undefined || cleanPath(cwd).length === 0) continue;
      if (isPinned(tabs, session.id)) continue;
      if (tabOf(tabs, session) !== ALL_TAB) continue;
      tabs = createProjectTab(tabs, cwd).state;
      changed = true;
    }
    if (changed) saveTabs();
    return changed;
  };

  const draw = (): void => {
    pendingFrame = 0;
    if (autoCreateProjects()) fitted = false;
    const frozen = isFrozen();
    const shown = shownSessions();
    const sessions = shown.sessions;
    const collapsed = new Set(frozen ? [] : layout.collapsed);

    const metrics = measureCards(sessions, collapsed, {
      ...(frozen ? {} : { widths: layout.widths, heights: layout.heights }),
      taskText,
    });
    const placements = frozen
      ? frozenPlacements(sessions, metrics)
      : resolvePlacements(sessions, metrics);
    content = renderer.update(sessions, metrics, placements, clock(), {
      frozen,
      hidden: shown.hidden,
      // WP4g. A frozen tree is a read of the past and belongs to no tab; it is
      // also not one of the canvas's cards, so it carries no name of its own.
      ...(frozen ? {} : { names: names.names }),
      taskText,
    }).bounds;
    // Held for the gestures: a resize needs the card it is about to change and
    // the tree that decides how small it may get, and neither is worth
    // recomputing under the pointer.
    drawnMetrics = metrics;
    drawnCards = sessions;
    drawnPlacements = placements;

    // The banner is about the whole machine, not about the tab you happen to be
    // looking at: a session waiting for a permission prompt on another tab is
    // still waiting for you.
    const waiting = frozen ? [] : drawn().sessions.filter((session) => isWaiting(session));
    banner.hidden = waiting.length === 0;
    if (waiting.length > 0) {
      const names = waiting
        .map((session) => `${basename(session.cwd)} (${orUnknown(session.waitingFor)})`)
        .join('   ·   ');
      setText(bannerText, tCount('banner.waiting', waiting.length, { names }));
    }

    // WP5. Usage is about the machine, not about the tab or the tree on screen:
    // a session opened out of history says nothing about what is left of this
    // week's window, so the bead keeps drawing the live numbers against the live
    // clock even while the canvas is frozen. `state` and not `drawn()` for the
    // same reason.
    usage.render(state.quota, demo ? state.generatedAt : Date.now());
    setText(quotaSource, quotaSourceLabel(state.quota));
    // Restoring "the panel was open" has to wait for the first render: until
    // then nothing knows whether this machine has a source at all, and opening
    // an empty panel would be the placeholder WP5 exists not to draw.
    if (!usageRestored && usage.hasSource) {
      usageRestored = true;
      usage.set(usageWanted, false);
    }

    /*
     * N-WP21. The strip reads `state` and never `drawn()`, for the reason the
     * usage bead does: a session waiting for a permission prompt is waiting for
     * you whether you are looking at another tab or at a session that finished
     * last Tuesday. It is also the only place on the page whose clocks have to
     * keep running while a frozen tree is on screen — a wait that paused
     * because you opened the history drawer would be a wait that lies.
     */
    needsYou.render(state.sessions, demo ? state.generatedAt : Date.now(), state.generatedAt);

    // WP4e. Notes belong to a tab of the live canvas. A frozen tree is a read of
    // the past and has no tab, so the layer goes away rather than showing the
    // notes of whichever tab happened to be open behind it.
    notesLayer.setVisible(!frozen);
    if (!frozen) notesLayer.render(notes, tabs.active);

    const hasSessions = sessions.length > 0;
    empty.hidden = hasSessions || frozen;
    if (!empty.hidden) {
      // An empty *tab* is not an empty machine, and telling someone to start
      // `claude` when three sessions are already running would be nonsense.
      const elsewhere = drawn().sessions.length;
      const tab = tabs.tabs.find((one) => one.id === tabs.active);
      setText(
        emptyTitle,
        elsewhere === 0
          ? t('empty.title')
          : t('empty.tabTitle', { name: tab?.name ?? t('empty.thisTab') }),
      );
      emptyTabHint.hidden = elsewhere === 0;

      /*
       * N-WP20: the first five minutes.
       *
       * The old empty state said "no sessions found" and told everybody to
       * start `claude`, which is the right answer to exactly one of the three
       * ways a canvas can be empty and nonsense for the other two — a moved
       * `CLAUDE_CONFIG_DIR` is not fixed by opening another terminal. The
       * server now sends the same verdict `nazar doctor` prints, so the page
       * can say which of the three it is and what to do about it.
       *
       * The generic hint is what shows when there is no diagnosis: an empty
       * *tab* on a busy machine, and the demo, which has nothing to diagnose.
       */
      const diagnosis = frozen ? undefined : state.empty;
      const explained = elsewhere === 0 && diagnosis !== undefined;
      emptyHint.hidden = elsewhere > 0 || explained;
      emptyWhy.hidden = !explained;
      emptyNext.hidden = !explained;
      emptyNote.hidden = true;
      if (explained && diagnosis !== undefined) {
        const lines = emptyStateLines(diagnosis);
        setText(emptyWhy, lines.why);
        setText(emptyNext, lines.next);
        // Neither note is why the canvas is empty, so neither may be read as
        // the reason: they are a quieter second line, and only when true.
        emptyNote.hidden = lines.notes.length === 0;
        if (lines.notes.length > 0) setText(emptyNote, lines.notes.join(' · '));
      }
    }
    const agentCount = sessions.reduce((sum, session) => sum + session.agents.length, 0);
    setText(
      counts,
      hasSessions
        ? `${tCount(frozen ? 'bar.frozenSessions' : 'bar.sessions', sessions.length, {
            count: formatCount(sessions.length),
          })} · ` + tCount('bar.subagents', agentCount, { count: formatCount(agentCount) })
        : '',
    );

    tabsRoot.hidden = frozen;
    if (!frozen) {
      tabBar.render(tabs, tabCounts(tabs, drawn().sessions), tabTitles());
    }
    // The sidebar's two lists are views of the same state, and their counts
    // move with the canvas. Both are behind a drawer, so redrawing them every
    // frame would be work nobody sees — only when the drawer is open.
    if (sidebar.isOpen) {
      projects.render(projectViews(), tabs.autoProjects);
      sessionList.render(sessionRows());
    }

    if (!fitted && hasSessions) {
      fitted = true;
      const area = viewportBox();
      const opening = initialViewport(content, area, CANVAS_MARGIN);
      view = { ...opening, x: opening.x + area.left };
    }
    applyView();

    // N-WP21. After the view, because centring on a card is a view change and
    // doing it before `applyView` would be a frame the eye sees flick.
    if (pendingFocus !== undefined) {
      const wanted = pendingFocus;
      pendingFocus = undefined;
      revealCard(wanted);
    }
  };

  const schedule = (): void => {
    if (pendingFrame !== 0) return;
    pendingFrame = window.requestAnimationFrame(draw);
  };

  /* ---- arrange and fit -------------------------------------------- */

  /**
   * Re-pack every card on this tab.
   *
   * WP4f: the sizes are passed through, so *Arrange* tidies the cards the user
   * sized rather than quietly resetting them. Sizing a card and then tidying
   * the canvas must not undo the sizing.
   */
  const arrange = (): void => {
    const sessions = shownSessions().sessions;
    const metrics = measureCards(sessions, new Set(layout.collapsed), {
      widths: layout.widths,
      heights: layout.heights,
      taskText,
    });
    const boxes = boxesOf(sessions, metrics);
    for (const placement of packShelves(boxes, packSpec(boxes)).placements) {
      layout = withPosition(layout, placement.id, placement);
    }
    saveLayout();
    fitted = false;
    schedule();
  };

  const fit = (): void => {
    const area = viewportBox();
    const framed = fitToBox(content, area, CANVAS_MARGIN);
    view = { ...framed, x: framed.x + area.left };
    applyView();
  };

  /* ---- take me to that card (N-WP21) ------------------------------- */

  /** The `<g>` a session is drawn as, if this frame drew one. */
  const cardNode = (sessionId: string): SVGGElement | undefined => {
    for (const node of viewportGroup.querySelectorAll<SVGGElement>('.nz-session')) {
      if (node.dataset['sessionId'] === sessionId) return node;
    }
    return undefined;
  };

  /**
   * Put a card in the middle of what is on screen, and give it the keyboard.
   *
   * The zoom is left exactly as the user set it: a row of a list is not a
   * reason to reframe somebody's canvas, and *Fit* is one key away for anybody
   * who wants that. A session with no placement this frame is one that is not
   * on the visible tab, which `focusSession` has already dealt with — so
   * silence here rather than a guess at where it might be.
   */
  const revealCard = (sessionId: string): void => {
    const placement = drawnPlacements.get(sessionId);
    if (placement === undefined) return;
    const area = viewportBox();
    view = {
      ...view,
      x: area.left + area.width / 2 - (placement.x + placement.width / 2) * view.scale,
      y: area.height / 2 - (placement.y + placement.height / 2) * view.scale,
    };
    applyView();
    // The card is `tabindex="0"`, so this is a real keyboard stop and Enter on
    // it is already the jump. Focus is what makes the row a *navigation* rather
    // than a scroll: whoever arrived by keyboard is now standing on the card.
    cardNode(sessionId)?.focus();
  };

  /**
   * Take me to a session: the whole gesture behind the `→` on a Needs-you row.
   *
   * Four steps, and each of them is a thing that would otherwise leave the user
   * looking at the wrong screen. Leave a frozen tree, because a past session is
   * not where a live one is waiting. Switch to the tab the card is on, because
   * a session lives on exactly one and it need not be the one showing. Centre
   * on it and focus it, once the frame that places it has run. The fourth step
   * — raising the terminal — is the strip's own `onJump`, which exists only
   * inside the desktop shell.
   */
  const focusSession = (sessionId: string): void => {
    backToLive();
    const session = state.sessions.find((one) => one.id === sessionId);
    if (session === undefined) return;
    const tab = tabOf(tabs, session);
    if (tab !== tabs.active) goToTab(tab);
    pendingFocus = sessionId;
    schedule();
  };

  arrangeButton.addEventListener('click', arrange);
  fitButton.addEventListener('click', fit);
  addNoteButton.addEventListener('click', addNoteInView);

  /* ---- the canvas's own menu (WP4e) -------------------------------- */

  const canvasMenu = new CanvasMenu({
    root: canvasMenuRoot,
    onPick: (item, at) => {
      if (item === 'add-note') addNoteAt(at.x, at.y);
      else if (item === 'arrange') arrange();
      else fit();
    },
  });

  /*
   * N-WP15a: what the two link entries actually do.
   *
   * *Open* is `window.open(..., '_blank', 'noopener')` in both modes and that is
   * not a compromise — the shell's `capabilities/canvas.json` deliberately grants
   * the canvas no shell or opener permission at all, and a webview navigation to
   * an external site is caught by Tauri's own external-link handling, which
   * hands it to the machine's browser. So the page asks for the same thing
   * everywhere and each host does the right thing with it, instead of the canvas
   * having to learn which host it is in and the shell having to grow a fifth
   * command the whole loopback origin could then call.
   *
   * *Copy* fails silently. `navigator.clipboard` is refused in some contexts and
   * needs a permission in others; the address is printed in the menu the user is
   * looking at, so a failure leaves them one selection away from it, and a hint
   * saying "could not copy" would be noise on top of something they can see.
   */
  const linkMenu = new LinkMenu({
    root: linkMenuRoot,
    onPick: (item, href) => {
      if (item === 'open') {
        window.open(href, '_blank', 'noopener');
        return;
      }
      void navigator.clipboard?.writeText(href).catch(() => undefined);
    },
  });

  /* ---- hover card, by delegation ---------------------------------- */

  const show = (node: EventTarget | null): void => {
    if (panning || cardDrag !== undefined || cardResize !== undefined) return;
    const hit = targetFrom(node);
    if (hit === undefined) {
      card.hide();
      return;
    }
    const frozen = isFrozen();
    const session = drawn().sessions.find((one) => one.id === hit.target.sessionId);
    if (session === undefined) {
      card.hide();
      return;
    }
    const anchor = hit.element.getBoundingClientRect();
    if (hit.target.kind === 'session') {
      card.showSession(session, anchor, clock(), frozen, nameOf(names, session.id));
      return;
    }
    const agent = session.agents.find((one: Agent) => one.id === hit.target.agentId);
    if (agent === undefined) card.hide();
    else card.showAgent(agent, anchor, clock(), frozen);
  };

  host.addEventListener('pointerover', (event) => show(event.target));
  host.addEventListener('pointerleave', () => card.hide());
  host.addEventListener('focusin', (event) => show(event.target));
  host.addEventListener('focusout', () => card.hide());

  /* ---- gestures --------------------------------------------------- */

  let panOrigin = { x: 0, y: 0, viewX: 0, viewY: 0 };
  /** A card being moved: which one, from where, and where it started. */
  let cardDrag:
    | { id: string; pointerId: number; x: number; y: number; originX: number; originY: number }
    | undefined;
  let cardDragTarget = { x: 0, y: 0 };

  /**
   * WP4f, widened in N-WP10: a card being resized — which one, from which of
   * the eight handles, where the pointer and the box were at the press, and the
   * four bounds the box may not cross.
   *
   * All of it is measured once, at the press. `minWidth` comes from the tree
   * that is *showing* — collapse the tree or clear its finished agents and the
   * next press measures a smaller minimum — and `minHeight` is the height that
   * tree needs right now. Measuring either on every `pointermove` would mean a
   * second tree layout per frame to answer a question whose answer cannot
   * change while the pointer is down.
   */
  let cardResize:
    | {
        id: string;
        pointerId: number;
        handle: ResizeHandle;
        pointerX: number;
        pointerY: number;
        start: ResizeBox;
        bounds: ResizeBounds;
      }
    | undefined;

  /**
   * Open a card's ⋯ menu.
   *
   * `at` is where the pointer was, for a right-click; without it the menu hangs
   * off the ⋯ button, which is where a click on the button expects it. Both are
   * the same menu — WP4e's whole point is that the gesture everybody tries first
   * reaches the menu that already existed, rather than the browser's.
   */
  const openCardMenu = (
    sessionId: string,
    at?: { readonly left: number; readonly top: number; readonly bottom: number },
  ): void => {
    if (at === undefined && cardMenu.openFor === sessionId) {
      cardMenu.close();
      return;
    }
    const anchor = at ?? renderer.menuAnchor(sessionId);
    if (anchor === undefined) return;
    // Counted off the *unfiltered* session, so "Clear finished (12)" is the
    // number of agents that would go — and off the filtered one for how many
    // are already gone, which is what the second entry offers back.
    const session = drawn().sessions.find((one) => one.id === sessionId);
    const hiddenHere = clearedFor(layout, sessionId);
    // WP4g, N-WP11: the folders this session could have a tab for, and the tab
    // each one already has, if it has one. Both are read here rather than in
    // the menu, so the menu stays a renderer of a decision somebody else made.
    const folders = session === undefined ? [] : ancestorPaths(session.cwd ?? '');
    const folderTabsFor = new Map<string, { id: string; name: string }>();
    for (const folder of folders) {
      const owner = folderTabAt(tabs, folder);
      if (owner !== undefined) folderTabsFor.set(folder, { id: owner.id, name: owner.name });
    }
    cardMenu.open(sessionId, anchor, {
      tabs,
      current: session === undefined ? ALL_TAB : tabOf(tabs, session),
      collapsed: layout.collapsed.includes(sessionId),
      finished: session === undefined ? 0 : clearableCount(session, hiddenHere),
      hidden: session === undefined ? 0 : hideAgents(session, hiddenHere).hidden,
      sized: isSized(layout, sessionId),
      ...(nameOf(names, sessionId) === undefined
        ? {}
        : { name: nameOf(names, sessionId) as string }),
      folders,
      folderTabs: folderTabsFor,
      pinned: isPinned(tabs, sessionId),
    });
  };

  /** True when a pointer event happened inside a sticky note. */
  const inNote = (node: EventTarget | null): boolean =>
    node instanceof Element && node.closest('.nz-note') !== null;

  /** The note a pointer event happened in, if it happened in one. */
  const noteIdAt = (node: EventTarget | null): string | undefined =>
    node instanceof Element
      ? node.closest<HTMLElement>('.nz-note')?.dataset['noteId']
      : undefined;

  /**
   * N-WP15a: the address of the `<a href>` a pointer event happened in.
   *
   * `closest('a[href]')` because a link can wrap a `<span>` or an icon, and
   * `element.href` rather than the attribute so a relative address arrives
   * already resolved — the menu shows it and the shell has to open it, and both
   * want the absolute form. Only `http` and `https` are answered: a `mailto:`
   * or a `javascript:` is not something this menu's two entries mean anything
   * for, and refusing them here is cheaper than teaching the shell to.
   */
  const linkHrefAt = (node: EventTarget | null): string | undefined => {
    if (!(node instanceof Element)) return undefined;
    // `'a'` rather than `'a[href]'`: nested anchors are invalid markup, so the
    // nearest `<a>` is the only candidate either way — and an `<a>` with no
    // address has an empty `href`, which the scheme check below refuses anyway.
    // (It also keeps this literal a bare word, which is what the N-WP13 gate
    // wants from a string in a page module.)
    const anchor = node.closest<HTMLAnchorElement>('a');
    if (anchor === null) return undefined;
    const href = anchor.href;
    return href.startsWith('http://') || href.startsWith('https://') ? href : undefined;
  };

  /** The note being typed into right now, if one is. */
  const noteWithCaret = (): string | undefined => {
    const caret = document.activeElement;
    return caret instanceof HTMLTextAreaElement
      ? caret.closest<HTMLElement>('.nz-note')?.dataset['noteId']
      : undefined;
  };

  /**
   * Which note had the caret when the last press *began*, and whether a press
   * is what asked for the menu at all.
   *
   * Read at `pointerdown` and not at `contextmenu`, because putting the caret
   * into a text field is the **default action of the press that opens the
   * menu**: by the time `contextmenu` fires, right-clicking a note's text box
   * has already focused it, and asking then would answer *being edited* for
   * every note anybody right-clicks — which is exactly the note this gesture
   * exists to open a menu for. The press is the last moment the question still
   * has its real answer.
   *
   * A menu asked for from the keyboard (the Menu key, Shift+F10) is preceded by
   * no press, moved no caret, and has to be answered from the caret as it is
   * now. Which of the two happened is read off the event that came last rather
   * than off `event.button`, which is 2 for the right-click that opens this
   * menu on Windows and 0 for the Control-click that opens it on a Mac.
   */
  let caretNoteAtPress: string | undefined;
  let askedByPointer = false;
  document.addEventListener(
    'pointerdown',
    () => {
      caretNoteAtPress = noteWithCaret();
      askedByPointer = true;
    },
    true,
  );
  document.addEventListener(
    'keydown',
    () => {
      askedByPointer = false;
    },
    true,
  );

  /**
   * True when the browser's own menu is the useful one: a text field.
   *
   * `isContentEditable` answers for the ancestors too and is false for
   * `contenteditable="false"`, so no `closest()` is needed for that half; an
   * `<input>` and a `<textarea>` have no element children, so the event target
   * *is* the field whenever the pointer is in one.
   */
  const inTextField = (node: EventTarget | null): boolean =>
    node instanceof HTMLInputElement ||
    node instanceof HTMLTextAreaElement ||
    (node instanceof HTMLElement && node.isContentEditable);

  /** Where on the canvas a screen point is, in the coordinates cards use. */
  const canvasPointOf = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = host.getBoundingClientRect();
    return screenToCanvas(view, clientX - rect.left, clientY - rect.top);
  };

  /*
   * WP4e, N-WP14: the right-click, for the whole page.
   *
   * On `document` rather than on the canvas, because the complaint was about
   * the top bar and the drawer as much as about a card: a page that answers the
   * gesture on four of its five surfaces looks broken on the fifth. What it
   * answers *with* is `contextActionOf`, a pure function in
   * `src/contextmenu.ts` so the rule can be tested without a DOM. Only one of
   * its five answers leaves the browser's menu alone — a text field, which is
   * the one menu this application cannot draw.
   */
  document.addEventListener('contextmenu', (event) => {
    // Something closer to the target has already answered — the drawer's
    // session rows open the card menu themselves. Nothing to add, and closing
    // menus here would close the one that handler has just opened.
    if (event.defaultPrevented) return;
    const note = noteIdAt(event.target);
    const sessionId = sessionIdOf(event.target);
    const href = linkHrefAt(event.target);
    // A press moved the caret itself, so the note it was in beforehand is the
    // honest answer; the keyboard's own menu key moved nothing.
    const caret = askedByPointer ? caretNoteAtPress : noteWithCaret();
    const action = contextActionOf({
      editable: inTextField(event.target),
      onCanvas: event.target instanceof Node && host.contains(event.target),
      ...(note === undefined ? {} : { noteId: note, editing: caret === note }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(href === undefined ? {} : { href }),
      frozen: isFrozen(),
    });
    if (action === 'native') return;
    event.preventDefault();
    // The chrome and the frozen tree: the browser's menu is gone and there is
    // nothing to put in its place.
    if (action === 'suppress') return;
    cardMenu.close();
    canvasMenu.close();
    linkMenu.close();
    notesLayer.closeMenus();
    const anchor = { left: event.clientX, top: event.clientY, bottom: event.clientY };
    // N-WP15a. Before the note and the card, because a link inside either is
    // still a link and the two entries it offers are about the address.
    if (action === 'link-menu' && href !== undefined) {
      linkMenu.open(anchor, href);
      return;
    }
    if (action === 'note-menu' && note !== undefined) {
      notesLayer.openMenu(note, { clientX: event.clientX, clientY: event.clientY });
      return;
    }
    if (action === 'card-menu' && sessionId !== undefined) {
      openCardMenu(sessionId, anchor);
      return;
    }
    const at = canvasPointOf(event.clientX, event.clientY);
    canvasMenu.open(anchor, { x: at.x - NOTE_SIZE.width / 2, y: at.y - 14 });
  });

  /** The chevron and the ⋯ button, from a pointer or from the keyboard. */
  const runCardAction = (node: EventTarget | null): boolean => {
    if (!(node instanceof Element)) return false;
    const control = node.closest<SVGGElement>('[data-action]');
    if (control === null) return false;
    const sessionId = sessionIdOf(control);
    if (sessionId === undefined || isFrozen()) return true;
    const action = control.dataset['action'];
    if (action === 'collapse') toggleCollapse(sessionId);
    else if (action === 'menu') openCardMenu(sessionId);
    // WP4g: the title strip. A click lands here; so does Enter or Space on it,
    // which is the only way to reach the editor from the keyboard.
    else if (action === 'rename') beginRename(sessionId);
    // WP4f: the `N finished hidden · show` chip. One click, everything back.
    else if (action === 'restore') restoreHidden(sessionId);
    return true;
  };

  host.addEventListener('click', (event) => {
    if (runCardAction(event.target)) event.stopPropagation();
  });

  // Double-click anywhere on a card jumps to its terminal. It is on the card rather than
  // on a button because a double-click has to have somewhere generous to land, and the
  // card's own controls take their clicks before this ever sees them. In a browser it
  // still fires and still answers — with the sentence saying where the feature lives —
  // because a gesture that silently does nothing teaches nobody anything.
  host.addEventListener('dblclick', (event) => {
    if (event.target instanceof Element && event.target.closest('[data-action]') !== null) return;
    // Inside a note, a double-click selects a word. That is the browser doing
    // its job in a text box and nothing here may take it away.
    if (inNote(event.target)) return;
    const sessionId = sessionIdOf(event.target);
    if (sessionId === undefined) {
      // WP4e: empty canvas. A double-click on nothing is the gesture every
      // whiteboard has for "put something here", and here it is a note. It is
      // the same gesture that jumps to a terminal *on a card*, which is not a
      // collision: the two places are disjoint and each does the only thing it
      // could sensibly mean.
      if (isFrozen()) return;
      event.preventDefault();
      const at = canvasPointOf(event.clientX, event.clientY);
      addNoteAt(at.x - NOTE_SIZE.width / 2, at.y - 14);
      return;
    }
    event.preventDefault();
    jumpToTerminal(sessionId);
  });

  // A press anywhere that is not the menu closes it. The canvas has its own
  // handler for that, but the top bar and the tab bar do not.
  document.addEventListener('pointerdown', (event) => {
    const node = event.target;
    if (canvasMenu.isOpen && !(node instanceof Node && canvasMenuRoot.contains(node))) {
      canvasMenu.close();
    }
    // N-WP15a: the same rule for the link menu, which lives on the chrome and
    // so is never closed by the canvas's own handler.
    if (linkMenu.isOpen && !(node instanceof Node && linkMenuRoot.contains(node))) {
      linkMenu.close();
    }
    if (usage.isOpen && node instanceof Node && !usage.contains(node)) usage.set(false, false);
    if (needsYou.isOpen && node instanceof Node && !needsYou.contains(node)) {
      needsYou.set(false, false);
    }
    if (node instanceof Element && node.closest('.nz-note') === null) notesLayer.closeMenus();
    if (cardMenu.openFor === undefined) return;
    if (node instanceof Node && cardMenuRoot.contains(node)) return;
    if (node instanceof Element && node.closest('[data-action="menu"]') !== null) return;
    cardMenu.close();
  });

  host.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (runCardAction(event.target)) {
      event.preventDefault();
      return;
    }
    // Enter on the card itself — not on one of its controls, which `runCardAction` has
    // already claimed — is the keyboard's double-click. Space is left alone: it is the
    // page's scroll key and taking it would be a worse trade than the shortcut is worth.
    if (event.key !== 'Enter') return;
    const focused = event.target;
    if (!(focused instanceof Element) || !focused.classList.contains('nz-session')) return;
    const sessionId = sessionIdOf(focused);
    if (sessionId === undefined) return;
    event.preventDefault();
    jumpToTerminal(sessionId);
  });

  host.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    cardMenu.close();

    const node = event.target;
    // The two buttons take their own clicks; neither pans nor drags.
    if (node instanceof Element && node.closest('[data-action]') !== null) return;
    // Nor does a note: it has its own drag, its own resize and a text box that
    // needs its caret. `notes.ts` claims those presses; this is the other half.
    if (inNote(node)) return;

    /*
     * WP4f: a resize handle, checked before the drag handle it lies on top of.
     *
     * The top edge and the two top corners sit inside the handle's rectangle
     * and the rest sit over the tree, so DOM order alone would not settle which
     * gesture a press means — this does, and `createSession` appends the eight
     * handles last so that what is on top is also what is checked first.
     */
    const handleEl =
      node instanceof Element ? node.closest<SVGRectElement>('[data-resize]') : null;
    if (handleEl !== null && !isFrozen()) {
      const resizeId = sessionIdOf(handleEl);
      const metric = resizeId === undefined ? undefined : drawnMetrics.get(resizeId);
      const session = drawnCards.find((one) => one.id === resizeId);
      const named = handleEl.dataset['resize'] ?? 'se';
      const handle: ResizeHandle = isResizeHandle(named) ? named : 'se';
      if (resizeId !== undefined && metric !== undefined && session !== undefined) {
        const at = layout.positions[resizeId] ?? { x: 0, y: 0 };
        const start = {
          x: at.x,
          y: at.y,
          width: metric.box.width,
          height: metric.box.height,
        };
        cardResize = {
          id: resizeId,
          pointerId: event.pointerId,
          handle,
          pointerX: event.clientX,
          pointerY: event.clientY,
          start,
          bounds: {
            minWidth: cardMinimumFor(session, metric.collapsed, taskText).width,
            maxWidth: MAX_CARD_WIDTH,
            /*
             * The floor on the height is not the same question for the two
             * kinds of handle, and answering it once would break one of them.
             *
             * An **edge** drag leaves the width alone, so the tree does not
             * re-wrap and the height the card is showing *is* the floor: the
             * card stops exactly where its tree is, under the pointer, and
             * grows again the moment the pointer comes back. Give it the
             * absolute floor instead and the gesture gains a dead zone below
             * the tree, where the pointer moves and nothing does.
             *
             * A **corner** drag changes the width, so the tree re-wraps and
             * the height it needs moves while the drag is running. Holding the
             * height it needed at the *press* as a floor would pin the scale
             * at 1 for every card that is exactly as tall as its tree — which
             * is every card nobody has dragged — and a corner that can only
             * grow is not a corner. So a corner takes the absolute floor, and
             * containment is left where it is enforced for every card anyway:
             * `cardSize` draws the card at the taller of its contents and this.
             */
            minHeight: isCornerHandle(handle) ? minCardHeight(CARD) : metric.box.contentHeight,
            maxHeight: MAX_CARD_HEIGHT,
          },
        };
        host.setPointerCapture(event.pointerId);
        renderer.setResizing(resizeId, true);
        setClass(host, 'is-resizing', true);
        card.hide();
        return;
      }
    }

    const grip =
      node instanceof Element ? node.closest<SVGRectElement>('[data-drag="card"]') : null;
    const sessionId = grip === null ? undefined : sessionIdOf(grip);
    if (sessionId !== undefined && !isFrozen()) {
      const at = layout.positions[sessionId] ?? { x: 0, y: 0 };
      cardDrag = {
        id: sessionId,
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        originX: at.x,
        originY: at.y,
      };
      cardDragTarget = { x: at.x, y: at.y };
      host.setPointerCapture(event.pointerId);
      renderer.setMoving(sessionId, true);
      setClass(host, 'is-moving', true);
      card.hide();
      return;
    }

    panning = true;
    host.setPointerCapture(event.pointerId);
    panOrigin = { x: event.clientX, y: event.clientY, viewX: view.x, viewY: view.y };
    setClass(host, 'is-dragging', true);
    card.hide();
  });

  host.addEventListener('pointermove', (event) => {
    if (cardResize !== undefined) {
      /*
       * All eight handles run through one function, and which axes move is that
       * function's business rather than this one's: an edge moves one, a corner
       * scales both on the ratio the card had at the press.
       *
       * Which axes are *written* is this one's business, and it is not the same
       * question. Dragging the east edge must not pin the height, or a card
       * whose tree later unwraps into fewer rows would sit there holding the
       * empty rows it no longer needs. So a handle only stores the axis it
       * actually dragged, and a card resized sideways goes on sizing its own
       * height exactly as it did before N-WP10.
       */
      const drag = cardResize;
      const dx = (event.clientX - drag.pointerX) / view.scale;
      const dy = (event.clientY - drag.pointerY) / view.scale;
      const box = resizeCard(drag.handle, drag.start, dx, dy, drag.bounds);
      if (changesWidth(drag.handle)) layout = withWidth(layout, drag.id, box.width);
      if (changesHeight(drag.handle)) layout = withHeight(layout, drag.id, box.height);
      // Pulling west or north holds the *opposite* edge still, which means the
      // card's own position moves by whatever the size gained.
      if (box.x !== drag.start.x || box.y !== drag.start.y) {
        layout = withPosition(layout, drag.id, { x: box.x, y: box.y });
      }
      // A re-layout, not a transform: the tree wraps to the new budget, so this
      // is the one gesture on the canvas that cannot be answered by moving a
      // group. `schedule` coalesces it to one draw per frame.
      schedule();
      return;
    }
    if (cardDrag !== undefined) {
      // Whole pixels. A drag at 0.4x zoom would otherwise store a position with
      // eleven decimal places, which is noise in the file and on the canvas.
      cardDragTarget = {
        x: Math.round(cardDrag.originX + (event.clientX - cardDrag.x) / view.scale),
        y: Math.round(cardDrag.originY + (event.clientY - cardDrag.y) / view.scale),
      };
      renderer.moveCard(cardDrag.id, cardDragTarget.x, cardDragTarget.y);
      // Dropping a card on a tab title files it there. Highlighting the tab
      // under the pointer is the only thing that makes that discoverable.
      tabBar.highlight(tabBar.tabAt(event.clientX, event.clientY));
      return;
    }
    if (!panning) return;
    view = {
      x: panOrigin.viewX + (event.clientX - panOrigin.x),
      y: panOrigin.viewY + (event.clientY - panOrigin.y),
      scale: view.scale,
    };
    applyView();
  });

  const endDrag = (event: PointerEvent): void => {
    if (cardResize !== undefined) {
      const drag = cardResize;
      cardResize = undefined;
      renderer.setResizing(drag.id, false);
      setClass(host, 'is-resizing', false);
      if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
      // Written once, at the end. `pointermove` keeps the width in memory so a
      // drag across a card is one storage write rather than sixty.
      saveLayout();
      schedule();
      return;
    }
    if (cardDrag !== undefined) {
      const drag = cardDrag;
      cardDrag = undefined;
      const onTab = tabBar.tabAt(event.clientX, event.clientY);
      tabBar.highlight(undefined);
      renderer.setMoving(drag.id, false);
      setClass(host, 'is-moving', false);
      if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);

      if (onTab !== undefined) {
        // Filed onto a tab: the card leaves this view, so it keeps the place it
        // already had rather than the one it was dropped on, which is in the
        // tab bar and not on the canvas at all.
        tabs = moveSession(tabs, drag.id, onTab);
        saveTabs();
      } else {
        layout = withPosition(layout, drag.id, cardDragTarget);
      }
      saveLayout();
      schedule();
      return;
    }
    if (!panning) return;
    panning = false;
    setClass(host, 'is-dragging', false);
    if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
  };
  host.addEventListener('pointerup', endDrag);
  host.addEventListener('pointercancel', endDrag);

  host.addEventListener(
    'wheel',
    (event) => {
      // A wheel over a note scrolls the note. Zooming the canvas out from under
      // somebody who is reading their own paragraph is not what the gesture
      // means there, and a note taller than its box has no other way to scroll.
      if (inNote(event.target)) return;
      event.preventDefault();
      const rect = host.getBoundingClientRect();
      view = zoomAt(
        view,
        Math.exp(-event.deltaY * 0.0015),
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
      applyView();
    },
    { passive: false },
  );

  window.addEventListener('resize', schedule);
  // A note being typed into when the tab goes away keeps its last keystrokes:
  // the debounce that makes editing cheap must not be able to eat them.
  window.addEventListener('pagehide', () => notesLayer.flush());

  /* ---- history ---------------------------------------------------- */

  /**
   * Leaving the frozen tree is one action, and it is reachable three ways: the
   * button on the frozen bar, the drawer's own "back to live", and Escape.
   */
  const backToLive = (): void => {
    if (!isFrozen()) return;
    frozenState = undefined;
    frozenBar.hidden = true;
    document.documentElement.removeAttribute('data-frozen');
    // The two canvases have different node ids, so the diffing renderer would
    // otherwise leave the frozen session's nodes behind.
    renderer.reset();
    fitted = false;
    schedule();
  };

  const showFrozen = (history: History): void => {
    frozenState = historySnapshot(history);
    document.documentElement.setAttribute('data-frozen', 'true');
    frozenBar.hidden = false;
    setText(
      frozenText,
      t('frozen.bar', {
        project: history.project,
        session: shortSessionId(history.sessionId),
        duration: formatDuration(history.durationMs),
        agents: formatCount(history.agentCount),
        ended: formatStamp(history.lastWriteAt),
      }),
    );
    renderer.reset();
    fitted = false;
    card.hide();
    schedule();
  };

  // One instance, so the demo source remembers which rows have been opened and
  // the listing hydrates exactly as the real one does.
  const transport: HistoryTransport = demo
    ? makeDemoHistory()
    // N-WP15a: a getter rather than a value, so a session opened after the
    // switch moved is fetched the way the live canvas is drawing.
    : httpTransport(() => taskText);

  const panel = new HistoryPanel({
    root: historyRoot,
    transport,
    onSelect: showFrozen,
    // WP4g: the drawer and the tab bar use the same word for the same folder.
    projectNameFor: projectNameForSlug,
    onClose: () => {
      historyButton.setAttribute('aria-expanded', 'false');
      if (window.location.hash === '#history') {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
      backToLive();
    },
  });

  const openPanel = (): void => {
    panel.open(historyButton);
    historyButton.setAttribute('aria-expanded', 'true');
  };

  const toggleHistory = (): void => {
    if (panel.isOpen) {
      panel.close();
      return;
    }
    openPanel();
    if (window.location.hash !== '#history') window.location.hash = 'history';
  };

  historyButton.addEventListener('click', toggleHistory);
  frozenBack.addEventListener('click', () => panel.close());

  const syncHash = (): void => {
    if (window.location.hash === '#history') {
      if (!panel.isOpen) openPanel();
    } else if (panel.isOpen) {
      panel.close();
    }
  };
  window.addEventListener('hashchange', syncHash);

  /**
   * Forget the sessions the machine no longer has.
   *
   * "No longer has" means neither running nor openable from history, which on a
   * default install is Claude Code's own retention (`cleanupPeriodDays`, 30
   * days). A session that ended this morning keeps its tab and its place; one
   * whose transcript has expired takes its entries with it instead of leaving
   * them to pile up for the life of the browser profile.
   *
   * N-WP20: **the whole store, or nothing.** This used to be decided from the
   * first page of the listing — 200 rows — so on a machine with more than 200
   * transcripts every session past the 200th counted as "no longer has", and
   * its card position, its size, its tab membership and the name typed on it
   * were deleted while the session itself sat openable in the drawer two clicks
   * away. The decision now comes from `/api/history/ids`, which is unpaged, and
   * it is not made at all if that request fails: `prune` is never called,
   * `pruned` stays false, and the next frame tries again. Forgetting nothing is
   * always recoverable; forgetting the wrong thing is not.
   */
  let pruned = false;
  const prune = (historyIds: readonly string[]): void => {
    if (pruned) return;
    pruned = true;
    const known = new Set([...state.sessions.map((session) => session.id), ...historyIds]);
    if (known.size === 0) return;
    layout = pruneLayout(layout, known);
    tabs = pruneTabs(tabs, known);
    // WP4g: a card's name goes when the session it named is gone from both the
    // canvas and the transcript store — the same rule as its tab membership, so
    // the two can never disagree about which sessions still exist.
    names = pruneNames(names, known);
    saveLayout();
    saveTabs();
    saveNames();
  };

  /*
   * N-WP13: the language picker, and what changing a language costs.
   *
   * **No reload.** The catalogues are already in the bundle and every visible
   * string is read out of them at the moment it is written, so switching is a
   * matter of writing them all again. Three kinds of string need three
   * different pushes:
   *
   * - the ones in `index.html`, rewritten by `applyStatic` from their
   *   `data-nz-*` attributes;
   * - the ones a component wrote in its constructor and would never write
   *   again — the hover card's row names, the history header, the five colour
   *   labels, the usage explanation — which is what `retranslate()` is for;
   * - the ones drawn every frame, which need nothing but a frame. Two views
   *   cache their elements rather than rebuilding them, so those caches are
   *   dropped: `renderer.reset()` and `notesLayer.reset()` are the same calls
   *   the live/frozen swap already makes, and the next frame rebuilds both.
   *
   * The picker itself is buttons and not a `<select>`, and it lists the six
   * languages and nothing else: see `web/lang.ts`.
   */
  const paintLanguage = fillLanguagePicker(languageRoot, (locale) => {
    localeChoice = locale;
    writeLocaleChoice(localeStorage, locale);
    paintLanguage(localeChoice);
    // Clicking the language already on screen is a no-op worth having: it turns
    // the machine's guess into a choice that survives a change of machine.
    if (!setLocale(locale)) return;
    relanguage();
  });
  paintLanguage(localeChoice);

  /** Write every string on the page again, in the language now in force. */
  function relanguage(): void {
    applyStatic();
    paintTheme(theme);
    paintLanguage(localeChoice);
    card.retranslate();
    colours.retranslate();
    colours.refresh();
    usage.retranslate();
    needsYou.retranslate();
    panel.retranslate();
    // Both keep an element per thing they draw; dropping the cache is how the
    // words inside them are rebuilt, and the next frame does the rebuilding.
    renderer.reset();
    notesLayer.reset();
    paintSwitch(demoButton, demo);
    projects.render(projectViews(), tabs.autoProjects);
    sessionList.render(sessionRows());
    schedule();
  }

  window.addEventListener('keydown', (event) => {
    const target = event.target;
    // Typing a tab name must not arrange the canvas.
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;

    const action = shortcutFor(event);
    if (action === undefined) return;

    if (action.kind === 'close') {
      // N-WP14: a note menu is a menu like the other two, so Escape closes it
      // first and closes nothing else. Escape *inside* the panel never reaches
      // here — `web/notes.ts` catches it there, as the card menu does — so this
      // is the case where the menu is open and the keyboard is elsewhere.
      if (notesLayer.openMenuFor !== undefined) {
        notesLayer.closeMenus();
        return;
      }
      // N-WP15a: and the link menu, which is the fourth menu on this page and
      // keeps the same contract as the other three.
      if (linkMenu.isOpen) {
        linkMenu.close();
        return;
      }
      if (canvasMenu.isOpen) {
        canvasMenu.close();
        return;
      }
      if (cardMenu.openFor !== undefined) {
        cardMenu.close();
        return;
      }
      if (usage.isOpen) {
        usage.set(false, true);
        return;
      }
      // N-WP21: the fifth thing Escape can close, and it takes its turn in the
      // same order — a popover before a drawer, a drawer before the sidebar.
      if (needsYou.isOpen) {
        needsYou.set(false, true);
        return;
      }
      if (panel.isOpen) {
        panel.close();
        return;
      }
      if (settings.isOpen) {
        settings.set(false, true);
        return;
      }
      if (sidebar.isOpen) sidebar.set(false, true);
      return;
    }

    // The history drawer is a list with its own keys; only Escape reaches past it.
    if (target instanceof Node && historyRoot.contains(target)) return;

    switch (action.kind) {
      case 'tab': {
        const tab = tabs.tabs[action.index];
        if (tab === undefined) return;
        event.preventDefault();
        tabs = setActiveTab(tabs, tab.id);
        saveTabs();
        fitted = false;
        schedule();
        return;
      }
      case 'fit':
        fit();
        return;
      case 'arrange':
        arrange();
        return;
      case 'history':
        toggleHistory();
        return;
      case 'sidebar':
        sidebar.set(!sidebar.isOpen, true);
        return;
      case 'zoom-in':
        view = zoomAt(view, 1.2, host.clientWidth / 2, host.clientHeight / 2);
        applyView();
        return;
      case 'zoom-out':
        view = zoomAt(view, 1 / 1.2, host.clientWidth / 2, host.clientHeight / 2);
        applyView();
        return;
    }
  });

  /* ---- data ------------------------------------------------------- */

  /**
   * N-WP20: when the last frame arrived, so a disconnected canvas can say how
   * old what it is showing is.
   *
   * The canvas deliberately keeps the last snapshot on screen when the stream
   * drops — blanking it would throw away the only thing left that is true — but
   * that makes a stale reading indistinguishable from a live one, which is the
   * whole class of bug this package is about. `0` means no frame has ever
   * arrived, and the age is then not written at all rather than shown as a
   * lifetime measured from the epoch.
   */
  let lastStateAt = 0;

  let connection: 'live' | 'connecting' | 'lost' | 'demo' = 'connecting';

  const setConnection = (status: 'live' | 'connecting' | 'lost' | 'demo'): void => {
    connection = status;
    conn.dataset['status'] = status;
    // N-WP20. Disconnected is the one state with something more to say: the
    // last data is still on screen and the only honest label for it is its age.
    // Re-read on every frame — the 1 s tick calls this — so the number moves.
    if (status === 'lost' && lastStateAt > 0) {
      setText(conn, t('bar.disconnectedAge', { age: formatAge(Date.now() - lastStateAt) }));
      return;
    }
    setText(
      conn,
      t(
        status === 'live'
          ? 'bar.live'
          : status === 'demo'
            ? 'bar.demo'
            : status === 'connecting'
              ? 'bar.connecting'
              : 'bar.disconnected',
      ),
    );
  };

  if (demo) {
    // `sessions` is passed only when the URL asked for a count, so the demo
    // canvas is whatever `makeDemoState` says it is. It used to be pinned at
    // three here, which quietly hid the fourth fixture the moment one was
    // added — and the fourth is the *idle* session WP4d exists to show.
    // `?quota=limits` pretends nazar-tray is installed, `?quota=captures` that
    // only the status-line wrapper is. Anything else — including no `quota` at
    // all — is a machine with neither, which is what every screenshot taken
    // before WP5 was taken on and still reproduces exactly.
    const quotaParam = params.get('quota');
    const demoQuota =
      quotaParam === 'limits' || quotaParam === '1'
        ? 'limits'
        : quotaParam === 'captures'
          ? 'captures'
          : undefined;
    state = makeDemoState({
      ...(params.has('sessions') ? { sessions: intParam(params, 'sessions', 0) } : {}),
      agentsPerSession: intParam(params, 'agents', 0),
      ...(demoQuota === undefined ? {} : { quota: demoQuota }),
    });
    setConnection('demo');
    // Two switches the screenshots need, so a shot of a folded card or an open
    // sidebar is a URL rather than a script of clicks.
    if (params.get('sidebar') === '1') sidebar.set(true, false);
    const fold = intParam(params, 'collapse', 0);
    for (const session of state.sessions.slice(0, fold)) {
      layout = withCollapsed(layout, session.id, true);
    }
    // `?demo=1&notes=1` puts three notes on the canvas — one per colour that has
    // something to say — so the WP4e screenshot is a URL rather than a sequence
    // of clicks, and so the shot always shows the same words. They go to the
    // demo's own in-memory storage and never to a real browser's.
    if (params.get('notes') === '1') {
      for (const seed of DEMO_NOTES) {
        const made = addNote(notes, { tab: tabs.active, x: seed.x, y: seed.y, text: seed.text });
        notes = updateNote(made.state, made.id, { colour: seed.colour });
      }
    }
    /*
     * WP4g: `?demo=1&projects=1` — two projects and two named cards.
     *
     * The demo's four sessions live in `C:/proj/nazar`, `C:/proj/nazar-tray`,
     * `C:/proj/dile` and `C:/proj/atlas`, which is exactly the shape the rule
     * has to get right: `nazar-tray` is a *sibling* of `nazar` and must not be
     * claimed by it. Two projects and one manual pin make that visible in a
     * still frame, and the names show a card titled by its user rather than by
     * its folder. All of it goes to the demo's own in-memory storage.
     */
    if (params.get('projects') === '1') {
      for (const root of DEMO_PROJECT_ROOTS) {
        tabs = createProjectTab(tabs, root).state;
      }
      const [first, second] = state.sessions;
      if (first !== undefined) names = withName(names, first.id, DEMO_CARD_NAMES[0]);
      if (second !== undefined) names = withName(names, second.id, DEMO_CARD_NAMES[1]);
      // The past column says `—` until the transcript store has been read once,
      // which is right on a real machine and useless in a screenshot. The demo
      // reads it here, so the shot is a URL and not a URL plus a click.
      void panel.refresh().then(() => projects.render(projectViews(), tabs.autoProjects));
    }
    schedule();
    syncHash();
    // `?demo=1&history=1` opens the panel on a chosen session, which is how the
    // WP4b screenshot is taken: no live session needed, and the same frame
    // every run.
    if (params.get('history') === '1') {
      openPanel();
      const wanted = params.get('session') ?? DEMO_HISTORY_IDS[0];
      if (wanted !== undefined) {
        void transport.open(wanted).then((history) => {
          if (history !== undefined) showFrozen(history);
          void panel.refresh();
        });
      }
    }
    if (bench) {
      // A hidden tab does not run `requestAnimationFrame`, so starting the
      // measurement in one produces a single enormous frame and a number that
      // means nothing. Wait until the page is actually on screen.
      const startBench = (): void => {
        window.setTimeout(() => {
          runBench(host, (next) => {
            view = next;
            applyView();
          });
        }, 300);
      };
      if (document.visibilityState === 'visible') startBench();
      else document.addEventListener('visibilitychange', startBench, { once: true });
    }
    return;
  }

  syncHash();
  setConnection('connecting');
  let everConnected = false;
  /*
   * N-WP15a: the stream carries the setting in its URL.
   *
   * `?task=1` only when this browser asked for it. A server started with
   * `--no-task-text` ignores the parameter and answers without the field, which
   * is the precedence that matters: the machine's owner outranks the page.
   */
  let source = new EventSource(withTaskQuery('/api/events', taskText));
  /*
   * N-WP16: which sessions were waiting for the user on the previous frame.
   *
   * `undefined` until the first frame lands, and that is the whole of the guard
   * against a burst on open: a canvas that opens onto three sessions already
   * waiting has watched none of them *start* waiting, so the first frame seeds
   * this and rings for nothing. It survives a reconnect on purpose — a session
   * that started waiting while the socket was down is a transition the user has
   * genuinely not seen yet.
   */
  let waitingBefore: ReadonlySet<string> | undefined;
  const listen = (channel: EventSource): void => {
    channel.addEventListener('state', (event) => {
      try {
        state = JSON.parse((event as MessageEvent<string>).data) as StateSnapshot;
      } catch {
        return;
      }
      const waitingNow = waitingIds(state.sessions);
      if (waitingBefore !== undefined) {
        for (const id of newlyWaiting(waitingBefore, waitingNow)) {
          sounds.handle({ kind: 'waiting', sessionId: id });
        }
      }
      waitingBefore = waitingNow;
      everConnected = true;
      // N-WP20: stamped from the browser's clock, not the snapshot's. The age
      // shown is "how long since this page last heard anything", which is what
      // a reader of a stale canvas is actually asking.
      lastStateAt = Date.now();
      setConnection('live');
      schedule();
      // One sweep, once, and only to decide what to forget. It opens no
      // transcript: the scanner answers this from `readdir` and `stat` alone.
      // N-WP20: ids rather than a page of the listing, and a failure prunes
      // nothing at all — `pruned` stays false so the next frame retries.
      if (!pruned) {
        void transport.ids().then(prune, () => undefined);
      }
    });
    /*
     * N-WP16: the one frame on this stream that is not a whole state.
     *
     * The server sends it when the *registry* drops a session — the session-level
     * `session-gone`, the same signal `agent-done.ts` uses for a subagent — and
     * sends it once, to whoever is connected at the time. A subagent finishing
     * sends nothing: a busy session finishes dozens a minute.
     *
     * A frame this cannot read is dropped rather than guessed at. There is
     * nothing to recover: the next one is a whole snapshot.
     */
    channel.addEventListener('session-ended', (event) => {
      let ended: { id?: unknown };
      try {
        ended = JSON.parse((event as MessageEvent<string>).data) as { id?: unknown };
      } catch {
        return;
      }
      if (typeof ended.id === 'string') sounds.handle({ kind: 'ended', sessionId: ended.id });
    });
    channel.addEventListener('open', () => {
      everConnected = true;
      setConnection('live');
    });
    channel.addEventListener('error', () => {
      // EventSource retries on its own and leaves `readyState` at CONNECTING
      // while it does, so that flag cannot tell "starting up" from "dropped".
      // Having once been live is what makes this a disconnection, and the canvas
      // keeps the last snapshot on screen rather than blanking itself.
      setConnection(everConnected ? 'lost' : 'connecting');
    });
  };
  listen(source);

  /*
   * N-WP15a. Closing and re-opening rather than asking the old stream to change
   * its mind: the server decided this connection's shape when it accepted it,
   * and a second connection left open would go on pushing frames of the old
   * shape underneath the new one.
   *
   * `everConnected` is deliberately not reset. This is not a dropped socket and
   * the canvas must not flash *disconnected* because somebody moved a switch.
   */
  restartStream = (): void => {
    source.close();
    source = new EventSource(withTaskQuery('/api/events', taskText));
    listen(source);
  };

  // Elapsed times and write ages keep moving between snapshots. N-WP20: so does
  // the age of the last frame, and it moves fastest exactly when nothing else
  // on the canvas is moving at all.
  window.setInterval(() => {
    schedule();
    if (connection === 'lost') setConnection('lost');
  }, 1000);
}

/* ------------------------------------------------------------------ *
 * Frame-rate check
 * ------------------------------------------------------------------ */

/**
 * Drive a pan and a zoom for three seconds and report the frame times, so
 * "3 sessions x 6 agents render without jank" is answered with numbers rather
 * than with an impression.
 */
function runBench(host: HTMLElement, write: (view: Viewport) => void): void {
  const frames: number[] = [];
  const started = performance.now();
  let previous = started;

  const step = (time: number): void => {
    frames.push(time - previous);
    previous = time;
    const t = (time - started) / 1000;
    write({
      x: 40 + Math.sin(t * 1.7) * 240,
      y: 30 + Math.cos(t * 1.3) * 130,
      scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, 0.9 + Math.sin(t * 2) * 0.35)),
    });
    if (time - started < 3000) window.requestAnimationFrame(step);
    else report(frames, host);
  };
  window.requestAnimationFrame(step);
}

function report(frames: readonly number[], host: HTMLElement): void {
  const measured = [...frames.slice(2)].sort((a, b) => a - b);
  if (measured.length === 0) return;
  const at = (q: number): number =>
    measured[Math.min(measured.length - 1, Math.floor(measured.length * q))] ?? 0;
  const summary = [
    `frames=${measured.length}`,
    `median=${at(0.5).toFixed(2)}ms`,
    `p95=${at(0.95).toFixed(2)}ms`,
    `max=${(measured[measured.length - 1] ?? 0).toFixed(2)}ms`,
    `over17ms=${measured.filter((ms) => ms > 17).length}`,
    `fps=${(1000 / Math.max(0.001, at(0.5))).toFixed(1)}`,
  ].join(' ');

  const out = html('div', 'nz-bench');
  out.id = 'bench-result';
  setText(out, summary);
  host.append(out);
  document.title = `nazar bench ${summary}`;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
