/**
 * Where the built canvas lives.
 *
 * `packages/ui` compiles to `dist/` (the pure layout maths, imported by Node)
 * and bundles to `dist/web/` (`index.html`, `bundle.js`, `styles.css`,
 * `assets/`). The server serves the second directory and never the first.
 *
 * Three layouts have to land on the same directory, so they are tried in order:
 *
 * 1. `NAZAR_UI_DIR`, which is how the screenshot run points at a rebuilt bundle
 *    without reinstalling anything.
 * 2. A `web/` directory sitting next to this module. That is the **published**
 *    layout: `scripts/build-package.mjs` bundles the server into
 *    `dist/nazar.mjs` and copies the canvas to `dist/web/`, so the tarball
 *    carries no workspace link to resolve. It is checked before
 *    `require.resolve` precisely because a bundle has no `@nazar/ui` left to
 *    resolve, and checking a path that does not exist in the workspace layout
 *    costs one `stat`.
 * 3. `require.resolve('@nazar/ui')`, the workspace layout, with a relative
 *    fallback for running from source with no link in place.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Name of the folder the web bundle is written into, under the UI's `dist/`. */
export const WEB_DIR_NAME = 'web';

/** Absolute path of the directory holding `index.html`. */
export function resolveUiDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['NAZAR_UI_DIR'];
  if (typeof override === 'string' && override.length > 0) return path.resolve(override);

  const beside = path.join(path.dirname(fileURLToPath(import.meta.url)), WEB_DIR_NAME);
  if (existsSync(path.join(beside, 'index.html'))) return beside;

  try {
    const entry = createRequire(import.meta.url).resolve('@nazar/ui');
    return path.join(path.dirname(entry), WEB_DIR_NAME);
  } catch {
    // Running from source with no workspace link: fall back to the sibling
    // package's build output.
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, '..', '..', 'ui', 'dist', WEB_DIR_NAME);
  }
}
