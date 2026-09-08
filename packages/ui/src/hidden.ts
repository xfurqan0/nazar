/**
 * WP4f: **clear finished subagents**.
 *
 * A long session accumulates finished agents. They are the record of what
 * happened and they are also, after the twentieth of them, the reason the one
 * agent still running is three screens down. So the card gets a way to put them
 * away — and it is *away*, not *gone*: nothing is deleted, nothing is forgotten,
 * and a chip on the card says how many are hidden and brings them back.
 *
 * Three rules shape this file, and each of them is a test next door:
 *
 * 1. **It hides, it does not delete.** The snapshot the server sent is
 *    untouched; this builds a filtered view of it for one frame. The next SSE
 *    frame carries every agent again, and so does the history panel, which
 *    never reads the hidden set at all.
 * 2. **The tree stays a tree.** A finished agent that spawned a *running* one
 *    is not hidden, because hiding it would either orphan its child or take the
 *    child with it. A node goes only when everything under it goes too, which
 *    makes the pruned forest a subforest of the original rather than a
 *    rearrangement of it.
 * 3. **It is pure.** No DOM, no storage, no clock. What is hidden comes in as a
 *    set of ids; what comes out is a session and a count.
 */
import type { Agent, AgentNode, SessionView } from '@nazar/core';
import { tCount } from './i18n.js';

/** Every finished subagent in a session, by id. What *Clear finished* takes. */
export function finishedAgentIds(session: {
  readonly agents: readonly Agent[];
}): string[] {
  return session.agents.filter((agent) => agent.state === 'done').map((agent) => agent.id);
}

/** A session with some agents hidden, and how many actually went. */
export interface HiddenResult {
  readonly session: SessionView;
  /** Agents the card is not drawing. `0` means nothing was hidden. */
  readonly hidden: number;
}

/**
 * Prune a forest bottom-up.
 *
 * A node survives when it is not in `hidden`, **or** when anything under it
 * survives. That is rule 2 above, and it is why this is a fold rather than a
 * filter: the answer for a parent depends on the answers for its children.
 */
function pruneNodes(
  nodes: readonly AgentNode[],
  hidden: ReadonlySet<string>,
  dropped: Set<string>,
): AgentNode[] {
  const kept: AgentNode[] = [];
  for (const node of nodes) {
    const children = pruneNodes(node.children, hidden, dropped);
    if (hidden.has(node.agent.id) && children.length === 0) {
      dropped.add(node.agent.id);
      continue;
    }
    // Identity, element by element, and not merely the length: a subtree three
    // levels down can lose a leaf without this node losing a child, and reusing
    // the old object then hands the renderer the *unpruned* branch back.
    const same =
      children.length === node.children.length &&
      children.every((child, index) => child === node.children[index]);
    kept.push(same ? node : { ...node, children });
  }
  return kept;
}

/**
 * The session as this card should draw it.
 *
 * Returns the session itself when nothing is hidden — same object, so the
 * renderer's diffing sees no change and a card whose menu has never been opened
 * costs exactly what it cost before WP4f.
 */
export function hideAgents(session: SessionView, hidden: ReadonlySet<string>): HiddenResult {
  if (hidden.size === 0) return { session, hidden: 0 };

  const dropped = new Set<string>();
  const roots = pruneNodes(session.roots, hidden, dropped);
  if (dropped.size === 0) return { session, hidden: 0 };

  return {
    session: {
      ...session,
      roots,
      // An agent the tree never carried is left alone. The flat list and the
      // forest are built from the same directory, so that does not happen —
      // but a count that disagreed with the picture would be worse than a
      // slightly conservative filter.
      agents: session.agents.filter((agent) => !dropped.has(agent.id)),
    },
    hidden: dropped.size,
  };
}

/**
 * The chip's own sentence. One place, so the card and its `aria-label` cannot
 * drift apart.
 */
export function hiddenLabel(count: number): string {
  return tCount('card.hiddenChip', count);
}
