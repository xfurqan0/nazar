#!/usr/bin/env node
/**
 * The `nazar` executable. It finds the build output and hands over; every line
 * of behaviour lives in packages/server/src/cli.ts.
 *
 * Two layouts have to work from this one file:
 *
 * - **Published tarball** — `dist/nazar.mjs`, one bundled ES module with the
 *   whole server, core and canvas maths inside it. There are no workspace links
 *   in a tarball, so there is nothing else it could import.
 * - **This workspace** — `packages/server/dist/cli.js`, resolved through the
 *   npm workspace links, which is what `npm start` uses so that a source change
 *   needs `npm run build` and not a repack.
 *
 * Anything else is a build that never ran, and saying so beats a stack trace.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.join(here, '..', 'dist', 'nazar.mjs'),
  path.join(here, '..', 'packages', 'server', 'dist', 'cli.js'),
];

const entry = candidates.find((candidate) => existsSync(candidate));
if (entry === undefined) {
  process.stderr.write('nazar: build output is missing. Run "npm run build" first.\n');
  process.exit(1);
}

const cli = await import(pathToFileURL(entry).href);

// `main` resolves once the listener is up; the open server handle is what keeps
// the process alive from there.
process.exitCode = await cli.main(process.argv.slice(2));
