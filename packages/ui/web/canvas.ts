/**
 * The canvas renderer.
 *
 * One SVG, one `<g>` that carries the pan/zoom transform, and beneath it one
 * group per session that is created once and then only *updated*. Nothing is
 * rebuilt on a state change: a session that gained 900 output tokens rewrites
 * one text node. That is what keeps a wheel gesture at 60 fps while the SSE
 * stream is pushing snapshots underneath it.
 *
 * Every number on screen is exact and every absent number says `unknown`. The
 * two v1.1 fields (cost, context window) have no source yet, so they are not
 * drawn at all — not as `0`, not as an empty row.
 *
 * WP4c changed two things here. A card no longer decides its own place — it is
 * told one, because the user can drag it — and it is sized from the *bounding
 * box of its tree* rather than from how many columns happened to fit the
 * browser window, which is what used to push nodes and connectors outside the
 * frame.
 */
import type { Agent, AgentNode, SessionView } from '@nazar/core';

import type { Activity } from '../src/activity.ts';
import {
  ACTIVITIES,
  activityClass,
  activityLabel,
  agentActivity,
  sessionActivity,
} from '../src/activity.ts';
import {
  basename,
  cacheReadNote,
  captureBlockedLabel,
  captureBlockedNote,
  cardContextLabel,
  cardCostLabel,
  formatAge,
  formatCount,
  formatDuration,
  formatElapsed,
  modelChip,
  orUnknown,
  renameNote,
  resizeEdgeNote,
  resizeNote,
  summarize,
  summaryChips,
  unknownWord,
} from '../src/format.ts';
import { severityClass, severityForPercent } from '../src/quota-strip.ts';
import { formatStamp, shortSessionId } from '../src/history-view.ts';
import { hiddenLabel } from '../src/hidden.ts';
import { t, tCount } from '../src/i18n.ts';
import type {
  Box,
  CardBox,
  CardMinimum,
  CardSpec,
  PlacedTreeNode,
  TreeInput,
  TreeLayout,
  TreeSpec,
} from '../src/layout.ts';
import {
  boundsOf,
  cardMinimum,
  cardSize,
  clampCardHeight,
  clampCardWidth,
  edgePath,
  layerTree,
  maxCardHeight,
  maxCardWidth,
  MIN_CARD_WIDTH,
  minCardHeight,
  treeMaxWidth,
} from '../src/layout.ts';
import type { Placement } from '../src/pack.ts';
import { boundsOfPlacements } from '../src/pack.ts';
import { setAttr, setClass, setText, svg, textWidth } from './dom.ts';

/* ------------------------------------------------------------------ *
 * Geometry. All of it in one place so the layout tests and the drawing
 * cannot drift apart.
 * ------------------------------------------------------------------ */

export const CARD: CardSpec & { readonly radius: number } = {
  column: 360,
  gap: 24,
  pad: 16,
  headerHeight: 212,
  emptyTreeHeight: 10,
  collapsedHeight: 42,
  /**
   * A card never spans more than this many columns. A session with sixty
   * subagents (which happens) would otherwise be ten thousand pixels wide; past
   * this width the tree wraps onto another row instead.
   */
  maxColumns: 3,
  radius: 12,
};

/**
 * The agent card grew by one line in WP4d.
 *
 * The five lines it had — type, model, meta, and two rows of counters — filled
 * it to the pixel, and the activity word has to be *readable*, not squeezed in
 * beside a token total that is sometimes twenty characters long. A sixth line
 * at the bottom carries it, with the `orphan` marker moved down to share it.
 */
export const AGENT = {
  width: 156,
  height: 106,
  hGap: 16,
  vGap: 30,
  radius: 9,
} as const;

/** The tree geometry, as one spec, so nothing has to restate the four numbers. */
export const TREE_SPEC: TreeSpec = {
  nodeWidth: AGENT.width,
  nodeHeight: AGENT.height,
  hGap: AGENT.hGap,
  vGap: AGENT.vGap,
};

/** The width a tree must wrap at so its automatically sized card contains it. */
export const TREE_MAX_WIDTH = treeMaxWidth(CARD);

/**
 * WP4f: the corner grips. Square, because a corner is a corner, and small
 * enough that the two at the top do not eat into the ring or the badge.
 */
export const GRIP = 14;

/**
 * N-WP10: how thick an edge handle's hit area is, drawn inside the card.
 *
 * Ten, which is above the eight-pixel floor a pointer target needs and below
 * the sixteen-pixel card pad — so the strip down the side of a card never
 * reaches a node in the tree, and a press meant for the tree is never taken by
 * a resize.
 */
export const EDGE_GRIP = 10;

/** The four corners a card can be resized from, in DOM order. */
export const CORNERS = ['nw', 'ne', 'sw', 'se'] as const;

/** N-WP10: the four edges, drawn before the corners so a corner takes the press. */
export const EDGES = ['n', 's', 'w', 'e'] as const;

/**
 * Every handle on a card, in the order they are appended.
 *
 * Edges first and corners last, and that ordering *is* the priority rule: the
 * corner squares overlap the ends of the two edge strips they meet, and the
 * last one painted is the one a pointer lands on. Nothing arbitrates in code.
 */
export const HANDLES = [...EDGES, ...CORNERS] as const;

export type Corner = (typeof CORNERS)[number];

/** True for the two corners that grow the card leftwards. */
export function isWestCorner(corner: string): boolean {
  return corner === 'nw' || corner === 'sw';
}

/**
 * Where one handle's hit rectangle goes on a card of this size.
 *
 * The two horizontal strips stop short of the corners at each end and the two
 * vertical ones do the same, so the eight targets tile the card's border
 * without a gap and without a corner having to fight an edge for a press. On a
 * card too small for both, the strip clamps to nothing and the corners win,
 * which is the right way round: a corner does more.
 */
export function handleRect(
  handle: string,
  box: { readonly width: number; readonly height: number },
): { x: number; y: number; width: number; height: number } {
  const alongX = Math.max(0, box.width - GRIP * 2);
  const alongY = Math.max(0, box.height - GRIP * 2);
  switch (handle) {
    case 'n':
      return { x: GRIP, y: 0, width: alongX, height: EDGE_GRIP };
    case 's':
      return { x: GRIP, y: box.height - EDGE_GRIP, width: alongX, height: EDGE_GRIP };
    case 'w':
      return { x: 0, y: GRIP, width: EDGE_GRIP, height: alongY };
    case 'e':
      return { x: box.width - EDGE_GRIP, y: GRIP, width: EDGE_GRIP, height: alongY };
    default:
      return {
        x: isWestCorner(handle) ? 0 : box.width - GRIP,
        y: handle === 'nw' || handle === 'ne' ? 0 : box.height - GRIP,
        width: GRIP,
        height: GRIP,
      };
  }
}

