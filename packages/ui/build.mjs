/**
 * Bundle the canvas.
 *
 * Four steps, in order, each of which can fail the build:
 *
 * 1. type-check `web/` against the DOM lib (its own tsconfig, no Node types);
 * 2. validate both theme files and turn their tokens into CSS custom
 *    properties, so a malformed hex never reaches a browser;
 * 3. bundle `web/app.ts` into one `bundle.js` with esbuild — a **dev**
 *    dependency; nothing it produces has a runtime dependency;
 * 4. copy `index.html` and `assets/` next to it.
 *
 * The output is `dist/web/`, which is the only directory the server serves.
 */
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

import { assertTheme, themeCss } from './dist/theme.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, 'web');
const outDir = path.join(here, 'dist', 'web');
const require = createRequire(import.meta.url);

/**
 * The nazar theme is the default and must come first: `themeCss` writes the
 * first one unscoped and every other under `[data-palette="<name>"]`, which is
 * what the sidebar's theme picker sets. The order here is the order the picker
 * lists them in, and `chrome.test.ts` checks that the two agree.
 */
const THEME_FILES = [
  'theme.nazar.json',
  'theme.graphite.json',
  'theme.sepia.json',
  'theme.midnight.json',
];

/**
 * `typescript`'s `exports` map does not expose `./bin/tsc`, so the launcher is
 * found from the package's main entry instead of resolved by subpath.
 */
function tscLauncher() {
  const main = require.resolve('typescript');
  return path.join(path.dirname(path.dirname(main)), 'bin', 'tsc');
}

async function typecheckWeb() {
  execFileSync(process.execPath, [tscLauncher(), '-p', path.join(webDir, 'tsconfig.json')], {
    stdio: 'inherit',
  });
}

async function buildStyles() {
  const themes = [];
  for (const file of THEME_FILES) {
    const raw = await readFile(path.join(here, file), 'utf8');
    themes.push(assertTheme(JSON.parse(raw), file));
  }
  const tokens = themeCss(themes);
  const rules = await readFile(path.join(webDir, 'styles.css'), 'utf8');
  await writeFile(path.join(outDir, 'styles.css'), `${tokens}\n${rules}`, 'utf8');
  return themes;
}

/**
 * The version the About panel shows.
 *
 * Read from the root manifest and injected as a constant rather than imported
 * from `@nazar/core`: that package's entry point pulls in the watchers, and
 * the watchers import `node:fs`, which has no business in a browser bundle.
 */
async function packageVersion() {
  const raw = await readFile(path.join(here, '..', '..', 'package.json'), 'utf8');
  return JSON.parse(raw).version;
}

async function buildScript(version, themes) {
  const result = await esbuild.build({
    entryPoints: [path.join(webDir, 'app.ts')],
    outfile: path.join(outDir, 'bundle.js'),
    bundle: true,
    format: 'iife',
    target: ['es2022'],
    platform: 'browser',
    define: {
      __NAZAR_VERSION__: JSON.stringify(version),
      // The palette picker's list, taken from the same array the stylesheet was
      // generated from. A theme that the CSS does not carry can therefore not
      // appear in the picker, and one it does carry cannot be forgotten there.
      __NAZAR_THEMES__: JSON.stringify(
        themes.map((theme) => ({
          name: theme.name,
          label: theme.label,
          ...(theme.description === undefined ? {} : { description: theme.description }),
        })),
      ),
    },
    // Left unminified on purpose: a tool that watches your agents should be
    // readable in the browser's own view-source.
    minify: false,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
    metafile: true,
  });
  const output = result.metafile.outputs[
    Object.keys(result.metafile.outputs).find((key) => key.endsWith('bundle.js'))
  ];
  return output?.bytes ?? 0;
}

async function main() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  await typecheckWeb();
  const themes = await buildStyles();
  const bytes = await buildScript(await packageVersion(), themes);

  await cp(path.join(webDir, 'index.html'), path.join(outDir, 'index.html'));
  await cp(path.join(here, 'assets'), path.join(outDir, 'assets'), { recursive: true });

  process.stdout.write(
    `ui: bundle.js ${(bytes / 1024).toFixed(1)} KB · themes ${themes
      .map((theme) => theme.name)
      .join(', ')} → ${path.relative(process.cwd(), outDir)}\n`,
  );
}

await main();
