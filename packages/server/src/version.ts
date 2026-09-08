/**
 * The running build's version, in one place.
 *
 * It was a constant inside `cli.ts` until the desktop shell needed to ask a
 * server it did not start whether it was the *same* Nazar (N-WP9, item 1).
 * That answer is served as a response header, which means `http.ts` needs the
 * number too — and `cli.ts` already imports `http.ts`, so leaving it where it
 * was would have made the two modules import each other. A three-line module
 * is the smaller answer than a cycle.
 *
 * `../package.json` is the manifest one directory above this file, which is
 * `packages/server/package.json` in the repository and the published
 * `package.json` in the tarball — the bundle lands in `dist/`, so the relative
 * path resolves to the manifest either way. `scripts/build-package.mjs` checks
 * that by loading the built bundle and comparing what it reports against the
 * manifest, rather than trusting the arithmetic.
 */
import { createRequire } from 'node:module';

const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

/** Version of the running build. */
export const VERSION: string = pkg.version;

/**
 * The header every response carries, so a caller that did not start this
 * process can tell which build answered.
 *
 * The desktop shell is the caller that needs it: it stores the port it chose
 * and, on the next launch, has to decide between reusing a server already
 * listening there and starting one of its own. `GET /api/state` answering
 * proves *something* is serving; this proves it is a Nazar of the same
 * version, which is the difference between reusing a server and pointing a
 * webview at a stranger. The name is not `Server`, because that header is
 * conventionally the software identity of the whole listener and this is one
 * application's own.
 */
export const VERSION_HEADER = 'X-Nazar-Version';