/** How tall the drag handle at the top of a card is. Below it, dragging pans. */
export const HANDLE_HEIGHT = 62;

const BADGE = 30;
const RING_RADIUS = 11;
const MENU_SIZE = 22;
const CHEVRON = 18;

/** Where the provider badge comes from. Served from disk; never a CDN. */
const BADGE_SOURCE: Readonly<Record<string, string>> = {
  claude: 'assets/claude-color.png',
};

/**
 * What the hover card is pointing at. Resolved from `data-` attributes by the
 * one delegated listener in `app.ts` rather than from a listener per node:
 * fifty nodes would otherwise mean two hundred listeners rebuilt on every
 * structural change.
 */
export interface FocusTarget {
  readonly kind: 'session' | 'agent';
  readonly sessionId: string;
  readonly agentId?: string;
}

/** A session measured: how big its card is, and the tree that decided it. */
export interface CardMetric {
  readonly id: string;
  readonly tree: TreeLayout;
  readonly box: CardBox;
  readonly collapsed: boolean;
  /** WP4f: the width the user dragged to, if this card has one. */
  readonly width?: number;
  /** N-WP10: the height the user dragged to, if this card has one. */
  readonly height?: number;
}

export interface RenderResult {
  /** The box the drawn cards occupy, which is what *Fit* frames. */
  readonly bounds: Box;
}

/**
 * Frozen mode (WP4b): the same nodes, drawing a session that ended.
 *
 * Nothing about a finished session is happening, so nothing about it should
 * move or count. The renderer swaps every clock-relative string for an
 * absolute one — elapsed becomes the run's duration, "written 4s ago" becomes
 * the timestamp of the last write — and the CSS root class stops the pulse. It
 * also gives every agent the line the live canvas has no room for: how long it
 * ran and how many tools it called.
 */
export interface RenderOptions {
  readonly frozen?: boolean;
  /**
   * WP4f: how many finished subagents each card is *not* drawing.
   *
   * The renderer is handed sessions that have already been filtered, so it
   * cannot count what is missing — and the chip that offers them back has to
   * say a number. One map, filled only for the cards that have hidden
   * something.
   */
  readonly hidden?: Readonly<Record<string, number>>;
  /**
   * WP4g: the label the user typed over a card's title, by session id.
   *
   * Absent for every card that has not been renamed, which is all of them on a
   * fresh install. When one is present it takes the title line and the folder
   * basename gives it up — the whole path is still on the line below it, so
   * nothing is lost and the card finally says which of three `app` sessions
   * this is. These strings live in `localStorage` and nowhere else.
   */
  readonly names?: Readonly<Record<string, string>>;
}

/**
 * Age of a write, measured against the clock rather than against the snapshot,
 * so "written 4s ago" keeps counting between two SSE frames.
 */
export function ageOf(writtenAt: number | undefined, now: number): number | undefined {
  if (writtenAt === undefined) return undefined;
  return Math.max(0, now - writtenAt);
}

/** `AgentNode` carries the agent; the layout only needs ids and shape. */
function toTreeInput(nodes: readonly AgentNode[]): TreeInput[] {
  return nodes.map((node) => ({ id: node.agent.id, children: toTreeInput(node.children) }));
}

const EMPTY_TREE: TreeLayout = {
  nodes: [],
  edges: [],
  width: 0,
  height: 0,
  maxDepth: 0,
  bounds: boundsOf([]),
};

/**
 * The narrowest this card may be dragged, and why.
 *
 * Computed on demand rather than on every frame: it costs a second tree layout,
 * and the only two moments that need it are the start of a resize and a test.
 * A stored width is *not* re-clamped against it every frame either — a card
 * whose tree grew after it was sized simply gets taller, because the tree wraps
 * to whatever budget it is given and can never overflow the frame.
 */
export function cardMinimumFor(session: SessionView, collapsed: boolean): CardMinimum {
  return cardMinimum(toTreeInput(session.roots), collapsed, TREE_SPEC, CARD);
}

/** The widest any card may be dragged. One number, from the card spec. */
export const MAX_CARD_WIDTH = maxCardWidth(CARD);

/** N-WP10: the tallest any card may be dragged. */
export const MAX_CARD_HEIGHT = maxCardHeight(CARD);

/** What `measureCards` accepts beyond the sessions and the folded set. */
export interface MeasureOptions {
  /** WP4f: widths the user dragged to, by session id. */
  readonly widths?: Readonly<Record<string, number>>;
  /** N-WP10: heights the user dragged to, by session id. */
  readonly heights?: Readonly<Record<string, number>>;
}

/**
 * Size every card.
 *
 * Kept out of the renderer because the *placement* pass needs the sizes before
 * anything is drawn: a session that has just appeared cannot be given the first
 * free slot until the canvas knows how big it is.
 *
 * WP4f adds the one line that makes a card resizable at all — **the width is
 * the tree's wrapping budget**. A card with no stored width wraps at the
 * three-column cap and then snaps to whole columns, exactly as before; a card
 * the user dragged wraps at `width - pad * 2` and is that wide to the pixel.
 * Either way the tree is laid out at the budget the card will actually have,
 * which is what keeps WP4c's containment rule true for both.
 *
 * N-WP10 adds the second axis, and it is deliberately *not* symmetric: a stored
 * height is a floor under the height the tree asks for, never a value in place
 * of it. The width decides how the tree wraps and the wrapping decides how tall
 * the card has to be; a height is only room added under it.
 */
export function measureCards(
  sessions: readonly SessionView[],
  collapsed: ReadonlySet<string>,
  options: MeasureOptions = {},
): Map<string, CardMetric> {
  const metrics = new Map<string, CardMetric>();
  for (const session of sessions) {
    const folded = collapsed.has(session.id);
    const stored = options.widths?.[session.id];
    // Held inside the absolute bounds here and against the *tree's* minimum at
    // drag time. Doing it the other way round would mean a second tree layout
    // per card per frame to answer a question only a pointer ever asks.
    const width =
      stored === undefined ? undefined : clampCardWidth(stored, MIN_CARD_WIDTH, CARD);
    const tree = folded
      ? EMPTY_TREE
      : layerTree(toTreeInput(session.roots), {
          ...TREE_SPEC,
          maxWidth: width === undefined ? TREE_MAX_WIDTH : width - CARD.pad * 2,
        });
    const storedHeight = options.heights?.[session.id];
    const height =
      storedHeight === undefined
        ? undefined
        : clampCardHeight(storedHeight, minCardHeight(CARD), CARD);
    const metric: { -readonly [K in keyof CardMetric]: CardMetric[K] } = {
      id: session.id,
      tree,
      box: cardSize(tree, folded, CARD, {
        ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height }),
      }),
      collapsed: folded,
    };
    if (width !== undefined) metric.width = width;
    if (height !== undefined) metric.height = height;
    metrics.set(session.id, metric);
  }
  return metrics;
}

