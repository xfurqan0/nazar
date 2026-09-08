/**
 * WP4: the local server. Static canvas, one JSON snapshot, one SSE stream, and
 * nothing else.
 *
 * Three properties this file exists to guarantee:
 *
 * - **It is not reachable from anywhere but this machine.** The listener binds
 *   127.0.0.1, and every request is checked against a small allow-list of Host
 *   headers so a page on the open internet cannot point a DNS name at
 *   127.0.0.1 and read the canvas through the browser (DNS rebinding).
 * - **It serves files, it does not accept them.** Only `GET` and `HEAD`; any
 *   path that escapes the UI directory is a 404, not a 403, so probing tells
 *   an attacker nothing.
 * - **Nothing is fetched from the network by the page.** A strict
 *   `Content-Security-Policy` on the document turns "no CDN, no web fonts" from
 *   a convention into something the browser enforces.
 *
 * The SSE channel pushes whole snapshots, never deltas: a browser that
 * reconnects after a laptop lid closes is correct on its first frame without
 * replaying anything, which is also why there is no `Last-Event-ID` handling.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import path from 'node:path';

import type { History, HistoryListOptions, HistoryListPage, StateSnapshot } from '@nazar/core';

import type { RedactOptions } from './redact.js';
import { toWireHistory, toWireHistoryPage, toWireState } from './snapshot.js';
import { VERSION, VERSION_HEADER } from './version.js';

/** Address the server binds. Never configurable: local only, by design. */
export const HOST = '127.0.0.1';

/** How often a comment frame is written to keep proxies and NATs from idling. */
export const DEFAULT_HEARTBEAT_MS = 15_000;

/** What the SSE client is told to wait before reconnecting, in milliseconds. */
export const SSE_RETRY_MS = 3000;

/**
 * The part of `NazarState` the server uses. Structural, so a test can hand in
 * a plain object and never start a watcher.
 */
export interface StateSource {
  snapshot(): StateSnapshot;
  on(event: 'change', listener: (snapshot: StateSnapshot) => void): unknown;
  off(event: 'change', listener: (snapshot: StateSnapshot) => void): unknown;
}

/**
 * The part of `HistoryScanner` the server uses (WP4b). Structural, so a test
 * can hand in a plain object and never touch the real transcript store.
 */
export interface HistorySource {
  list(options?: HistoryListOptions): Promise<HistoryListPage>;
  open(sessionId: string): Promise<History | undefined>;
}

/**
 * A session id in a URL. Claude Code writes uuids, but the route never builds
 * a path from this value — it looks the id up in the scanner's index — so the
 * check is a cheap sanity gate rather than the traversal defence.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;

/** Sessions per page when the query string does not say. */
const DEFAULT_HISTORY_LIMIT = 50;

export interface NazarServerOptions {
  readonly state: StateSource;
  /** Directory holding `index.html`, `bundle.js`, `styles.css` and `assets/`. */
  readonly uiDir: string;
  /** Past sessions. Omitted in tests that only exercise the live canvas. */
  readonly history?: HistorySource;
  /** 0 asks the OS for a free port, which is what the tests do. */
  readonly port?: number;
  readonly heartbeatMs?: number;
  readonly redact?: RedactOptions;
}

export interface NazarServer {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
  /** Ends every SSE connection, then closes the listener. */
  close(): Promise<void>;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Everything the page is allowed to do. `'self'` only: no CDN, no web font, no
 * inline script. `connect-src` covers `fetch` and `EventSource`.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * A `Host` header that can only mean "this machine". Anything else is a
 * rebinding attempt or a proxy we did not ask for.
 */
export function isLocalHost(header: string | undefined, port: number): boolean {
  if (header === undefined) return false;
  const lower = header.toLowerCase();
  const allowed = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
    '127.0.0.1',
    'localhost',
    '[::1]',
  ]);
  return allowed.has(lower);
}

/**
 * Turn a request path into an absolute file under `root`, or `undefined` when
 * it escapes. Percent-escapes are decoded first so `%2e%2e` is caught, and a
 * null byte or a decode failure is rejected outright.
 */
export function resolveStaticPath(root: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0')) return undefined;

  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  if (relative.length === 0) return undefined;

  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relative);
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (target !== resolvedRoot && !target.startsWith(prefix)) return undefined;
  return target;
}

function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * The headers every response carries, whatever it is.
 *
 * {@link VERSION_HEADER} is here rather than on `/api/state` alone because a
 * caller identifying the listener should not have to know which route to ask.
 * It says which build answered and nothing about the machine — the desktop
 * shell reads it to decide whether the server already listening on its stored
 * port is a Nazar it can reuse, and a version number is the whole of what that
 * decision needs.
 */
