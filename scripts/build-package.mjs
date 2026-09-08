/**
 * Turn the workspace into the thing npm publishes.
 *
 * The three workspace packages are `private` and are never published on their
 * own, so an installed `@xfurqan0/nazar` has no `@nazar/core` to resolve. The
 * simplest layout that survives a fresh `npm cache clean` on Windows, macOS and
 * Linux is therefore **one bundled entry plus the static canvas**:
 *
 *     dist/nazar.mjs   the server, the core and the canvas maths, one ES module
 *     dist/web/        index.html, bundle.js, styles.css, assets/
 *
 * `bin/nazar.mjs` picks the first of those up; `resolveUiDir()` finds `web/`
 * sitting next to the bundle. Nothing in the tarball depends on a link, a
 * workspace, or a package manager's layout, and because Nazar has zero runtime
 * dependencies the bundle is closed: the only imports left in it are Node
 * builtins, which this script asserts before it finishes.
 *
 * Run after `npm run build`; `prepack` does both in order.
 */
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as esbuild from 'esbuild';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'dist');
const entry = path.join(root, 'packages', 'server', 'dist', 'cli.js');
const uiWeb = path.join(root, 'packages', 'ui', 'dist', 'web');

/** Fail loudly rather than publishing half a package. */
async function require(target, hint) {
  try {
    await stat(target);
  } catch {
    throw new Error(`${path.relative(root, target)} is missing. ${hint}`);
  }
}

async function main() {
  await require(entry, 'Run "npm run build" first.');
  await require(path.join(uiWeb, 'index.html'), 'Run "npm run build" first.');

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const result = await esbuild.build({
    entryPoints: [entry],
    outfile: path.join(outDir, 'nazar.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node22'],
    // Readable on purpose, like the browser bundle: a tool that watches your
    // agents should be something you can open and check.
    minify: false,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
    metafile: true,
    banner: {
      js: '// @xfurqan0/nazar — bundled from packages/{core,server,ui}. Sources: https://github.com/xfurqan0/nazar',
    },
  });

  // The zero-runtime-dependency claim, checked rather than asserted: after
  // bundling, every import left must be a Node builtin.
  const outputs = Object.values(result.metafile.outputs);
  const bundle = outputs[0];
  const external = (bundle?.imports ?? [])
    .filter((entryPoint) => entryPoint.external)
    .map((entryPoint) => entryPoint.path)
    .filter((specifier) => !specifier.startsWith('node:'));
  if (external.length > 0) {
    throw new Error(`the bundle imports non-builtin modules: ${external.join(', ')}`);
  }

  await cp(uiWeb, path.join(outDir, 'web'), { recursive: true });

  // The bundle reads `../package.json` for its version, which in this layout is
  // the published manifest one directory up. That is a property of where the
  // file lands, so it is checked by loading the bundle and asking it, not by
  // reading the source: importing it runs declarations only, no server.
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const loaded = await import(pathToFileURL(path.join(outDir, 'nazar.mjs')).href);
  if (loaded.VERSION !== manifest.version) {
    throw new Error(
      `the bundle reports version ${String(loaded.VERSION)}, the manifest says ${manifest.version}`,
    );
  }

  // A marker the pack smoke test can assert on without parsing JavaScript.
  await writeFile(
    path.join(outDir, 'BUILD.txt'),
    `@xfurqan0/nazar ${manifest.version}\nbuilt from packages/{core,server,ui}\n`,
    'utf8',
  );

  const kb = (bundle?.bytes ?? 0) / 1024;
  process.stdout.write(
    `package: dist/nazar.mjs ${kb.toFixed(1)} KB · dist/web copied · 0 runtime imports outside node:\n`,
  );
}

await main();
