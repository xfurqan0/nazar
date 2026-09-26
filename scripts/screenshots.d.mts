/**
 * Types for `screenshots.mjs`, so `test/canvas-boot.test.ts` can drive a
 * browser with the same client the screenshots and the tour use.
 *
 * The script stays plain JavaScript: it is a command a maintainer types, and
 * `tour.mjs` imports it as one. This declares what the test reaches for and
 * nothing more.
 */
import type { ChildProcess } from 'node:child_process';

/** A DevTools protocol client over one socket, with flat sessions. */
export class Cdp {
  static connect(url: string): Promise<Cdp>;
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any>;
  on(method: string, sessionId: string | undefined, handler: (params: any) => void): () => void;
  once(method: string, sessionId: string | undefined, timeout: number): Promise<any>;
  close(): void;
}

/** Evaluate an expression in a page; a thrown exception is re-thrown here. */
export function evaluate(
  cdp: Cdp,
  session: string,
  expression: string,
  options?: { awaitPromise?: boolean },
): Promise<any>;

/** The installed Chrome or Edge, or a thrown error listing where it looked. */
export function findBrowser(override?: string): string;

/** A port nothing is listening on. */
export function freePort(): Promise<number>;

/** `bin/nazar.mjs` on `port`, with `env` laid over the inherited environment. */
export function startServer(
  port: number,
  env?: Record<string, string>,
): Promise<{ child: ChildProcess; origin: string }>;

/** A headless browser on its own profile, and its DevTools endpoint. */
export function startBrowser(
  executable: string,
  profile: string,
): Promise<{ child: ChildProcess; endpoint: string }>;