/** Cut a label to a pixel width, marking the cut. */
function fitText(text: string, maxWidth: number, fontSize: number): string {
  if (textWidth(text, fontSize) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && textWidth(`${out}…`, fontSize) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

/** Font size and letter-spacing of the activity word. Mirrors styles.css. */
const ACTIVITY_SIZE = 10;
const ACTIVITY_TRACKING = 0.07;

/**
 * How much room the activity word needs, so the line it shares can be cut to
 * fit instead of running underneath it. The word is drawn uppercase with
 * `tracking-wide`, and both of those are in the stylesheet, so both are
 * accounted for here.
 */
function activityRoom(label: string): number {
  const upper = label.toUpperCase();
  return Math.round(
    textWidth(upper, ACTIVITY_SIZE) + upper.length * ACTIVITY_SIZE * ACTIVITY_TRACKING + 12,
  );
}

/**
 * Put exactly one `is-*` activity class on a node's group.
 *
 * All five are written every frame — four off, one on — because a node that
 * moves from `working` to `done` has to lose the first class as surely as it
 * gains the second, and `setClass` writes nothing when the state already
 * agrees. This is the whole state update: no attribute rewrite, no rebuild.
 */
function setActivityClass(node: Element, activity: Activity): void {
  for (const one of ACTIVITIES) setClass(node, activityClass(one), one === activity);
}

interface ChipEls {
  readonly g: SVGGElement;
  readonly rect: SVGRectElement;
  readonly text: SVGTextElement;
}

function makeChip(parent: SVGGElement, variant: string): ChipEls {
  const g = svg('g', `nz-chip nz-chip--${variant}`);
  const rect = svg('rect', 'nz-chip__bg');
  setAttr(rect, 'rx', 7);
  setAttr(rect, 'height', 19);
  const text = svg('text', 'nz-chip__text');
  setAttr(text, 'y', 13.5);
  g.append(rect, text);
  parent.append(g);
  return { g, rect, text };
}

/** How wide a chip carrying this label will be. Right-aligning one needs it. */
function chipWidth(label: string): number {
  return Math.round(textWidth(label, 11) + 18);
}

/** Position a chip at `x` and return the x the next chip should start at. */
function layoutChip(chip: ChipEls, label: string, x: number): number {
  const width = chipWidth(label);
  setAttr(chip.g, 'transform', `translate(${x},0)`);
  setAttr(chip.rect, 'width', width);
  setAttr(chip.text, 'x', 9);
  setText(chip.text, label);
  return x + width + 6;
}

interface AgentEls {
  readonly g: SVGGElement;
  readonly bg: SVGRectElement;
  readonly dot: SVGCircleElement;
  readonly type: SVGTextElement;
  readonly model: SVGTextElement;
  readonly meta: SVGTextElement;
  readonly doneChip: ChipEls;
  readonly tokensA: SVGTextElement;
  readonly tokensB: SVGTextElement;
  readonly activity: SVGTextElement;
  readonly orphan: SVGTextElement;
}

interface SessionEls {
  readonly g: SVGGElement;
  readonly card: SVGGElement;
  readonly bg: SVGRectElement;
  readonly badge: SVGImageElement;
  readonly badgeFallback: SVGCircleElement;
  readonly ring: SVGCircleElement;
  readonly ringPulse: SVGCircleElement;
  readonly title: SVGTextElement;
  readonly path: SVGTextElement;
  readonly identity: SVGTextElement;
  readonly activity: SVGTextElement;
  readonly chipRow: SVGGElement;
  readonly modelChip: ChipEls;
  readonly effortChip: ChipEls;
  readonly statusChip: ChipEls;
  readonly meta: SVGTextElement;
  readonly tokensA: SVGTextElement;
  readonly tokensB: SVGTextElement;
  /** WP3': cost and context window. Both absent when no capture named this session. */
  readonly cost: SVGTextElement;
  readonly context: SVGTextElement;
  readonly treeLabel: SVGTextElement;
  readonly rule: SVGLineElement;
  readonly handle: SVGRectElement;
  /** WP4g: the strip over the title that opens the inline name editor. */
  readonly nameHit: SVGRectElement;
  readonly nameNote: SVGTitleElement;
  readonly chevron: SVGGElement;
  readonly chevronPath: SVGPathElement;
  readonly menu: SVGGElement;
  readonly summary: SVGGElement;
  readonly summaryChips: readonly ChipEls[];
  /** WP4f: `N finished hidden · show`, drawn only when something is hidden. */
  readonly hiddenChip: ChipEls;
  /** WP4f: why this card has no cost and no context window, when we know. */
  readonly blocked: SVGTextElement;
  readonly edges: SVGGElement;
  readonly treeGroup: SVGGElement;
  /** The eight resize handles, in {@link HANDLES} order. */
  readonly grips: readonly SVGRectElement[];
  readonly agents: Map<string, AgentEls>;
  readonly edgePaths: Map<string, SVGPathElement>;
}

export class CanvasRenderer {
  private readonly root: SVGGElement;

  private readonly sessions = new Map<string, SessionEls>();

  constructor(root: SVGGElement) {
    this.root = root;
  }

  /**
   * Draw a snapshot at the places it is given.
   *
   * `placements` is resolved by the caller — stored positions, the first free
   * slot for a session that just appeared, or a full re-pack — because where a
   * card sits is now the user's business and not the renderer's.
   */
  update(
    sessions: readonly SessionView[],
    metrics: ReadonlyMap<string, CardMetric>,
    placements: ReadonlyMap<string, Placement>,
    now: number,
    options: RenderOptions = {},
  ): RenderResult {
    const frozen = options.frozen === true;
    const alive = new Set<string>();
    const placed: Placement[] = [];

    for (const session of sessions) {
      const placement = placements.get(session.id);
      const metric = metrics.get(session.id);
      if (placement === undefined || metric === undefined) continue;
      alive.add(session.id);
      placed.push(placement);
      this.drawSession(session, placement, metric, now, frozen, options.hidden?.[session.id] ?? 0, {
        ...(options.names?.[session.id] === undefined
          ? {}
          : { name: options.names[session.id] as string }),
      });
    }

    for (const [id, els] of this.sessions) {
      if (alive.has(id)) continue;
      els.g.remove();
      this.sessions.delete(id);
    }

    return { bounds: boundsOfPlacements(placed) };
  }

  /**
   * Move one card without redrawing anything.
   *
   * A drag runs at pointer rate. Re-rendering sixty subagents on every
   * `pointermove` to change one `translate` would be the whole frame budget
   * spent on nothing.
   */
  moveCard(sessionId: string, x: number, y: number): void {
    const els = this.sessions.get(sessionId);
    if (els === undefined) return;
    setAttr(els.g, 'transform', `translate(${x},${y})`);
  }

  /** Mark a card as being dragged, for the cursor and the lift. */
  setMoving(sessionId: string, moving: boolean): void {
    const els = this.sessions.get(sessionId);
    if (els === undefined) return;
    setClass(els.g, 'is-moving', moving);
    // A card being dragged has to be on top of the ones it passes over.
    if (moving) this.root.append(els.g);
  }

  /** Where a card's menu button is on screen, for anchoring the popup. */
  menuAnchor(sessionId: string): DOMRect | undefined {
    return this.sessions.get(sessionId)?.menu.getBoundingClientRect();
  }

  /**
   * WP4g: where the inline name editor goes — the title strip, in screen
   * coordinates, so an HTML `<input>` can be laid exactly over the SVG text it
   * is replacing. The rectangle is the pan and zoom the card is drawn at, which
   * is why the editor is positioned from it every time it opens rather than
   * once.
   */
  nameAnchor(sessionId: string): DOMRect | undefined {
    return this.sessions.get(sessionId)?.nameHit.getBoundingClientRect();
  }

  /** Drop every node. Used when the canvas swaps between live and frozen. */
  reset(): void {
    for (const els of this.sessions.values()) els.g.remove();
    this.sessions.clear();
  }

  /**
   * Mark a card as being resized, for the outline and for the grips.
   *
   * There is no `resizeCard` beside {@link moveCard}, and that is the point: a
   * move is one `transform` and can outrun the frame, but a resize changes the
   * tree's wrapping budget, so it *has* to go through a re-measure and a
   * re-draw. `app.ts` schedules one per frame and nothing here shortcuts it.
   */
  setResizing(sessionId: string, resizing: boolean): void {
    const els = this.sessions.get(sessionId);
    if (els === undefined) return;
    setClass(els.g, 'is-resizing', resizing);
    if (resizing) this.root.append(els.g);
  }

  private drawSession(
    session: SessionView,
    placement: Placement,
    metric: CardMetric,
    now: number,
    frozen: boolean,
    hiddenCount: number,
    label: { readonly name?: string },
  ): void {
    const els = this.sessions.get(session.id) ?? this.createSession(session);
    const { box, tree, collapsed } = metric;
    const inner = box.innerWidth;

    setAttr(els.g, 'transform', `translate(${placement.x},${placement.y})`);
    setAttr(els.bg, 'width', box.width);
    setAttr(els.bg, 'height', box.height);
    setAttr(els.handle, 'width', box.width);
    setClass(els.g, 'is-collapsed', collapsed);

    // ---- state: the frame, the ring, and the word -------------------
    // One answer, four places. `activityOf` decides it; everything below only
    // draws it, and it draws it by toggling classes on a group that already
    // exists — a state change never rebuilds a node, which is what keeps the
    // SSE path cheap.
    const activity = sessionActivity(session, now, frozen);
    const waiting = activity === 'waiting';
    const ringX = box.width - CARD.pad - RING_RADIUS;
    setAttr(els.ring, 'cx', ringX);
    setAttr(els.ringPulse, 'cx', ringX);
    setAttr(els.ring, 'data-state', frozen ? 'frozen' : waiting ? 'waiting' : session.state);
    setActivityClass(els.g, activity);
    setClass(els.g, 'is-frozen', frozen);

    // ---- identity ---------------------------------------------------
    const menuX = box.width - CARD.pad - RING_RADIUS * 2 - 8 - MENU_SIZE;
    setAttr(els.menu, 'transform', `translate(${menuX},${CARD.pad + 4})`);
    // A frozen tree is a read of the past: it belongs to no tab, and it is not
    // draggable either, because it is not one of the canvas's own cards.
    setAttr(els.menu, 'display', frozen ? 'none' : 'inline');
    setAttr(els.handle, 'display', frozen ? 'none' : 'inline');

    // ---- WP4f + N-WP10: the eight resize handles ---------------------
    // Positioned rather than rebuilt, like everything else on the card. They
    // are the last children of the card group, so they take a press before the
    // drag handle above them and before the tree below them.
    for (const [index, handle] of HANDLES.entries()) {
      const grip = els.grips[index];
      if (grip === undefined) continue;
      const rect = handleRect(handle, box);
      setAttr(grip, 'x', rect.x);
      setAttr(grip, 'y', rect.y);
      setAttr(grip, 'width', rect.width);
      setAttr(grip, 'height', rect.height);
      setAttr(grip, 'display', frozen ? 'none' : 'inline');
    }
    setClass(els.g, 'is-sized', metric.width !== undefined || metric.height !== undefined);

    const titleRoom = inner - BADGE - 16 - RING_RADIUS * 2 - MENU_SIZE - 8;
    setAttr(els.badge, 'href', BADGE_SOURCE[session.provider] ?? '');
    /*
     * WP4g. The title is the user's word for this session when they have given
     * one, and the folder's name when they have not. The line below it is the
     * working directory either way — which already ends in that folder name, so
     * a renamed card loses nothing and gains the only thing a directory cannot
     * say: *which* of these you are looking at.
     */
    const named = label.name !== undefined && label.name.length > 0;
    setText(els.title, fitText(named ? (label.name as string) : basename(session.cwd), titleRoom, 15));
    setClass(els.g, 'is-named', named);
    setText(els.path, fitText(orUnknown(session.cwd), inner - BADGE - 16, 11.5));
    // The click target for renaming, over the title text and above the drag
    // handle. Sized to the room the title had rather than to the glyphs it
    // used, so a short title is still comfortable to hit; a frozen card has
    // nothing to rename, so the target is not there at all.
    setAttr(els.nameHit, 'x', CARD.pad + BADGE + 8);
    setAttr(els.nameHit, 'width', Math.max(24, titleRoom + 8));
    setAttr(els.nameHit, 'display', frozen ? 'none' : 'inline');
    els.nameHit.setAttribute(
      'aria-label',
      t(named ? 'card.renameLabel' : 'card.nameLabel', {
        name: named ? (label.name as string) : basename(session.cwd),
      }),
    );
    setText(els.nameNote, renameNote(named));
    // The word for the frame colour, right-aligned under the ring. A frame is
    // a colour, and a colour on its own is not a state — greyscale screenshots
    // and colour-blind readers both lose it — so the word is not optional and
    // the identity line gives up the room for it.
    const activityWord = activityLabel(activity);
    const labelRoom = activityRoom(activityWord);
    setAttr(els.activity, 'x', box.width - CARD.pad);
    setText(els.activity, activityWord);
    // A finished session has no process and no live status, so the identity
    // line names the run itself: which session, and how many agents it spawned.
    setText(
      els.identity,
      fitText(
        frozen
          ? t('card.identityFrozen', {
              session: shortSessionId(session.id),
              agents: formatCount(session.agents.length),
            })
          : t('card.identityLive', {
              pid: session.pid,
              name: orUnknown(session.name),
              status: session.status,
            }),
        inner - 8 - labelRoom,
        11.5,
      ),
    );
    setAttr(
      els.g,
      'aria-label',
      frozen
        ? t('card.frozenLabel', {
            session: shortSessionId(session.id),
            folder: orUnknown(session.cwd),
            duration: formatDuration(
              session.startedAt === undefined || session.transcriptAt === undefined
                ? undefined
                : session.transcriptAt - session.startedAt,
            ),
            agents: formatCount(session.agents.length),
          })
        : t('card.liveLabel', {
            name: named ? (label.name as string) : basename(session.cwd),
            activity: activityWord,
            status: session.status,
            state: session.state,
          }) +
          (waiting ? t('card.waitingLabel', { waitingFor: orUnknown(session.waitingFor) }) : ''),
    );

    // ---- chips ------------------------------------------------------
    let x = 0;
    x = layoutChip(els.modelChip, modelChip(session.model), x);
    x = layoutChip(els.effortChip, t('chip.effort', { effort: orUnknown(session.effort) }), x);
    if (waiting) {
      setAttr(els.statusChip.g, 'display', 'inline');
      layoutChip(els.statusChip, orUnknown(session.waitingFor), x);
    } else {
      setAttr(els.statusChip.g, 'display', 'none');
    }

    // ---- numbers ----------------------------------------------------
    // Live: how long it has been going and how stale the numbers are. Frozen:
    // how long it took and when it ended, because "3h ago" on a finished run
    // says something about the clock rather than about the run.
    const tools = session.toolCalls === undefined ? unknownWord() : formatCount(session.toolCalls);
    const ranFor =
      session.startedAt === undefined || session.transcriptAt === undefined
        ? undefined
        : Math.max(0, session.transcriptAt - session.startedAt);
    setText(
      els.meta,
      fitText(
        frozen
          ? t('card.metaFrozen', {
              duration: formatDuration(ranFor),
              tools,
              ended: formatStamp(session.transcriptAt),
            })
          : t('card.metaLive', {
              elapsed: formatElapsed(session.startedAt, now),
              tools,
              written: formatAge(ageOf(session.transcriptAt, now)),
            }),
        inner,
        11.5,
      ),
    );
    const tokens = session.tokens;
    setText(
      els.tokensA,
      `${t('tokens.in', { count: formatCount(tokens?.in) })}   ` +
        t('tokens.out', { count: formatCount(tokens?.out) }),
    );
    setText(
      els.tokensB,
      `${t('tokens.cacheReadLong', { count: formatCount(tokens?.cacheRead) })}   ` +
        t('tokens.cacheWriteLong', { count: formatCount(tokens?.cacheWrite) }),
    );

    /*
     * WP3', reworked in WP4e. Both fields come from the status-line capture, so
     * both are absent on a machine without the wrapper and on a frozen session —
     * a capture is deleted seven days after its session stops writing, and a
     * past run's cost is nowhere in the transcript. Absent still means *not
     * drawn*: there is no `$unknown`, and the card does not change size either
     * way, which is why these two share one line instead of taking a row each.
     *
     * What changed is that they are now **words**. WP5 drew `$9.60   ctx 54%`
     * in the muted token below four token counters, and the maintainer — who
     * has the wrapper installed — never found them. `ctx` is jargon for a thing
     * the rest of this interface spells out, and a number with no word in front
     * of it disappears into a column of numbers. So: `cost $9.60` on the left,
     * `context 54 %` on the right, both at the weight of the counters above
     * them, and the context figure carries the same amber-at-60, red-at-85
     * severity the usage bead does — because it is the same question about a
     * window filling up.
     */
    const costText = frozen ? undefined : cardCostLabel(session.costUsd);
    const contextText = frozen ? undefined : cardContextLabel(session.contextWindow);
    setAttr(els.cost, 'display', costText === undefined ? 'none' : 'inline');
    setText(els.cost, costText === undefined ? '' : fitText(costText, inner / 2, 11.5));
    setAttr(els.context, 'display', contextText === undefined ? 'none' : 'inline');
    setAttr(els.context, 'x', box.width - CARD.pad);
    setText(els.context, contextText === undefined ? '' : fitText(contextText, inner / 2, 11.5));
    for (const name of ['is-ok', 'is-warn', 'is-critical', 'is-unknown']) {
      setClass(
        els.context,
        name,
        name === severityClass(severityForPercent(session.contextWindow?.percent)),
      );
    }

    /*
     * WP4f. The one case where "absent" has a *knowable* reason.
     *
     * Cost and context come from a capture the status-line wrapper writes, and
     * a project whose own Claude Code settings declare a `statusLine` replaces
     * the user-level wrapper for every session started inside it — so the
     * wrapper never runs, no capture is ever written, and two fields are
     * silently missing on those cards and only those. Silently is the problem:
     * the rest of this interface earns the right to draw nothing by never
     * drawing a guess, but a blank that *has* an explanation should carry it.
     *
     * It takes the line the two numbers would have used, so a card that has
     * them is unchanged and no card changes size either way.
     */
    const blocked =
      !frozen && costText === undefined && contextText === undefined
        ? session.captureBlockedBy
        : undefined;
    setAttr(els.blocked, 'display', blocked === undefined ? 'none' : 'inline');
    setText(
      els.blocked,
      blocked === undefined ? '' : fitText(captureBlockedLabel(), inner, 11.5),
    );

    // ---- subagents --------------------------------------------------
    const count = session.agents.length;
    setText(
      els.treeLabel,
      count === 0
        ? t(session.treeRead ? 'card.noSubagents' : 'card.subagentsUnknown')
        : t('card.subagents', { count: formatCount(count) }),
    );
    setAttr(els.rule, 'x2', inner);

    // The chevron is only a control when there is a tree to fold.
    const foldable = !frozen && count > 0;
    setAttr(els.chevron, 'display', foldable ? 'inline' : 'none');
    setAttr(els.treeLabel, 'x', foldable ? CHEVRON + 6 : 0);
    setAttr(els.chevronPath, 'd', collapsed ? 'M 7 4 L 12 9 L 7 14' : 'M 4 7 L 9 12 L 14 7');
    els.chevron.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    els.chevron.setAttribute(
      'aria-label',
      t(collapsed ? 'card.expandTree' : 'card.collapseTree', { folder: basename(session.cwd) }),
    );

    /*
     * WP4f: `3 finished hidden · show`.
     *
     * Right-aligned on the same rule as `subagents (N)`, because it is a
     * footnote to that count and not a separate fact. It is drawn only when
     * something is actually hidden — there is no permanent "0 hidden" control —
     * and clicking it brings every one of them back at once.
     */
    const hiddenText = hiddenCount > 0 ? hiddenLabel(hiddenCount) : undefined;
    setAttr(els.hiddenChip.g, 'display', hiddenText === undefined ? 'none' : 'inline');
    if (hiddenText !== undefined) {
      layoutChip(els.hiddenChip, hiddenText, Math.max(0, inner - chipWidth(hiddenText)));
      els.hiddenChip.g.setAttribute(
        'aria-label',
        t('card.showHiddenLabel', {
          count: formatCount(hiddenCount),
          folder: basename(session.cwd),
        }),
      );
    }

    if (collapsed) {
      setAttr(els.summary, 'display', 'inline');
      const labels = summaryChips(summarize(session.agents));
      let chipX = 0;
      for (const [index, chip] of els.summaryChips.entries()) {
        const label = labels[index];
        if (label === undefined) {
          setAttr(chip.g, 'display', 'none');
          continue;
        }
        setAttr(chip.g, 'display', 'inline');
        chipX = layoutChip(chip, label, chipX);
      }
    } else {
      setAttr(els.summary, 'display', 'none');
    }

    setAttr(els.treeGroup, 'display', collapsed ? 'none' : 'inline');
    setAttr(els.edges, 'display', collapsed ? 'none' : 'inline');
    setAttr(els.treeGroup, 'transform', `translate(${box.treeOriginX},${box.treeOriginY})`);
    setAttr(els.edges, 'transform', `translate(${box.treeOriginX},${box.treeOriginY})`);

    const byId = new Map(session.agents.map((agent) => [agent.id, agent]));
    const placedIds = new Set<string>();
    if (!collapsed) {
      for (const node of tree.nodes) {
        const agent = byId.get(node.id);
        if (agent === undefined) continue;
        placedIds.add(node.id);
        this.drawAgent(els, session, agent, node, now, frozen);
      }
    }
    for (const [id, agentEls] of els.agents) {
      if (placedIds.has(id)) continue;
      agentEls.g.remove();
      els.agents.delete(id);
    }

    this.drawEdges(els, collapsed ? [] : tree.edges);
  }

  private drawAgent(
    els: SessionEls,
    session: SessionView,
    agent: Agent,
    node: PlacedTreeNode,
    now: number,
    frozen: boolean,
  ): void {
    let agentEls = els.agents.get(agent.id);
    if (agentEls === undefined) {
      agentEls = this.createAgent(session.id, agent.id);
      els.treeGroup.append(agentEls.g);
      els.agents.set(agent.id, agentEls);
    }

    const activity = agentActivity(agent, now, frozen);
    const done = agent.state === 'done';
    setAttr(agentEls.g, 'transform', `translate(${node.x},${node.y})`);
    setAttr(agentEls.dot, 'data-state', agent.state);
    setActivityClass(agentEls.g, activity);
    setClass(agentEls.g, 'is-orphan', agent.orphan === true);
    setText(agentEls.activity, activityLabel(activity));

    const inner = AGENT.width - 20;
    setText(agentEls.type, fitText(orUnknown(agent.agentType), inner - 12, 11.5));
    setText(
      agentEls.model,
      fitText(
        `${modelChip(agent.model ?? agent.modelId)} · ` +
          (agent.effort === undefined
            ? t('chip.effortUnknown')
            : t('chip.effort', { effort: agent.effort })),
        inner,
        10,
      ),
    );

    // The third line is the one that changes with state. A running agent shows
    // how long it has been going and what it is doing; a finished one shows the
    // chip WP4b exists for — `done · 12m 03s` — and, on a frozen tree where
    // every agent is finished, its tool-call count next to the duration.
    const duration = formatDuration(agent.durationMs);
    if (frozen) {
      setAttr(agentEls.doneChip.g, 'display', 'none');
      setAttr(agentEls.meta, 'display', 'inline');
      setText(
        agentEls.meta,
        fitText(
          t('agent.metaFrozen', {
            duration,
            tools: agent.toolCalls === undefined ? unknownWord() : formatCount(agent.toolCalls),
          }),
          inner,
          10,
        ),
      );
    } else if (done) {
      setAttr(agentEls.meta, 'display', 'none');
      setAttr(agentEls.doneChip.g, 'display', 'inline');
      layoutChip(agentEls.doneChip, t('agent.done', { duration }), 8);
    } else {
      setAttr(agentEls.doneChip.g, 'display', 'none');
      setAttr(agentEls.meta, 'display', 'inline');
      setText(
        agentEls.meta,
        fitText(
          `${formatElapsed(agent.startedAt, now)} · ` +
            (agent.currentTool === undefined ? t('agent.toolUnknown') : agent.currentTool),
          inner,
          10,
        ),
      );
    }

    setText(
      agentEls.tokensA,
      `${t('tokens.in', { count: formatCount(agent.tokens?.in) })}  ` +
        t('tokens.out', { count: formatCount(agent.tokens?.out) }),
    );
    setText(
      agentEls.tokensB,
      `${t('tokens.cacheRead', { count: formatCount(agent.tokens?.cacheRead) })}  ` +
        t('tokens.cacheWrite', { count: formatCount(agent.tokens?.cacheWrite) }),
    );
    setText(agentEls.orphan, agent.orphan === true ? t('agent.orphan') : '');

    setAttr(
      agentEls.g,
      'aria-label',
      t('agent.label', {
        type: orUnknown(agent.agentType),
        activity: activityLabel(activity),
        state: agent.state,
        depth: agent.spawnDepth,
      }) +
        (done ? t('agent.labelRanFor', { duration }) : '') +
        (frozen && agent.toolCalls !== undefined
          ? tCount('agent.labelTools', agent.toolCalls, { count: formatCount(agent.toolCalls) })
          : ''),
    );
  }

  /**
   * One path per parent-child link, reused across frames.
   *
   * The route comes from the layout, not from here. That is deliberate: the
   * card is sized around a bounding box that includes these vertices, so a
   * connector drawn to some other rule could leave the frame again.
   */
  private drawEdges(els: SessionEls, edges: TreeLayout['edges']): void {
    const live = new Set<string>();

    for (const edge of edges) {
      const key = `${edge.parentId}->${edge.childId}`;
      live.add(key);
      let path = els.edgePaths.get(key);
      if (path === undefined) {
        path = svg('path', 'nz-edge');
        els.edges.append(path);
        els.edgePaths.set(key, path);
      }
      setAttr(path, 'd', edgePath(edge));
    }

    for (const [key, path] of els.edgePaths) {
      if (live.has(key)) continue;
      path.remove();
      els.edgePaths.delete(key);
    }
  }

  private createSession(session: SessionView): SessionEls {
    const g = svg('g', 'nz-session');
    g.dataset['sessionId'] = session.id;
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'group');

    const bg = svg('rect', 'nz-session__bg');
    setAttr(bg, 'rx', CARD.radius);

    const badge = svg('image', 'nz-badge');
    setAttr(badge, 'x', CARD.pad);
    setAttr(badge, 'y', CARD.pad);
    setAttr(badge, 'width', BADGE);
    setAttr(badge, 'height', BADGE);
    badge.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    const badgeFallback = svg('circle', 'nz-badge__fallback');
    setAttr(badgeFallback, 'cx', CARD.pad + BADGE / 2);
    setAttr(badgeFallback, 'cy', CARD.pad + BADGE / 2);
    setAttr(badgeFallback, 'r', BADGE / 2);

    const ringPulse = svg('circle', 'nz-ring__pulse');
    setAttr(ringPulse, 'cy', CARD.pad + RING_RADIUS);
    setAttr(ringPulse, 'r', RING_RADIUS);
    const ring = svg('circle', 'nz-ring');
    setAttr(ring, 'cy', CARD.pad + RING_RADIUS);
    setAttr(ring, 'r', RING_RADIUS);

    const title = svg('text', 'nz-session__title');
    setAttr(title, 'x', CARD.pad + BADGE + 12);
    setAttr(title, 'y', CARD.pad + 14);

    /*
     * WP4g: the rename target.
     *
     * A transparent rectangle over the title rather than a click handler on the
     * `<text>`: a short title would otherwise be a two-word hit area, and the
     * gesture the maintainer asked for is "click the title", which people aim
     * at the whole line. It is appended after the drag handle so it takes the
     * press first — the rest of the header still drags the card, which is why
     * it is a strip over the title and not the whole header.
     */
    const nameHit = svg('rect', 'nz-session__namehit');
    setAttr(nameHit, 'y', CARD.pad);
    setAttr(nameHit, 'height', 20);
    setAttr(nameHit, 'rx', 5);
    nameHit.dataset['action'] = 'rename';
    nameHit.setAttribute('role', 'button');
    nameHit.setAttribute('tabindex', '0');
    const nameNote = svg('title');
    setText(nameNote, renameNote(false));
    nameHit.append(nameNote);

    const path = svg('text', 'nz-session__path');
    setAttr(path, 'x', CARD.pad + BADGE + 12);
    setAttr(path, 'y', CARD.pad + 30);

    const identity = svg('text', 'nz-session__identity');
    setAttr(identity, 'x', CARD.pad);
    setAttr(identity, 'y', 74);

    // Right-aligned on the identity line, under the ring: the word that says
    // what the frame colour means. `x` follows the card width on every draw.
    const activity = svg('text', 'nz-session__activity');
    setAttr(activity, 'y', 74);

    const chipRow = svg('g', 'nz-session__chips');
    setAttr(chipRow, 'transform', `translate(${CARD.pad},86)`);
    const modelChipEls = makeChip(chipRow, 'model');
    const effortChipEls = makeChip(chipRow, 'effort');
    const statusChipEls = makeChip(chipRow, 'waiting');

    const meta = svg('text', 'nz-session__meta');
    setAttr(meta, 'x', CARD.pad);
    setAttr(meta, 'y', 128);

    const tokensA = svg('text', 'nz-session__tokens');
    setAttr(tokensA, 'x', CARD.pad);
    setAttr(tokensA, 'y', 150);

    const tokensB = svg('text', 'nz-session__tokens');
    setAttr(tokensB, 'x', CARD.pad);
    setAttr(tokensB, 'y', 166);
    // `cache r` is a running sum of whole contexts re-read, so it is orders of
    // magnitude above the other three and reads as a bug. The note goes on a
    // wrapping group rather than inside the <text>, because `setText` writes
    // `textContent` and would erase a child <title> on the first tick.
    const tokensBNote = svg('title');
    setText(tokensBNote, cacheReadNote());
    const tokensBGroup = svg('g');
    tokensBGroup.append(tokensBNote, tokensB);

    /*
     * WP3'. The one line on the card whose source is optional: what this run
     * has cost and how full its context window is, both from the status-line
     * capture. It sits in the gap the header already had between the counters
     * and the rule, so a machine without the wrapper loses a line rather than
     * gaining an empty one, and no card changes size either way.
     *
     * WP4e split it in two — `cost $9.60` at the left margin, `context 54 %`
     * against the right one — so each is a labelled fact rather than half of a
     * cryptic string. They share the line because taking a row each would grow
     * every card on every machine to make room for something most machines do
     * not have.
     */
    const cost = svg('text', 'nz-session__cost');
    setAttr(cost, 'x', CARD.pad);
    setAttr(cost, 'y', 182);

    const context = svg('text', 'nz-session__context');
    setAttr(context, 'y', 182);

    /*
     * WP4f. The sentence that takes the same line when there is nothing to put
     * on it *and* a reason for that. The explanation and the fix are in the
     * tooltip rather than on the card: the line has room for one clause, and
     * the second one is a file path the user has to go and edit.
     */
    const blocked = svg('text', 'nz-session__blocked');
    setAttr(blocked, 'x', CARD.pad);
    setAttr(blocked, 'y', 182);
    const blockedNote = svg('title');
    setText(blockedNote, captureBlockedNote());
    const blockedGroup = svg('g');
    blockedGroup.append(blockedNote, blocked);

    const rule = svg('line', 'nz-rule');
    setAttr(rule, 'x1', 0);
    setAttr(rule, 'y1', 0);
    setAttr(rule, 'y2', 0);
    const ruleGroup = svg('g');
    setAttr(ruleGroup, 'transform', `translate(${CARD.pad},188)`);
    const treeLabel = svg('text', 'nz-tree__label');
    setAttr(treeLabel, 'x', CHEVRON + 6);
    setAttr(treeLabel, 'y', 15);
    ruleGroup.append(rule, treeLabel);

    // The chip that offers the cleared subagents back. Its own group, so it can
    // sit on the rule line without being inside the group that draws the rule.
    const hiddenRow = svg('g', 'nz-hidden');
    setAttr(hiddenRow, 'transform', `translate(${CARD.pad},191)`);
    const hiddenChip = makeChip(hiddenRow, 'hidden');
    hiddenChip.g.dataset['action'] = 'restore';
    hiddenChip.g.setAttribute('role', 'button');
    hiddenChip.g.setAttribute('tabindex', '0');
    setAttr(hiddenChip.g, 'display', 'none');

    // Folded state: the chips that stand in for sixty nodes.
    const summary = svg('g', 'nz-summary');
    setAttr(summary, 'transform', `translate(${CARD.pad},${CARD.headerHeight + 8})`);
    const summaryChipEls = [
      makeChip(summary, 'count'),
      makeChip(summary, 'running'),
      makeChip(summary, 'done'),
      makeChip(summary, 'unknown'),
    ];

    /*
     * The drag handle. It sits above the header text so a press anywhere in the
     * title area moves the card, and below the two buttons so those still take
     * their own clicks. Everything under it keeps panning the canvas, which is
     * the gesture people already have in their hands.
     */
    const handle = svg('rect', 'nz-session__handle');
    setAttr(handle, 'x', 0);
    setAttr(handle, 'y', 0);
    setAttr(handle, 'height', HANDLE_HEIGHT);
    setAttr(handle, 'rx', CARD.radius);
    handle.dataset['drag'] = 'card';

    const chevron = svg('g', 'nz-chevron');
    setAttr(chevron, 'transform', `translate(${CARD.pad},191)`);
    chevron.dataset['action'] = 'collapse';
    chevron.setAttribute('role', 'button');
    chevron.setAttribute('tabindex', '0');
    const chevronHit = svg('rect', 'nz-chevron__hit');
    setAttr(chevronHit, 'width', CHEVRON);
    setAttr(chevronHit, 'height', CHEVRON);
    setAttr(chevronHit, 'rx', 5);
    const chevronPath = svg('path', 'nz-chevron__mark');
    chevron.append(chevronHit, chevronPath);

    const menu = svg('g', 'nz-cardmenu');
    menu.dataset['action'] = 'menu';
    menu.setAttribute('role', 'button');
    menu.setAttribute('tabindex', '0');
    menu.setAttribute('aria-haspopup', 'menu');
    menu.setAttribute('aria-label', t('card.menuLabel'));
    const menuHit = svg('rect', 'nz-cardmenu__hit');
    setAttr(menuHit, 'width', MENU_SIZE);
    setAttr(menuHit, 'height', MENU_SIZE);
    setAttr(menuHit, 'rx', 6);
    menu.append(menuHit);
    for (const cx of [6, 11, 16]) {
      const dot = svg('circle', 'nz-cardmenu__dot');
      setAttr(dot, 'cx', cx);
      setAttr(dot, 'cy', MENU_SIZE / 2);
      setAttr(dot, 'r', 1.6);
      menu.append(dot);
    }

    const edges = svg('g', 'nz-edges');
    const treeGroup = svg('g', 'nz-tree');
    const card = svg('g', 'nz-session__card');

    /*
     * WP4f, widened to eight in N-WP10: four edge strips and four corners.
     *
     * Last children of the card, and that is the whole of their z-ordering
     * story: the drag handle covers the top of the card and the tree covers the
     * bottom of it, so a grip that was not on top of both would be a control
     * you can see and cannot press. `pointerdown` in `app.ts` looks for
     * `[data-resize]` before `[data-drag]` for the same reason.
     *
     * Within the group the four edges are appended before the four corners, so
     * where a corner overlaps an edge the corner takes the press. `HANDLES` is
     * in that order and this loop does not reorder it.
     */
    const resize = svg('g', 'nz-resize');
    const grips = HANDLES.map((handle) => {
      const edge = handle.length === 1;
      const grip = svg(
        'rect',
        `nz-resize__grip nz-resize__grip--${handle}${edge ? ' nz-resize__grip--edge' : ''}`,
      );
      const rect = handleRect(handle, { width: 0, height: 0 });
      setAttr(grip, 'width', rect.width);
      setAttr(grip, 'height', rect.height);
      setAttr(grip, 'rx', edge ? 0 : 4);
      grip.dataset['resize'] = handle;
      const note = svg('title');
      setText(note, edge ? resizeEdgeNote() : resizeNote());
      grip.append(note);
      resize.append(grip);
      return grip;
    });

    card.append(
      bg,
      badgeFallback,
      badge,
      ringPulse,
      ring,
      title,
      path,
      identity,
      activity,
      chipRow,
      meta,
      tokensA,
      tokensBGroup,
      cost,
      context,
      blockedGroup,
      ruleGroup,
      hiddenRow,
      summary,
      handle,
      nameHit,
      chevron,
      menu,
      edges,
      treeGroup,
      resize,
    );
    g.append(card);
    this.root.append(g);

    const els: SessionEls = {
      g,
      card,
      bg,
      badge,
      badgeFallback,
      ring,
      ringPulse,
      title,
      path,
      identity,
      activity,
      chipRow,
      modelChip: modelChipEls,
      effortChip: effortChipEls,
      statusChip: statusChipEls,
      meta,
      tokensA,
      tokensB,
      cost,
      context,
      treeLabel,
      rule,
      handle,
      nameHit,
      nameNote,
      chevron,
      chevronPath,
      menu,
      summary,
      summaryChips: summaryChipEls,
      hiddenChip,
      blocked,
      edges,
      treeGroup,
      grips,
      agents: new Map(),
      edgePaths: new Map(),
    };
    this.sessions.set(session.id, els);
    return els;
  }

  private createAgent(sessionId: string, agentId: string): AgentEls {
    const g = svg('g', 'nz-agent');
    g.dataset['sessionId'] = sessionId;
    g.dataset['agentId'] = agentId;
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'group');

    const bg = svg('rect', 'nz-agent__bg');
    setAttr(bg, 'rx', AGENT.radius);
    setAttr(bg, 'width', AGENT.width);
    setAttr(bg, 'height', AGENT.height);

    const dot = svg('circle', 'nz-agent__dot');
    setAttr(dot, 'cx', AGENT.width - 13);
    setAttr(dot, 'cy', 15);
    setAttr(dot, 'r', 4.5);

    const type = svg('text', 'nz-agent__type');
    setAttr(type, 'x', 10);
    setAttr(type, 'y', 20);

    const model = svg('text', 'nz-agent__line');
    setAttr(model, 'x', 10);
    setAttr(model, 'y', 37);

    const meta = svg('text', 'nz-agent__line');
    setAttr(meta, 'x', 10);
    setAttr(meta, 'y', 52);

    // Occupies the same line as `meta`, and exactly one of the two is drawn.
    const chipRow = svg('g', 'nz-agent__chips');
    setAttr(chipRow, 'transform', 'translate(0,42)');
    const doneChip = makeChip(chipRow, 'done');
    setAttr(doneChip.g, 'display', 'none');

    const tokensA = svg('text', 'nz-agent__tokens');
    setAttr(tokensA, 'x', 10);
    setAttr(tokensA, 'y', 68);

    const tokensB = svg('text', 'nz-agent__tokens');
    setAttr(tokensB, 'x', 10);
    setAttr(tokensB, 'y', 82);

    // The sixth line: the word for the frame colour on the left, and the
    // `orphan` marker — which used to sit on top of the counters — on the
    // right, where it now has a line of its own to be read on.
    const activity = svg('text', 'nz-agent__activity');
    setAttr(activity, 'x', 10);
    setAttr(activity, 'y', 97);

    const orphan = svg('text', 'nz-agent__orphan');
    setAttr(orphan, 'x', AGENT.width - 10);
    setAttr(orphan, 'y', 97);

    g.append(bg, dot, type, model, meta, chipRow, tokensA, tokensB, activity, orphan);

    return { g, bg, dot, type, model, meta, doneChip, tokensA, tokensB, activity, orphan };
  }
}

/** A session the user has to answer. The loudest thing the canvas can say. */
export function isWaiting(session: SessionView): boolean {
  return session.status === 'waiting' || session.waitingFor !== undefined;
}