function baseHeaders(): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    [VERSION_HEADER]: VERSION,
  };
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { ...baseHeaders(), 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    ...baseHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** A non-negative integer from a query string, or `undefined`. */
function intQuery(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  if (raw === null || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Build the listener. Exported so the route tests can drive it without a
 * socket, and so `startNazarServer` stays a three-line wrapper.
 */
export function createRequestListener(
  options: NazarServerOptions,
  portRef: { port: number },
): (req: IncomingMessage, res: ServerResponse) => void {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const redactOptions = options.redact;

  const wire = (): string =>
    JSON.stringify(toWireState(options.state.snapshot(), redactOptions));

  const serveStatic = (req: IncomingMessage, res: ServerResponse, urlPath: string): void => {
    const file = resolveStaticPath(options.uiDir, urlPath);
    if (file === undefined) {
      sendText(res, 404, 'not found\n');
      return;
    }

    void stat(file).then(
      (info) => {
        if (!info.isFile()) {
          sendText(res, 404, 'not found\n');
          return;
        }
        const headers: Record<string, string> = {
          ...baseHeaders(),
          'Content-Type': contentTypeFor(file),
          'Content-Length': String(info.size),
        };
        if (file.endsWith('.html')) headers['Content-Security-Policy'] = CSP;
        res.writeHead(200, headers);
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        const stream = createReadStream(file);
        stream.on('error', () => {
          res.destroy();
        });
        stream.pipe(res);
      },
      () => {
        sendText(res, 404, 'not found\n');
      },
    );
  };

  const serveEvents = (req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, {
      ...baseHeaders(),
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
      // Nothing between the browser and this process should buffer the stream.
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: ${SSE_RETRY_MS}\n\n`);
    // The first frame is the whole state, so a reconnecting client is correct
    // immediately and never has to ask for a snapshot separately.
    res.write(`event: state\ndata: ${wire()}\n\n`);

    const onChange = (): void => {
      res.write(`event: state\ndata: ${wire()}\n\n`);
    };
    options.state.on('change', onChange);

    const beat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, heartbeatMs);
    beat.unref?.();

    const stop = (): void => {
      clearInterval(beat);
      options.state.off('change', onChange);
    };
    res.on('close', stop);
    res.on('error', stop);
    req.on('error', stop);
  };

  /**
   * WP4b. Two routes, both read-only and both lazy: the listing opens no
   * transcript at all, and a session is parsed only when this route is asked
   * for it by id.
   */
  const serveHistory = (
    req: IncomingMessage,
    res: ServerResponse,
    urlPath: string,
    query: URLSearchParams,
  ): void => {
    const source = options.history;
    if (source === undefined) {
      sendText(res, 404, 'not found\n');
      return;
    }

    const rest = urlPath.slice('/api/history'.length);
    const failed = (): void => {
      // A transcript that vanished mid-read is not a server error worth a 500:
      // the listing is a view of a directory that Claude Code owns.
      sendText(res, 503, 'the transcript store could not be read\n');
    };

    if (rest === '' || rest === '/') {
      const listOptions: {
        -readonly [K in keyof HistoryListOptions]: HistoryListOptions[K];
      } = { limit: intQuery(query, 'limit') ?? DEFAULT_HISTORY_LIMIT };
      const offset = intQuery(query, 'offset');
      if (offset !== undefined) listOptions.offset = offset;
      const project = query.get('project');
      if (project !== null && project.length > 0) listOptions.project = project;

      void source.list(listOptions).then(
        (page) => sendJson(req, res, 200, JSON.stringify(toWireHistoryPage(page, redactOptions))),
        failed,
      );
      return;
    }

    const sessionId = rest.startsWith('/') ? rest.slice(1) : undefined;
    if (sessionId === undefined || !SESSION_ID_PATTERN.test(sessionId)) {
      sendText(res, 404, 'not found\n');
      return;
    }

    void source.open(sessionId).then((history) => {
      if (history === undefined) {
        sendText(res, 404, 'not found\n');
        return;
      }
      sendJson(req, res, 200, JSON.stringify(toWireHistory(history, redactOptions)));
    }, failed);
  };

  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...baseHeaders(), Allow: 'GET, HEAD' });
      res.end();
      return;
    }

    if (!isLocalHost(req.headers.host, portRef.port)) {
      sendText(res, 403, 'nazar serves 127.0.0.1 only\n');
      return;
    }

    const raw = req.url ?? '/';
    const split = raw.indexOf('?');
    const urlPath = split === -1 ? raw : raw.slice(0, split);
    const query = new URLSearchParams(split === -1 ? '' : raw.slice(split + 1));

    if (urlPath === '/api/history' || urlPath.startsWith('/api/history/')) {
      serveHistory(req, res, urlPath, query);
      return;
    }

    if (urlPath === '/api/state') {
      sendJson(req, res, 200, wire());
      return;
    }

    if (urlPath === '/api/events') {
      if (req.method === 'HEAD') {
        res.writeHead(200, { ...baseHeaders(), 'Content-Type': 'text/event-stream; charset=utf-8' });
        res.end();
        return;
      }
      serveEvents(req, res);
      return;
    }

    if (urlPath.startsWith('/api/')) {
      sendText(res, 404, 'not found\n');
      return;
    }

    serveStatic(req, res, urlPath);
  };
}

/** Bind the listener to 127.0.0.1 and resolve once it is accepting. */
export async function startNazarServer(options: NazarServerOptions): Promise<NazarServer> {
  const portRef = { port: options.port ?? 0 };
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer(createRequestListener(options, portRef));

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(portRef.port, HOST);
  });

  const address = server.address();
  portRef.port = typeof address === 'object' && address !== null ? address.port : portRef.port;

  return {
    server,
    port: portRef.port,
    url: `http://${HOST}:${portRef.port}/`,
    close: async () => {
      // An open SSE response keeps its socket alive forever, so the streams are
      // torn down first; `server.close()` alone would never resolve.
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
