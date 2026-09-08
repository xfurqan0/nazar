/**
 * What the browser remembers about the canvas: where each card sits, which
 * trees are folded away, and which tab a session belongs to.
 *
 * **This is browser storage and nothing else.** Nazar writes nothing to disk —
 * a static gate (`test/no-writes.test.ts`) fails the build if any shipped
 * source so much as imports a filesystem call that could write — so the answer
 * to "remember where I dragged that card" is `localStorage` on the page's own
 * origin, which is `http://127.0.0.1:<port>` and therefore as local as the rest
 * of the tool. Clearing site data resets the canvas and loses nothing else.
 *
 * Everything here is pure over a `StorageLike`, which is one interface with
 * three methods. Tests hand it a `Map`; the page hands it `localStorage`. That
 * is the whole reason a round-trip can be tested in Node with no jsdom.
 */

import {
  cleanPath,
  deepestMatch,
  folderName,
  folderTabName,
  isWindowsPath,
  pathKey,
} from './projects.js';

/** The three methods of `localStorage` that this file uses. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** A `StorageLike` backed by a `Map`, for tests and for a blocked browser. */
export function memoryStorage(seed?: Readonly<Record<string, string>>): StorageLike {
  const map = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

/**
 * A storage that never throws.
 *
 * `localStorage` throws on access in a private window with site data blocked,
 * and `setItem` throws when the origin's quota is full. Neither is a reason for
 * a monitoring canvas to stop drawing, so a failure downgrades to memory and
 * the only thing lost is that the arrangement does not survive a reload.
 */
export function guarded(storage: StorageLike | undefined): StorageLike {
  const fallback = memoryStorage();
  if (storage === undefined) return fallback;
  return {
    getItem: (key) => {
      try {
        return storage.getItem(key);
      } catch {
        return fallback.getItem(key);
      }
    },
    setItem: (key, value) => {
      try {
        storage.setItem(key, value);
      } catch {
        fallback.setItem(key, value);
      }
    },
    removeItem: (key) => {
      try {
        storage.removeItem(key);
      } catch {
        fallback.removeItem(key);
      }
    },
  };
}

function readJson(storage: StorageLike, key: string): unknown {
  const raw = storage.getItem(key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // A half-written or hand-edited value is not worth a broken canvas.
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : [];
}

/* ------------------------------------------------------------------ *
 * Card positions and folded trees
 * ------------------------------------------------------------------ */

export const LAYOUT_KEY = 'nazar.layout.v1';

export interface LayoutState {
  /** Canvas coordinates of each card's top-left corner, by session id. */
  readonly positions: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  /**
   * WP4f: a width the user dragged a card to, by session id.
   *
   * The width is the tree's wrapping budget, so this is the number that decides
   * the card's shape. A session absent from here sizes itself, which is the
   * state every card starts in and the one *Reset size* returns it to.
   */
  readonly widths: Readonly<Record<string, number>>;
  /**
   * N-WP10: a height the user dragged a card to, by session id.
   *
   * Separate from {@link widths} and not a box, because the two are set
   * separately: dragging the east edge must not pin the height, or a card whose
   * tree later unwraps into fewer rows would keep the empty rows it no longer
   * needs. Only the top edge, the bottom edge and the four corners write here.
   *
   * A floor and never a ceiling. The card is drawn at the taller of this and
   * what its tree needs, so a session whose subagents multiply still grows —
   * the dragged height only stops it from *shrinking* back.
   */
  readonly heights: Readonly<Record<string, number>>;
  /** Sessions whose subagent tree is folded to a summary. */
  readonly collapsed: readonly string[];
  /**
   * WP4f: finished subagents the user has cleared away, by session id.
   *
   * Ids rather than a count or a cut-off timestamp, so what is hidden cannot
   * drift as more agents finish: clearing hides the agents that were done at
   * **that moment** and nothing else. Nothing is deleted either — the state
   * still holds every one of them and the canvas simply stops drawing these —
   * and the history view never reads this key at all.
   */
  readonly cleared: Readonly<Record<string, readonly string[]>>;
  /** Whether the sidebar is open. Remembered because it is a mode, not a click. */
  readonly sidebar: boolean;
}

export const EMPTY_LAYOUT: LayoutState = {
  positions: {},
  widths: {},
  heights: {},
  collapsed: [],
  cleared: {},
  sidebar: false,
};

/**
 * A `{ id: pixels }` map read out of storage, dropping everything that is not
 * a size.
 *
 * A size is a positive finite number or it is nothing. A hand-edited `0`, a
 * `null` or a string is dropped rather than clamped, which leaves that card
 * sizing itself — exactly where it would be had the key never been written.
 */
function sizeRecord(raw: unknown): Record<string, number> {
  const sizes: Record<string, number> = {};
  if (!isRecord(raw)) return sizes;
  for (const [id, value] of Object.entries(raw)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
    sizes[id] = Math.round(value);
  }
  return sizes;
}

export function readLayout(storage: StorageLike): LayoutState {
  const raw = readJson(storage, LAYOUT_KEY);
  if (!isRecord(raw)) return EMPTY_LAYOUT;

  const positions: Record<string, { x: number; y: number }> = {};
  if (isRecord(raw['positions'])) {
    for (const [id, value] of Object.entries(raw['positions'])) {
      if (!isRecord(value)) continue;
      const x = value['x'];
      const y = value['y'];
      if (typeof x !== 'number' || typeof y !== 'number') continue;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      positions[id] = { x, y };
    }
  }

  // A width is a positive finite number or it is nothing. A hand-edited `0`, a
  // `null` or a string is dropped rather than clamped, which leaves the card
  // sizing itself — exactly where it would be had the key never been written.
  const widths = sizeRecord(raw['widths']);
  // N-WP10. Read the same way, and absent in every record written before it —
  // which is the whole of the migration: a pre-N-WP10 `nazar.layout.v1` has no
  // `heights` key, reads as `{}`, and every card in it goes on sizing its own
  // height exactly as it did.
  const heights = sizeRecord(raw['heights']);

  const cleared: Record<string, readonly string[]> = {};
  if (isRecord(raw['cleared'])) {
    for (const [id, value] of Object.entries(raw['cleared'])) {
      const ids = stringList(value);
      if (ids.length > 0) cleared[id] = ids;
    }
  }

  return {
    positions,
    widths,
    heights,
    collapsed: stringList(raw['collapsed']),
    cleared,
    sidebar: raw['sidebar'] === true,
  };
}

export function writeLayout(storage: StorageLike, state: LayoutState): void {
  storage.setItem(LAYOUT_KEY, JSON.stringify({ v: 1, ...state }));
}

export function withPosition(
  state: LayoutState,
  id: string,
  position: { readonly x: number; readonly y: number },
): LayoutState {
  return { ...state, positions: { ...state.positions, [id]: { x: position.x, y: position.y } } };
}

/** Remember a dragged width, or forget it again — `undefined` resets the card. */
export function withWidth(state: LayoutState, id: string, width: number | undefined): LayoutState {
  const widths = { ...state.widths };
  if (width === undefined || !Number.isFinite(width) || width <= 0) delete widths[id];
  else widths[id] = Math.round(width);
  return { ...state, widths };
}

export function widthOf(state: LayoutState, id: string): number | undefined {
  return state.widths[id];
}

/** N-WP10: remember a dragged height, or forget it — `undefined` resets it. */
export function withHeight(state: LayoutState, id: string, height: number | undefined): LayoutState {
  const heights = { ...state.heights };
  if (height === undefined || !Number.isFinite(height) || height <= 0) delete heights[id];
  else heights[id] = Math.round(height);
  return { ...state, heights };
}

export function heightOf(state: LayoutState, id: string): number | undefined {
  return state.heights[id];
}

/** Give one card its automatic size back, on both axes. */
export function withAutoSize(state: LayoutState, id: string): LayoutState {
  return withHeight(withWidth(state, id, undefined), id, undefined);
}

/** Whether the user has set either of one card's two sizes. */
export function isSized(state: LayoutState, id: string): boolean {
  return state.widths[id] !== undefined || state.heights[id] !== undefined;
}

export function withCollapsed(state: LayoutState, id: string, collapsed: boolean): LayoutState {
  const without = state.collapsed.filter((one) => one !== id);
  return { ...state, collapsed: collapsed ? [...without, id] : without };
}

export function isCollapsed(state: LayoutState, id: string): boolean {
  return state.collapsed.includes(id);
}

/**
 * Hide a set of finished subagents on one card.
 *
 * The union, not a replacement: clearing twice in a row hides what was finished
 * on the first click *and* what has finished since, which is what a person who
 * clicks it twice means. {@link withRestored} is the only way back, and it is
 * one click on the card.
 */
export function withCleared(
  state: LayoutState,
  id: string,
  agentIds: readonly string[],
): LayoutState {
  const merged = new Set([...(state.cleared[id] ?? []), ...agentIds]);
  if (merged.size === 0) return state;
  return { ...state, cleared: { ...state.cleared, [id]: [...merged] } };
}

/** Bring every cleared subagent on one card back. */
export function withRestored(state: LayoutState, id: string): LayoutState {
  if (state.cleared[id] === undefined) return state;
  const cleared = { ...state.cleared };
  delete cleared[id];
  return { ...state, cleared };
}

export function clearedFor(state: LayoutState, id: string): ReadonlySet<string> {
  return new Set(state.cleared[id] ?? []);
}

/** Forget every session the machine no longer knows about. */
export function pruneLayout(state: LayoutState, known: ReadonlySet<string>): LayoutState {
  const positions: Record<string, { x: number; y: number }> = {};
  for (const [id, position] of Object.entries(state.positions)) {
    if (known.has(id)) positions[id] = position;
  }
  const widths: Record<string, number> = {};
  for (const [id, width] of Object.entries(state.widths)) {
    if (known.has(id)) widths[id] = width;
  }
  const heights: Record<string, number> = {};
  for (const [id, height] of Object.entries(state.heights)) {
    if (known.has(id)) heights[id] = height;
  }
  const cleared: Record<string, readonly string[]> = {};
  for (const [id, ids] of Object.entries(state.cleared)) {
    if (known.has(id)) cleared[id] = ids;
  }
  return {
    ...state,
    positions,
    widths,
    heights,
    cleared,
    collapsed: state.collapsed.filter((id) => known.has(id)),
  };
}

/* ------------------------------------------------------------------ *
 * Tabs
 * ------------------------------------------------------------------ */

export const TABS_KEY = 'nazar.tabs.v1';

/** The tab that always exists, cannot be renamed or deleted, and shows all. */
export const ALL_TAB = 'all';

/**
 * WP4g. Two kinds of tab, and the difference is who decides what is on them.
 *
 * A `manual` tab is a shelf you file things onto by hand — the WP4c tab, and
 * still the default. A `project` tab is a **rule**: it owns a folder, and every
 * session whose working directory is inside that folder is on it, live and in
 * history, without anybody filing anything. Nothing about a project touches the
 * disk; see `./projects.ts` for what is compared and why that is safe.
 */
export type TabKind = 'manual' | 'project';

export interface TabDef {
  readonly id: string;
  readonly name: string;
  readonly kind: TabKind;
  /** The folder this tab owns. Present exactly when `kind` is `project`. */
  readonly root?: string;
}

/**
 * Where one session sits, and whether the user put it there.
 *
 * `pinned` is the whole of "a manual move wins over the project rule": dragging
 * a card onto a tab records it, and from then on the project that would have
 * claimed the session does not. *Follow project* deletes the record rather than
 * clearing the flag, because a session with no record of its own is exactly
 * what "let the rule decide" means, and two ways to spell one state is one too
 * many.
 */
export interface Membership {
  readonly tab: string;
  readonly pinned: boolean;
}

/** The half of a session this file needs: which one, and where it is running. */
export interface SessionPlace {
  readonly id: string;
  readonly cwd?: string;
}

export interface TabsState {
  /** `all` first, then the user's own, in creation order. */
  readonly tabs: readonly TabDef[];
  /** Session id to membership. A session absent from here follows the rules. */
  readonly assign: Readonly<Record<string, Membership>>;
  readonly active: string;
  /**
   * WP4g: make a project of every folder a session appears in. Off by default,
   * and deliberately so — it is a tab bar that grows by itself, which is
   * pleasant on a machine with four repositories and unusable on one with
   * forty. The sidebar offers it; nothing turns it on for you.
   */
  readonly autoProjects: boolean;
}

export const EMPTY_TABS: TabsState = {
  tabs: [{ id: ALL_TAB, name: 'All', kind: 'manual' }],
  assign: {},
  active: ALL_TAB,
  autoProjects: false,
};

const MAX_TAB_NAME = 40;

/** Trim a name to something that fits a tab and is not empty. */
export function cleanTabName(name: string, fallback = 'Tab'): string {
  const trimmed = name.replace(/\s+/g, ' ').trim().slice(0, MAX_TAB_NAME);
  return trimmed.length === 0 ? fallback : trimmed;
}

/**
 * Read the tab bar, including anything a version before WP4g wrote.
 *
 * The key keeps its name. `nazar.tabs.v1` held `{id, name}` tabs and an
 * `assign` of plain strings; both are read here and lifted into the new shape,
 * because a stored arrangement is somebody's afternoon and a schema change is
 * no reason to throw it away. Two migration decisions:
 *
 * - a tab with no `kind` is `manual`, which is what every tab was;
 * - an old assignment becomes **pinned**. It was a manual move when it was
 *   made, so it has to keep beating a project rule that did not exist yet;
 *   demoting it would silently move somebody's cards the first time they
 *   created a project.
 */
export function readTabs(storage: StorageLike): TabsState {
  const raw = readJson(storage, TABS_KEY);
  if (!isRecord(raw)) return EMPTY_TABS;

  const tabs: TabDef[] = [{ id: ALL_TAB, name: 'All', kind: 'manual' }];
  const seen = new Set<string>([ALL_TAB]);
  if (Array.isArray(raw['tabs'])) {
    for (const value of raw['tabs']) {
      if (!isRecord(value)) continue;
      const id = value['id'];
      const name = value['name'];
      if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
      seen.add(id);
      const label = cleanTabName(typeof name === 'string' ? name : '', id);
      // A root is what makes a tab a project. A `kind` of `project` with no
      // usable root would be a rule that matches nothing, so it reads as manual
      // rather than as a tab that quietly never fills.
      const root = value['root'];
      const rooted = typeof root === 'string' ? cleanPath(root) : '';
      if (value['kind'] === 'project' && rooted.length > 0) {
        tabs.push({ id, name: label, kind: 'project', root: rooted });
      } else {
        tabs.push({ id, name: label, kind: 'manual' });
      }
    }
  }

  const assign: Record<string, Membership> = {};
  if (isRecord(raw['assign'])) {
    for (const [sessionId, value] of Object.entries(raw['assign'])) {
      // A membership pointing at a tab that no longer exists is not an error;
      // the session simply falls back to the rules, which is what `tabOf` says.
      if (typeof value === 'string') {
        if (seen.has(value) && value !== ALL_TAB) assign[sessionId] = { tab: value, pinned: true };
        continue;
      }
      if (!isRecord(value)) continue;
      const tab = value['tab'];
      if (typeof tab !== 'string' || !seen.has(tab)) continue;
      const pinned = value['pinned'] === true;
      // `all` is only worth recording as a pin: it is the state a session with
      // no record already has, unless a project would otherwise claim it.
      if (tab === ALL_TAB && !pinned) continue;
      assign[sessionId] = { tab, pinned };
    }
  }

  const active = raw['active'];
  return {
    tabs,
    assign,
    active: typeof active === 'string' && seen.has(active) ? active : ALL_TAB,
    autoProjects: raw['autoProjects'] === true,
  };
}

export function writeTabs(storage: StorageLike, state: TabsState): void {
  storage.setItem(
    TABS_KEY,
    JSON.stringify({
      v: 2,
      tabs: state.tabs.filter((tab) => tab.id !== ALL_TAB),
      assign: state.assign,
      active: state.active,
      autoProjects: state.autoProjects,
    }),
  );
}

/** A short, collision-free id that does not need `crypto`. */
function nextTabId(state: TabsState): string {
  let n = state.tabs.length;
  let id = `t${n}`;
  while (state.tabs.some((tab) => tab.id === id)) {
    n += 1;
    id = `t${n}`;
  }
  return id;
}

export function createTab(state: TabsState, name: string): { state: TabsState; id: string } {
  const id = nextTabId(state);
  return {
    id,
    state: { ...state, tabs: [...state.tabs, { id, name: cleanTabName(name), kind: 'manual' }] },
  };
}

/**
 * The tab that owns exactly this folder, if one does.
 *
 * Not {@link projectTabFor}, which answers "who draws a session running here"
 * and walks up the tree to do it. This one is the equality behind "one folder,
 * one tab": it is what stops a second tab being made for a folder that has one,
 * and what lets the sidebar offer *Go to tab* where it would otherwise offer
 * *Open a tab*.
 */
export function folderTabAt(state: TabsState, root: string): TabDef | undefined {
  const cleaned = cleanPath(root);
  if (cleaned.length === 0) return undefined;
  return projectTabs(state).find((tab) => {
    const root = tab.root;
    if (root === undefined) return false;
    const windows = isWindowsPath(root) || isWindowsPath(cleaned);
    return pathKey(root, windows) === pathKey(cleaned, windows);
  });
}

/**
 * WP4g: make a tab out of a folder.
 *
 * One project per folder, always. Asking for a root that already has a tab
 * hands back the tab it already has rather than a second one drawing the same
 * sessions — the deepest-match rule would have to pick between two identical
 * candidates, and "the same folder twice" is a question with no right answer.
 */
export function createProjectTab(
  state: TabsState,
  root: string,
  name?: string,
): { state: TabsState; id: string } {
  const cleaned = cleanPath(root);
  const existing = folderTabAt(state, cleaned);
  if (existing !== undefined) return { state, id: existing.id };
  const id = nextTabId(state);
  const label = cleanTabName(name ?? folderName(cleaned), folderName(cleaned));
  return {
    id,
    state: { ...state, tabs: [...state.tabs, { id, name: label, kind: 'project', root: cleaned }] },
  };
}

/**
 * N-WP11: open the tab of a folder a session is running in.
 *
 * The one way a folder tab is made now, and the difference from
 * {@link createProjectTab} is the two things a caller with no form to fall back
 * on needs: the name is {@link folderTabName}'s answer rather than a question
 * put to the user, and the result says whether a tab was *made* or an existing
 * one was found, so the page can say "opened" or "showing the one you have"
 * instead of guessing which just happened.
 *
 * `undefined` when the string is not a folder at all — a session whose working
 * directory the wire never carried. The button that calls this is not drawn on
 * such a row, and this is the second half of that: a rule, not a hidden button.
 */
export function openFolderTab(
  state: TabsState,
  root: string,
): { readonly state: TabsState; readonly id: string; readonly created: boolean } | undefined {
  const cleaned = cleanPath(root);
  if (cleaned.length === 0) return undefined;
  const existing = folderTabAt(state, cleaned);
  if (existing !== undefined) return { state, id: existing.id, created: false };
  const name = folderTabName(
    cleaned,
    state.tabs.map((tab) => tab.name),
  );
  const made = createProjectTab(state, cleaned, name);
  return { state: made.state, id: made.id, created: true };
}

/** Rename a tab. A project keeps its folder: the label is all that changes. */
export function renameTab(state: TabsState, id: string, name: string): TabsState {
  if (id === ALL_TAB) return state;
  return {
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.id === id ? { ...tab, name: cleanTabName(name, tab.name) } : tab,
    ),
  };
}

/** Every project tab, in the order they were made. */
export function projectTabs(state: TabsState): TabDef[] {
  return state.tabs.filter(
    (tab): tab is TabDef & { root: string } => tab.kind === 'project' && tab.root !== undefined,
  );
}

/** The sidebar's "make a project of every new folder" switch. */
export function setAutoProjects(state: TabsState, on: boolean): TabsState {
  return { ...state, autoProjects: on };
}

/**
 * Remove a tab; whatever lived on it falls back to the rules — which for a
 * project tab means *another* project, or `all`. Removing a project deletes the
 * rule and nothing else: no session, no transcript, no arrangement.
 */
export function removeTab(state: TabsState, id: string): TabsState {
  if (id === ALL_TAB) return state;
  const assign: Record<string, Membership> = {};
  for (const [sessionId, membership] of Object.entries(state.assign)) {
    if (membership.tab !== id) assign[sessionId] = membership;
  }
  return {
    ...state,
    tabs: state.tabs.filter((tab) => tab.id !== id),
    assign,
    active: state.active === id ? ALL_TAB : state.active,
  };
}

/**
 * Put a session on a tab **by hand**, which is the one gesture that outranks
 * every rule: the record is pinned, and a project that owns the folder stops
 * claiming this session until {@link followProject} is called.
 *
 * A move to `all` is recorded rather than deleted, and that is the WP4g change.
 * "Not on a tab of its own" and "taken off the project tab it kept appearing
 * on" look the same in a model that only stores memberships it has to; the pin
 * is what tells them apart, and deleting it would put the card straight back.
 */
export function moveSession(state: TabsState, sessionId: string, tabId: string): TabsState {
  if (!state.tabs.some((tab) => tab.id === tabId)) return state;
  return { ...state, assign: { ...state.assign, [sessionId]: { tab: tabId, pinned: true } } };
}

/**
 * Give a session back to the rules: whatever project owns its folder gets it,
 * and if none does it goes back to `all`.
 */
export function followProject(state: TabsState, sessionId: string): TabsState {
  if (state.assign[sessionId] === undefined) return state;
  const assign = { ...state.assign };
  delete assign[sessionId];
  return { ...state, assign };
}

/** Whether the user placed this session by hand. */
export function isPinned(state: TabsState, sessionId: string): boolean {
  return state.assign[sessionId]?.pinned === true;
}

/** The project tab that owns a working directory, deepest folder first. */
export function projectTabFor(state: TabsState, cwd: string | undefined): TabDef | undefined {
  const rooted = projectTabs(state).map((tab) => ({ tab, root: tab.root ?? '' }));
  return deepestMatch(rooted, cwd)?.tab;
}

/**
 * Which tab a session belongs to. Always exactly one, decided in this order:
 *
 * 1. a **pinned** membership — the user dragged the card there;
 * 2. the deepest **project** whose folder contains the session's `cwd`;
 * 3. an unpinned membership, which is only what a hand-edited store can hold;
 * 4. `all`.
 *
 * The `cwd` is the one the wire sent, which is redacted. That is deliberate and
 * it is documented in `./projects.ts`: the comparison is between strings the
 * page was already drawing, so a project can leak nothing a screenshot did not
 * already show.
 */
export function tabOf(state: TabsState, session: SessionPlace): string {
  const exists = (id: string): boolean => state.tabs.some((tab) => tab.id === id);
  const membership = state.assign[session.id];
  if (membership !== undefined && membership.pinned && exists(membership.tab)) {
    return membership.tab;
  }
  const project = projectTabFor(state, session.cwd);
  if (project !== undefined) return project.id;
  if (membership !== undefined && exists(membership.tab)) return membership.tab;
  return ALL_TAB;
}

/**
 * The sessions a tab shows, in the order given.
 *
 * `all` is not a bucket, it is the whole canvas: it shows every session,
 * including the ones that have been given a tab of their own. It is also the
 * fallback for everything unassigned, which is why a fresh install has one tab
 * and no membership record at all.
 */
export function sessionsOnTab(
  state: TabsState,
  tabId: string,
  sessions: readonly SessionPlace[],
): string[] {
  if (tabId === ALL_TAB) return sessions.map((session) => session.id);
  return sessions.filter((session) => tabOf(state, session) === tabId).map((one) => one.id);
}

/** How many of `sessions` each tab would show. */
export function tabCounts(
  state: TabsState,
  sessions: readonly SessionPlace[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const tab of state.tabs) counts.set(tab.id, tab.id === ALL_TAB ? sessions.length : 0);
  for (const session of sessions) {
    const tabId = tabOf(state, session);
    if (tabId === ALL_TAB) continue;
    counts.set(tabId, (counts.get(tabId) ?? 0) + 1);
  }
  return counts;
}

export function setActiveTab(state: TabsState, tabId: string): TabsState {
  if (!state.tabs.some((tab) => tab.id === tabId)) return state;
  return { ...state, active: tabId };
}

/**
 * Drop memberships for sessions the machine no longer knows about.
 *
 * `known` is every live session plus every session history can still open. A
 * session that ended keeps its place on its tab for as long as Claude Code
 * keeps its transcript, which is the "it stays where it was until removed" the
 * maintainer asked for; when the transcript expires the membership goes with
 * it rather than accumulating forever.
 */
export function pruneTabs(state: TabsState, known: ReadonlySet<string>): TabsState {
  const assign: Record<string, Membership> = {};
  for (const [sessionId, membership] of Object.entries(state.assign)) {
    if (known.has(sessionId)) assign[sessionId] = membership;
  }
  // Project tabs are not pruned. A folder outlives every session that ever ran
  // in it, and a project whose sessions have all ended is a tab waiting for the
  // next one rather than a stale record.
  return { ...state, assign };
}
