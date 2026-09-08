/**
 * Pure layout maths for the canvas. No DOM, no SVG strings here, so every
 * rule stays testable in Node.
 *
 * Three things live in this file:
 *
 * - **`layerTree`**: the per-session subagent tree, layered top-down and
 *   *wrapped* at a width cap. Depth comes from the tree the core builder
 *   produced; horizontal placement is one pass of the classic rule (leaves take
 *   the next free slot, a parent sits over the middle of its children) with the
 *   one addition WP4c had to make: a row of siblings that would run past the cap
 *   wraps onto another row, at **every** level rather than only at the roots.
 *   It returns the edge polylines as well as the nodes, so "no connector leaves
 *   the card" is arithmetic the tests can check rather than something the
 *   renderer has to be trusted about.
 * - **`cardSize`**: the card's own box, derived from the bounding box of the
 *   tree it has to contain. This is the WP4c bug fix: the card used to be sized
 *   by how many columns happened to fit the browser window, so a narrow window
 *   drew a card too small for its own tree.
 * - **`zoomAt`**: the wheel-zoom arithmetic, kept out of the event handler so
 *   "the point under the cursor does not move" is a test and not a hope.
 *
 * Free placement of the cards themselves lives next door in `pack.ts`.
 */

/** A point in canvas coordinates. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** An axis-aligned box, as two corners rather than an origin and a size. */
export interface Box {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** The box that contains every point given. Empty input is a zero box. */
export function boundsOf(points: readonly Point[]): Box {
  if (points.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  return { minX, minY, maxX, maxY };
}

/* ------------------------------------------------------------------ *
 * Subagent tree
 * ------------------------------------------------------------------ */

/** The shape `layerTree` needs. `AgentNode` from `@nazar/core` satisfies it. */
export interface TreeInput {
  readonly id: string;
  readonly children: readonly TreeInput[];
}

export interface TreeSpec {
  readonly nodeWidth: number;
  readonly nodeHeight: number;
  /** Horizontal gap between two sibling slots. */
  readonly hGap: number;
  /** Vertical gap between one depth and the next. */
  readonly vGap: number;
  /**
   * Width after which a row of siblings wraps onto another row.
   *
   * A real session holds sixty subagents (measured on the maintainer's
   * machine), which as one row would be ten thousand pixels of card. Without
   * this the card either overflows or the tree has to be scaled down to
   * illegibility.
   *
   * WP4c: this applies at **every** level. Before, only the roots wrapped, and
   * the check skipped the first subtree in a band — so a single agent that
   * spawned twenty children produced a 3,424 px tree inside a 1,128 px card and
   * drew twelve of its nodes outside the frame.
   */
  readonly maxWidth?: number;
}

export interface PlacedTreeNode {
  readonly id: string;
  readonly parentId?: string;
  /** 0 for a session's own children, 1 for their children, and so on. */
  readonly depth: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Centre of the node, which is where an edge attaches. */
  readonly centerX: number;
}

/**
 * One parent-child connector, as the orthogonal polyline it is drawn as.
 *
 * The layout owns the route rather than the renderer, because the route is what
 * decides whether the card is big enough: a connector that leaves the box is
 * exactly the bug WP4c exists to kill, and it can only be measured where the
 * geometry is.
 */
export interface TreeEdge {
  readonly parentId: string;
  readonly childId: string;
  readonly points: readonly Point[];
}

export interface TreeLayout {
  readonly nodes: readonly PlacedTreeNode[];
  readonly edges: readonly TreeEdge[];
  readonly width: number;
  readonly height: number;
  /** Deepest level placed, 0 when the forest is one row of leaves. */
  readonly maxDepth: number;
  /** Every node rectangle and every edge vertex. Starts at the origin. */
  readonly bounds: Box;
}

/** A laid-out subtree in its own coordinates, before it is shifted into place. */
interface Block {
  readonly rootId: string;
  readonly nodes: readonly PlacedTreeNode[];
  readonly edges: readonly TreeEdge[];
  /** Where the root's connector leaves the block, measured from its left edge. */
  readonly rootCenterX: number;
  readonly width: number;
  readonly height: number;
}

interface Row {
  readonly items: { readonly block: Block; readonly x: number }[];
  readonly top: number;
  height: number;
}

/** Move a block's contents; blocks are built at the origin and then placed. */
function shifted(block: Block, dx: number, dy: number): Block {
  return {
    rootId: block.rootId,
    nodes: block.nodes.map((node) => ({
      ...node,
      x: node.x + dx,
      y: node.y + dy,
      centerX: node.centerX + dx,
    })),
    edges: block.edges.map((edge) => ({
      ...edge,
      points: edge.points.map((point) => ({ x: point.x + dx, y: point.y + dy })),
    })),
    rootCenterX: block.rootCenterX + dx,
    width: block.width,
    height: block.height,
  };
}

/**
 * Lay blocks out left to right, wrapping to a new row once the next one would
 * run past `limit`. A block wider than `limit` on its own still gets a row to
 * itself rather than being dropped — but `layoutNode` sizes its children so
 * that cannot happen below the root.
 */
function packBlocks(
  blocks: readonly Block[],
  limit: number,
  hGap: number,
  vGap: number,
): { rows: readonly Row[]; width: number; height: number } {
  const rows: Row[] = [];
  let current: Row = { items: [], top: 0, height: 0 };
  let x = 0;
  let width = 0;

  for (const block of blocks) {
    if (current.items.length > 0 && x + block.width > limit) {
      rows.push(current);
      current = { items: [], top: current.top + current.height + vGap, height: 0 };
      x = 0;
    }
    current.items.push({ block, x });
    width = Math.max(width, x + block.width);
    current.height = Math.max(current.height, block.height);
    x += block.width + hGap;
  }
  if (current.items.length > 0) rows.push(current);

  const last = rows[rows.length - 1];
  return { rows, width, height: last === undefined ? 0 : last.top + last.height };
}

interface BuildState {
  readonly spec: TreeSpec;
  readonly seen: Set<string>;
  maxDepth: number;
}

/**
 * Build one subtree, bottom up.
 *
 * `budget` is the widest the returned block may be. Children are packed at
 * `budget - hGap` so that, when they wrap and need the trunk lane on the left,
 * the lane plus the children still fit inside the budget. That is what makes
 * `layerTree`'s width provably bounded by `maxWidth` at any depth.
 */
function layoutNode(
  node: TreeInput,
  depth: number,
  budget: number,
  state: BuildState,
): Block | undefined {
  if (state.seen.has(node.id)) return undefined;
  state.seen.add(node.id);
  if (depth > state.maxDepth) state.maxDepth = depth;

  const { nodeWidth, nodeHeight, hGap, vGap } = state.spec;
  const childBudget = Math.max(nodeWidth, budget - hGap);

  const childBlocks: Block[] = [];
  for (const child of node.children) {
    const block = layoutNode(child, depth + 1, childBudget, state);
    if (block !== undefined) childBlocks.push(block);
  }

  if (childBlocks.length === 0) {
    // A node whose children were all duplicates becomes a leaf, which is the
    // only sane reading of a directory that repeats an agent id.
    return {
      rootId: node.id,
      nodes: [
        { id: node.id, depth, x: 0, y: 0, width: nodeWidth, height: nodeHeight, centerX: nodeWidth / 2 },
      ],
      edges: [],
      rootCenterX: nodeWidth / 2,
      width: nodeWidth,
      height: nodeHeight,
    };
  }

  const packed = packBlocks(childBlocks, childBudget, hGap, vGap);
  // Wrapped children need a clear vertical lane on the left for the trunk that
  // reaches the second row and below. One gap is enough and it is empty by
  // construction, so no connector ever crosses a node.
  const gutter = packed.rows.length > 1 ? hGap : 0;
  const trunkX = gutter / 2;
  const childTop = nodeHeight + vGap;
  const firstBusY = childTop - vGap / 2;
  const rootCenterX = gutter + packed.width / 2;

  const nodes: PlacedTreeNode[] = [
    {
      id: node.id,
      depth,
      x: rootCenterX - nodeWidth / 2,
      y: 0,
      width: nodeWidth,
      height: nodeHeight,
      centerX: rootCenterX,
    },
  ];
  const edges: TreeEdge[] = [];

  for (const [index, row] of packed.rows.entries()) {
    const rowTop = childTop + row.top;
    const busY = rowTop - vGap / 2;
    for (const item of row.items) {
      const placed = shifted(item.block, gutter + item.x, rowTop);
      for (const child of placed.nodes) {
        nodes.push(child.id === placed.rootId ? { ...child, parentId: node.id } : child);
      }
      edges.push(...placed.edges);
      edges.push({
        parentId: node.id,
        childId: placed.rootId,
        points:
          index === 0
            ? [
                { x: rootCenterX, y: nodeHeight },
                { x: rootCenterX, y: busY },
                { x: placed.rootCenterX, y: busY },
                { x: placed.rootCenterX, y: rowTop },
              ]
            : [
                { x: rootCenterX, y: nodeHeight },
                { x: rootCenterX, y: firstBusY },
                { x: trunkX, y: firstBusY },
                { x: trunkX, y: busY },
                { x: placed.rootCenterX, y: busY },
                { x: placed.rootCenterX, y: rowTop },
              ],
      });
    }
  }

  return {
    rootId: node.id,
    nodes,
    edges,
    rootCenterX,
    width: Math.max(gutter + packed.width, rootCenterX + nodeWidth / 2),
    height: childTop + packed.height,
  };
}

/**
 * Lay a forest out top-down.
 *
 * Every node in one row of siblings shares a `y`, which is what makes the
 * result read as a tree rather than as a pile; a row that would run past
 * `maxWidth` wraps, and the connectors into the wrapped rows are routed down a
 * reserved lane on the left rather than straight through the row above. Cycles
 * cannot occur (the core tree builder breaks them before this ever sees them)
 * but a repeated id is still guarded against, because a malformed directory
 * must not hang the canvas.
 */
export function layerTree(roots: readonly TreeInput[], spec: TreeSpec): TreeLayout {
  const state: BuildState = { spec, seen: new Set<string>(), maxDepth: 0 };
  const limit = Math.max(spec.nodeWidth, spec.maxWidth ?? Number.POSITIVE_INFINITY);

  const blocks: Block[] = [];
  for (const root of roots) {
    const block = layoutNode(root, 0, limit, state);
    if (block !== undefined) blocks.push(block);
  }

  const nodes: PlacedTreeNode[] = [];
  const edges: TreeEdge[] = [];
  const packed = packBlocks(blocks, limit, spec.hGap, spec.vGap);
  for (const row of packed.rows) {
    for (const item of row.items) {
      const placed = shifted(item.block, item.x, row.top);
      nodes.push(...placed.nodes);
      edges.push(...placed.edges);
    }
  }

  const corners: Point[] = [];
  for (const node of nodes) {
    corners.push({ x: node.x, y: node.y }, { x: node.x + node.width, y: node.y + node.height });
  }
  for (const edge of edges) corners.push(...edge.points);

  return {
    nodes,
    edges,
    width: nodes.length === 0 ? 0 : packed.width,
    height: nodes.length === 0 ? 0 : packed.height,
    maxDepth: state.maxDepth,
    bounds: boundsOf(corners),
  };
}

/** The `d` attribute for an edge. Every segment is axis-aligned by design. */
export function edgePath(edge: TreeEdge): string {
  return edge.points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${round(point.x)} ${round(point.y)}`)
    .join(' ');
}

function round(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/* ------------------------------------------------------------------ *
 * The session card
 * ------------------------------------------------------------------ */

/**
 * Card geometry.
 *
 * `column`/`gap` only decide what widths a card is allowed to snap to; nothing
 * about *where* cards go depends on them any more (that is `pack.ts`). Snapping
 * to whole columns is kept because a canvas of cards on three or four discrete
 * widths reads as a set, and because it makes the card width a function of the
 * session alone — never of the browser window, which is what broke.
 */
export interface CardSpec {
  readonly column: number;
  readonly gap: number;
  readonly pad: number;
  readonly headerHeight: number;
  /** Height of the tree strip when a session has no subagents at all. */
  readonly emptyTreeHeight: number;
  /** Height of the summary strip when the tree is collapsed. */
  readonly collapsedHeight: number;
  readonly maxColumns: number;
}

export interface CardBox {
  readonly width: number;
  readonly height: number;
  /**
   * N-WP10: the height this card's own contents need, before any height the
   * user dragged to is applied.
   *
   * `height` is what the card is drawn at; `contentHeight` is the floor it may
   * never go under — the header plus the tree as it wraps at this width.
   * Without a dragged height the two are the same number, which is every card
   * before N-WP10 and every card that has only ever been resized sideways.
   */
  readonly contentHeight: number;
  /** Top-left of the tree inside the card. */
  readonly treeOriginX: number;
  readonly treeOriginY: number;
  readonly innerWidth: number;
  readonly columns: number;
}

/** The widest a tree may be laid out before it must wrap. */
export function treeMaxWidth(spec: CardSpec): number {
  return spec.maxColumns * spec.column + (spec.maxColumns - 1) * spec.gap - spec.pad * 2;
}

/* ------------------------------------------------------------------ *
 * WP4f: a width the user dragged to
 * ------------------------------------------------------------------ */

/**
 * The narrowest a card may be dragged, whatever its tree says.
 *
 * A card is not only a frame around a tree: it carries a title, a path, three
 * chips and four counters, and below this width those stop being readable well
 * before the tree does. It is also comfortably wider than one agent node plus
 * both pads, which is what keeps the tree budget from ever falling under a
 * single node.
 */
export const MIN_CARD_WIDTH = 300;

/**
 * The widest a card may be dragged: twice the automatic three-column cap.
 *
 * The cap on the *automatic* width exists because a session with sixty
 * subagents would be ten thousand pixels wide left to itself. A width somebody
 * dragged to is a different thing — they asked for it, and a wider card is
 * exactly how a wide tree is made to stop wrapping — so the ceiling is
 * generous. It is still a ceiling: one accidental drag across three monitors
 * must not leave a card that *Fit* then has to shrink the whole canvas around.
 */
export function maxCardWidth(spec: CardSpec): number {
  return (treeMaxWidth(spec) + spec.pad * 2) * 2;
}

/** An explicit width, held between this tree's own minimum and the ceiling. */
export function clampCardWidth(width: number, minWidth: number, spec: CardSpec): number {
  const min = Math.max(MIN_CARD_WIDTH, minWidth);
  const max = Math.max(min, maxCardWidth(spec));
  if (!Number.isFinite(width)) return min;
  return Math.min(max, Math.max(min, Math.round(width)));
}

/* ------------------------------------------------------------------ *
 * N-WP10: a height the user dragged to
 * ------------------------------------------------------------------ */

/**
 * The shortest a card can be at all: its header and an empty tree strip.
 *
 * A *particular* card is usually taller than this, because the tree it shows
 * has a height of its own; that floor is `CardBox.contentHeight` and it moves
 * with the wrapping. This one does not move, and it is what a dragged height is
 * held against before anything has been measured.
 */
export function minCardHeight(spec: CardSpec): number {
  return spec.headerHeight + spec.emptyTreeHeight;
}

/**
 * The tallest a card may be dragged: twice the width ceiling.
 *
 * Generous for the same reason {@link maxCardWidth} is, and looser than it,
 * because the thing a card runs out of room for stacks downwards — a tree that
 * wraps into eight rows is tall long before it is wide. It is still a ceiling,
 * so one runaway drag cannot leave a card that *Fit* has to frame the canvas
 * around.
 */
export function maxCardHeight(spec: CardSpec): number {
  return maxCardWidth(spec) * 2;
}

/**
 * An explicit height, held between what the card is showing and the ceiling.
 *
 * `minHeight` is the caller's floor — in practice `CardBox.contentHeight`, the
 * header plus the tree as it wraps right now. A card may be made taller than
 * its contents (the room below the tree is simply empty) and never shorter,
 * which is what keeps WP4c's containment rule true on the vertical axis.
 */
export function clampCardHeight(height: number, minHeight: number, spec: CardSpec): number {
  const min = Math.max(minCardHeight(spec), minHeight);
  const max = Math.max(min, maxCardHeight(spec));
  if (!Number.isFinite(height)) return min;
  return Math.min(max, Math.max(min, Math.round(height)));
}

/* ------------------------------------------------------------------ *
 * N-WP10: the eight resize handles
 * ------------------------------------------------------------------ */

/**
 * The eight places a card can be dragged from: four edges, then four corners.
 *
 * The order is the order they are drawn in, and it is the whole of the
 * priority rule — a corner is painted after the two edges it sits between, so
 * a press in the overlap reaches the corner. Nothing else has to arbitrate.
 */
export const RESIZE_HANDLES = ['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se'] as const;

export type ResizeHandle = (typeof RESIZE_HANDLES)[number];

export function isResizeHandle(value: string): value is ResizeHandle {
  return (RESIZE_HANDLES as readonly string[]).includes(value);
}

/** A corner scales both axes together; an edge moves one of them. */
export function isCornerHandle(handle: ResizeHandle): boolean {
  return handle.length === 2;
}

/** True for the handles that grow the card leftwards, so its right edge holds. */
export function pullsWest(handle: ResizeHandle): boolean {
  return handle === 'w' || handle === 'nw' || handle === 'sw';
}

/** True for the handles that grow the card upwards, so its bottom edge holds. */
export function pullsNorth(handle: ResizeHandle): boolean {
  return handle === 'n' || handle === 'nw' || handle === 'ne';
}

/** True for the handles that change the width. The two horizontal edges do not. */
export function changesWidth(handle: ResizeHandle): boolean {
  return handle !== 'n' && handle !== 's';
}

/** True for the handles that change the height. The two vertical edges do not. */
export function changesHeight(handle: ResizeHandle): boolean {
  return handle !== 'w' && handle !== 'e';
}

/** A card's box during a resize: where it is and how big it is. */
export interface ResizeBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The four numbers a resize may not cross, in canvas pixels. */
export interface ResizeBounds {
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly minHeight: number;
  readonly maxHeight: number;
}

/**
 * Where one drag of one handle leaves a card. Pure geometry, no DOM, no state.
 *
 * **Edges move one axis.** North and south change the height only, west and
 * east the width only. The edge *opposite* the one being dragged never moves,
 * which is the only thing that makes a left-edge drag feel like a resize rather
 * than a resize plus a shove: pulling west grows the width and walks `x` back
 * by exactly what it grew, so the right edge sits still.
 *
 * **Corners keep the aspect ratio**, taken from the box at the press. The rule
 * is a projection, not a dominant axis: the pointer's travel is projected onto
 * the diagonal the card started with, and the scale is how far along that
 * diagonal it landed. Two properties fall out of that and both matter under a
 * real hand. Drag *along* the diagonal and the corner stays exactly under the
 * pointer — the projection of a vector onto itself is itself. Drag anywhere
 * else and the card still moves, damped by the cosine, with no seam: a
 * dominant-axis rule has to switch axes somewhere around 45°, and a card that
 * jumps sixteen pixels sideways because the hand wobbled across that line is
 * the bug this avoids.
 *
 * **A bound stops both axes at once.** Clamping is done on the *scale* rather
 * than on the two lengths, so a card that hits its minimum width stops growing
 * taller in the same frame. Clamping the lengths independently is what tears
 * the ratio, and a corner drag whose ratio drifts every time it touches a
 * limit is not a proportional drag.
 *
 * Minimums win over maximums when a box cannot satisfy both, because the
 * minimum is the containment rule and the maximum is only good manners.
 */
export function resizeCard(
  handle: ResizeHandle,
  start: ResizeBox,
  dx: number,
  dy: number,
  bounds: ResizeBounds,
): ResizeBox {
  const west = pullsWest(handle);
  const north = pullsNorth(handle);
  // How far the pressed edge was pulled *away* from the middle of the card, so
  // the four directions can share one set of sums.
  const outX = Number.isFinite(dx) ? (west ? -dx : dx) : 0;
  const outY = Number.isFinite(dy) ? (north ? -dy : dy) : 0;

  const minWidth = Math.max(1, bounds.minWidth);
  const maxWidth = Math.max(minWidth, bounds.maxWidth);
  const minHeight = Math.max(1, bounds.minHeight);
  const maxHeight = Math.max(minHeight, bounds.maxHeight);
  const clamp = (value: number, low: number, high: number): number =>
    Math.min(high, Math.max(low, value));

  const width0 = Math.max(1, start.width);
  const height0 = Math.max(1, start.height);
  let width = start.width;
  let height = start.height;

  if (isCornerHandle(handle)) {
    const diagonal = Math.hypot(width0, height0);
    const along = (outX * width0 + outY * height0) / diagonal;
    const wanted = Math.max(0, (diagonal + along) / diagonal);
    const floor = Math.max(minWidth / width0, minHeight / height0);
    const ceiling = Math.min(maxWidth / width0, maxHeight / height0);
    const scale = clamp(wanted, floor, Math.max(floor, ceiling));
    width = Math.round(width0 * scale);
    height = Math.round(height0 * scale);
  } else if (changesWidth(handle)) {
    width = Math.round(clamp(width0 + outX, minWidth, maxWidth));
  } else {
    height = Math.round(clamp(height0 + outY, minHeight, maxHeight));
  }

  return {
    // Whole pixels: a drag at 0.4x zoom would otherwise write a position with
    // eleven decimal places, which is noise in the file and on the canvas.
    x: west ? Math.round(start.x + (start.width - width)) : Math.round(start.x),
    y: north ? Math.round(start.y + (start.height - height)) : Math.round(start.y),
    width,
    height,
  };
}

/** The smallest box a card may be resized to, and the layout that decided it. */
export interface CardMinimum {
  readonly width: number;
  readonly height: number;
  /** The tree laid out at that width: one subtree per row. */
  readonly tree: TreeLayout;
}

/**
 * How small a card is allowed to get — measured, not guessed.
 *
 * A card's width **is** its tree's wrapping budget, so "how narrow can this
 * card be" is the same question as "what is the narrowest this tree can be laid
 * out at". The answer is the layout at a budget of one node: every subtree
 * takes a row of its own, nothing overflows, and the result is as tall as it is
 * narrow. Anything narrower puts nodes outside their own frame, which is the
 * bug WP4c exists to have killed.
 *
 * The minimum is therefore a property of what is **visible**. A collapsed tree
 * has no nodes to contain and falls to {@link MIN_CARD_WIDTH}; so does a card
 * whose finished agents have been cleared away. That is the whole of "hide some
 * subagents and the card can be made smaller".
 */
export function cardMinimum(
  roots: readonly TreeInput[],
  collapsed: boolean,
  treeSpec: TreeSpec,
  cardSpec: CardSpec,
): CardMinimum {
  const tree =
    collapsed || roots.length === 0
      ? layerTree([], treeSpec)
      : layerTree(roots, { ...treeSpec, maxWidth: treeSpec.nodeWidth });
  const box = cardSize(tree, collapsed, cardSpec, {
    width: Math.max(MIN_CARD_WIDTH, tree.width + cardSpec.pad * 2),
  });
  return { width: box.width, height: box.height, tree };
}

/** What `cardSize` accepts beyond the tree it is sizing around. */
export interface CardSizeOptions {
  /**
   * A width the user dragged this card to.
   *
   * With one present the card is exactly that wide and the column snap is
   * skipped — snapping is what makes an *automatic* width a function of the
   * session rather than of the browser window, and a dragged width is neither.
   * The caller is responsible for having laid the tree out at
   * `width - pad * 2`, which is what keeps the containment rule true.
   */
  readonly width?: number;
  /**
   * N-WP10: a height the user dragged this card to.
   *
   * Taken as a floor and never as a ceiling — the card is drawn at the taller
   * of this and what it has to contain. That asymmetry is the containment rule
   * again: the tree wraps to the width and is then as tall as it is, so a
   * height *under* it would put nodes outside their own frame, while a height
   * over it only leaves empty room at the bottom of the card.
   */
  readonly height?: number;
}

/** How many whole columns a content width needs, never more than the cap. */
export function columnsFor(contentWidth: number, spec: CardSpec): number {
  if (!Number.isInteger(spec.maxColumns) || spec.maxColumns < 1) {
    throw new RangeError(`maxColumns must be a positive integer, got ${spec.maxColumns}`);
  }
  if (!(spec.column > 0)) throw new RangeError(`column must be positive, got ${spec.column}`);
  if (!(contentWidth > spec.column)) return 1;
  const extra = Math.ceil((contentWidth - spec.column) / (spec.column + spec.gap));
  return Math.min(spec.maxColumns, 1 + extra);
}

/**
 * Size a card around the tree it has to contain.
 *
 * The contract, and the whole point of WP4c: for a tree laid out with
 * `maxWidth: treeMaxWidth(spec)`, every node rectangle and every connector
 * vertex lands inside `[pad, width - pad] x [headerHeight, height - pad]`.
 *
 * WP4f generalises the contract rather than weakening it. With an explicit
 * `options.width` the card is that wide and the tree must have been laid out at
 * `width - pad * 2`; the containment rule then holds for the same reason it
 * held before, because it never depended on the *value* of the budget — only on
 * the card being as wide as the budget the tree was wrapped at.
 *
 * N-WP10 adds the other axis and keeps the contract by making the height a
 * floor rather than a value: `max(contentHeight, options.height)`. A card can
 * be dragged taller than its tree — the room shows up under the tree, empty —
 * and can never be dragged shorter than it, so the bottom of the containment
 * rectangle is still `height - pad` and still below every node in it.
 */
export function cardSize(
  tree: { readonly width: number; readonly height: number; readonly nodes: readonly unknown[] },
  collapsed: boolean,
  spec: CardSpec,
  options: CardSizeOptions = {},
): CardBox {
  const explicit = options.width;
  const columns = collapsed ? 1 : columnsFor(explicit ?? tree.width + spec.pad * 2, spec);
  const width =
    explicit === undefined
      ? columns * spec.column + (columns - 1) * spec.gap
      : Math.max(MIN_CARD_WIDTH, Math.round(explicit));
  const innerWidth = width - spec.pad * 2;
  const body = collapsed
    ? spec.collapsedHeight
    : tree.nodes.length === 0
      ? spec.emptyTreeHeight
      : tree.height + spec.pad;

  const contentHeight = spec.headerHeight + body;
  const dragged = options.height;
  const height =
    dragged === undefined || !Number.isFinite(dragged)
      ? contentHeight
      : Math.max(contentHeight, Math.min(maxCardHeight(spec), Math.round(dragged)));

  return {
    width,
    height,
    contentHeight,
    treeOriginX: spec.pad + Math.max(0, (innerWidth - tree.width) / 2),
    treeOriginY: spec.headerHeight,
    innerWidth,
    columns,
  };
}

/* ------------------------------------------------------------------ *
 * Pan and zoom
 * ------------------------------------------------------------------ */

/** Screen = canvas * scale + (x, y). */
export interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

/** Zoom range fixed in the WP4 brief. */
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 3;

export function clampScale(scale: number, min = MIN_SCALE, max = MAX_SCALE): number {
  if (!Number.isFinite(scale)) return min;
  return Math.min(max, Math.max(min, scale));
}

/**
 * Scale by `factor` about a screen point, keeping whatever is under that point
 * exactly where it is. Returns the same object when the scale is already at a
 * limit, so a handler can skip a redraw.
 */
export function zoomAt(
  view: Viewport,
  factor: number,
  screenX: number,
  screenY: number,
  min = MIN_SCALE,
  max = MAX_SCALE,
): Viewport {
  const next = clampScale(view.scale * factor, min, max);
  if (next === view.scale) return view;
  const ratio = next / view.scale;
  return {
    x: screenX - (screenX - view.x) * ratio,
    y: screenY - (screenY - view.y) * ratio,
    scale: next,
  };
}

/** Where a screen point lands in canvas coordinates. */
export function screenToCanvas(view: Viewport, screenX: number, screenY: number): Point {
  return { x: (screenX - view.x) / view.scale, y: (screenY - view.y) / view.scale };
}

/* ------------------------------------------------------------------ *
 * WP4f: the background pattern
 * ------------------------------------------------------------------ */

/** Where the dot pattern has to start, and how big its tile has to be. */
export interface PatternOffset {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

/**
 * Move the background dots with the content instead of with the window.
 *
 * The dots are painted by one `<rect>` that fills the viewport, *outside* the
 * group carrying the pan/zoom transform — which is what kept it cheap and also
 * what made it wrong: the canvas slid underneath a grid that never moved, so a
 * pan read as the cards drifting rather than as the eye travelling. Putting the
 * rect inside the transformed layer would mean resizing it every frame to keep
 * covering the window at any zoom, which is the expensive fix.
 *
 * The cheap fix is this: leave the rect where it is and give the *pattern* the
 * same transform the content has. `patternTransform` maps pattern space into
 * the rect's user space, so `translate(view.x, view.y) scale(view.scale)` puts
 * the tile grid exactly where the canvas grid is — one attribute, once a frame,
 * no re-render and no reflow.
 *
 * The translation is reduced modulo one tile, which is exact rather than
 * approximate: a pattern tiles with period `tile * scale` in user space, so
 * shifting the origin by a whole number of periods cannot change a pixel. It
 * keeps the attribute short and the arithmetic away from the floating-point
 * fringe after a long pan.
 */
export function patternOffset(view: Viewport, tile: number): PatternOffset {
  const scale = Number.isFinite(view.scale) && view.scale > 0 ? view.scale : 1;
  const period = tile * scale;
  const wrap = (value: number): number => {
    if (!Number.isFinite(value) || !(period > 0)) return 0;
    const remainder = value % period;
    // `+ 0` turns the `-0` a negative multiple of the period produces back into
    // a plain zero, so two pans that put the grid in the same place compare
    // equal rather than differing by a sign nothing can see.
    return remainder < 0 ? remainder + period : remainder + 0;
  };
  return { x: wrap(view.x), y: wrap(view.y), scale };
}

/** The `patternTransform` attribute for an offset. Two decimals, like the rest. */
export function patternTransform(offset: PatternOffset): string {
  return `translate(${round(offset.x)} ${round(offset.y)}) scale(${round(offset.scale)})`;
}

/**
 * The view the canvas opens on: full size, at the top, centred horizontally,
 * shrinking only when the content is *wider* than the window.
 *
 * Fitting the height as well would be tidier and worse: a tall column of
 * sessions would open at 60 % and every token count would be unreadable. Being
 * able to see the top of the canvas at full size beats seeing all of it small,
 * and the fit control is one click away for the other case.
 */
export function initialViewport(
  content: Box,
  viewport: { readonly width: number; readonly height: number },
  padding = 32,
  min = MIN_SCALE,
): Viewport {
  const width = content.maxX - content.minX;
  if (width <= 0) return { x: padding, y: padding, scale: 1 };
  const available = Math.max(1, viewport.width - padding * 2);
  const scale = clampScale(Math.min(1, available / width), min, 1);
  return {
    x: (viewport.width - width * scale) / 2 - content.minX * scale,
    y: padding - content.minY * scale,
    scale,
  };
}

/**
 * A viewport that frames a content box inside a screen box.
 *
 * WP4c made this take a box rather than a size: cards can now be dragged to
 * negative coordinates, so "fit" has to know where the content starts and not
 * merely how big it is.
 */
export function fitToBox(
  content: Box,
  viewport: { readonly width: number; readonly height: number },
  padding = 32,
  min = MIN_SCALE,
  max = MAX_SCALE,
): Viewport {
  const width = content.maxX - content.minX;
  const height = content.maxY - content.minY;
  if (width <= 0 || height <= 0) return { x: padding, y: padding, scale: 1 };
  const available = {
    width: Math.max(1, viewport.width - padding * 2),
    height: Math.max(1, viewport.height - padding * 2),
  };
  const scale = clampScale(Math.min(1, available.width / width, available.height / height), min, max);
  return {
    x: (viewport.width - width * scale) / 2 - content.minX * scale,
    y: Math.max(padding, (viewport.height - height * scale) / 2) - content.minY * scale,
    scale,
  };
}
