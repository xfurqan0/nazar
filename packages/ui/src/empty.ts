/**
 * N-WP20: what an empty canvas says, and why it is not one sentence.
 *
 * For the first five minutes Nazar is a rectangle with nothing in it, and until
 * now it answered that with *no sessions found* and *start `claude` in a
 * terminal* — which is the right advice for exactly one of the three ways a
 * canvas can be empty. On a machine whose `CLAUDE_CONFIG_DIR` had moved, and on
 * one whose session files were all leftovers from runs that ended, the page was
 * confidently telling somebody to do a thing that would not help.
 *
 * `nazar doctor` has always been able to tell those three apart. The server now
 * sends the same verdict (`StateSnapshot.empty`), and this turns it into the two
 * lines the page shows: **why**, and **the one thing to do next**. Split into a
 * pure function rather than written inline in the renderer so the mapping can be
 * driven directly — with a diagnosis, in each of the six languages — instead of
 * being asserted by reading the source of the render loop.
 *
 * The notes are deliberately a separate list. Neither `claude agents` being
 * silent nor the status-line wrapper being absent is *why* the canvas is empty:
 * the first means there is no second opinion on liveness, the second means cost
 * and context will be missing once something does appear. Presenting either as
 * the reason would be the same class of untruth this package exists to remove.
 */
import type { EmptyDiagnosis } from '@nazar/core';

import { t } from './i18n.js';

/** The lines an explained empty canvas shows, in the language now in force. */
export interface EmptyStateLines {
  /** Why there is nothing to draw. One sentence, from the catalogue. */
  readonly why: string;
  /** The single next step. Never advice that does not apply to `why`. */
  readonly next: string;
  /** True but secondary. Empty on a machine with nothing else to report. */
  readonly notes: readonly string[];
}

export function emptyStateLines(diagnosis: EmptyDiagnosis): EmptyStateLines {
  const notes: string[] = [];
  if (!diagnosis.agentsOk) notes.push(t('empty.noteAgents'));
  if (!diagnosis.wrapper) notes.push(t('empty.noteWrapper'));
  return {
    why: t(`empty.why.${diagnosis.reason}`),
    next: t(`empty.next.${diagnosis.reason}`),
    notes,
  };
}
