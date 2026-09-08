// Build the desktop shell, in the order the steps actually depend on each other.
//
// Four things have to happen and three of them are easy to forget, which is why this is
// one script rather than a list in a README:
//
// 1. **The npm package is built.** `dist/nazar.mjs` and `dist/web/` are what the shell
//    ships as resources; they are the published layout, produced by `npm run build`.
// 2. **They are staged where Tauri can see them.** `bundle.resources` in
//    `tauri.conf.json` names `resources/server`, a path relative to the crate — and
//    `tauri-build` checks that it exists while the crate *compiles*, so staging has to
//    happen before `cargo` runs, not before the bundler runs.
// 3. **The icons exist.** They are generated from `packages/ui/assets/nazar.svg` and
//    committed, so this only regenerates them on request (`--icons`). Not by
//    `cargo tauri icon` any more — see the header of `scripts/render-app-icons.mjs`: the
//    CLI resamples, and the mark is pixel art that must not be resampled.
// 4. **The bundler runs.** `cargo tauri build`, or `--debug` for a build whose feedback
//    is minutes rather than tens of minutes — and whose binary keeps its console, which
//    is what makes `nazar-desktop --jump <pid>` printable.
//
// Usage:
//   node scripts/build-desktop.mjs            stage and bundle a release installer
//   node scripts/build-desktop.mjs --debug    stage and bundle a debug installer
//   node scripts/build-desktop.mjs --stage    stage only; no cargo, no bundler
//   node scripts/build-desktop.mjs --icons    regenerate apps/desktop/icons from the SVG
//   --skip-npm-build                          trust the dist/ that is already there

import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const crate = path.join(root, 'apps', 'desktop');
const staged = path.join(crate, 'resources', 'server');

const flags = new Set(process.argv.slice(2));

function run(command, args, options = {}) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit', shell: false, ...options });
}

/**
 * Keep the build machine's own paths out of the binary that gets distributed.
 *
 * Every `panic!` and every `#[track_caller]` location carries the source path it was
 * compiled from, as a *string literal* — so `strip = true` does not touch them. Measured
 * on the first release build here: **238 copies of `C:\Users\<account>\.cargo\registry\…`
 * inside a 4.3 MB executable**, which is the developer's account name shipped to every
 * user, and precisely what `docs/RELEASE.md` step 5 greps the working tree for while never
 * once looking inside the artifact.
 *
 * The tidy fix is `[profile.release] trim-paths = "all"`, and it is not available: the
 * option is still nightly-only on the toolchain `rust-toolchain.toml` pins (Cargo 1.98).
 * `--remap-path-prefix` does the same job on stable, and the prefixes have to be computed
 * here rather than written in a file because they are different on every machine.
 *
 * **Release only.** Setting `RUSTFLAGS` gives Cargo a different fingerprint and therefore
 * a separate build cache, so applying this to debug builds too would mean `cargo test`,
 * `cargo clippy` and `build-desktop.mjs --debug` each recompiling ~550 crates for each
 * other. The debug installer is a fourteen-day CI artifact; the release binary is the one
 * that reaches people.
 */
function remappedEnvironment() {
  const cargoHome =
    process.env.CARGO_HOME ??
    path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.cargo');

  const flagList = [
    // Dependency sources, which is where all 238 of them came from.
    `--remap-path-prefix=${path.join(cargoHome, 'registry', 'src')}=crates`,
    `--remap-path-prefix=${path.join(cargoHome, 'git', 'checkouts')}=git`,
    // This repository, so a panic in our own code says `nazar/apps/desktop/src/…`
    // wherever it was built.
    `--remap-path-prefix=${root}=nazar`,
  ];

  // `CARGO_ENCODED_RUSTFLAGS` and not `RUSTFLAGS`: the unencoded variable is split on
  // whitespace, and a Windows home directory with a space in it would break every flag
  // above in a way that looks like a compiler bug.
  return { ...process.env, CARGO_ENCODED_RUSTFLAGS: flagList.join('\u001f') };
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function bytes(target) {
  return (await stat(target)).size;
}

/**
 * The published package layout, copied into the crate's resources.
 *
 * **It is the layout, not one file.** `dist/nazar.mjs` is a module that *exports* `main`;
 * running it directly loads some declarations and exits with nothing printed, which is
 * exactly what happened the first time this was written. The executable is
 * `bin/nazar.mjs`, and it needs two things beside it: the bundle at `../dist/nazar.mjs`
 * (which is also where `resolveUiDir()` finds `web/`), and a `package.json` one directory
 * up, because the bundle reads its own version out of it. So the shell ships the four
 * pieces npm publishes, in the arrangement npm publishes them in, and starts them the way
 * a terminal would.
 *
 * ```text
 *   resources/server/
 *     package.json          name + version, generated from the root manifest
 *     bin/nazar.mjs         the entry — this is what the shell spawns
 *     dist/nazar.mjs        server + core + canvas maths, one ES module
 *     dist/web/             index.html, bundle.js, styles.css, assets/
 * ```
 *
 * Copied rather than linked. A junction would be less copying and would break the moment
 * somebody built the installer on a machine where `dist/` had been cleaned: the bundler
 * follows what is there when it runs, and a dangling link is a silently empty resource
 * directory.
 */
async function stage() {
  const entry = path.join(root, 'bin', 'nazar.mjs');
  const bundle = path.join(root, 'dist', 'nazar.mjs');
  const web = path.join(root, 'dist', 'web');

  if (!(await exists(bundle)) || !(await exists(path.join(web, 'index.html')))) {
    throw new Error('dist/ is not built. Run "npm run build" first, or drop --skip-npm-build.');
  }

  await rm(path.join(crate, 'resources'), { recursive: true, force: true });
  await mkdir(path.join(staged, 'bin'), { recursive: true });
  await mkdir(path.join(staged, 'dist'), { recursive: true });
  await cp(entry, path.join(staged, 'bin', 'nazar.mjs'));
  await cp(bundle, path.join(staged, 'dist', 'nazar.mjs'));
  await cp(web, path.join(staged, 'dist', 'web'), { recursive: true });

  // Only what the bundle reads. Shipping the root manifest would put this repository's
  // dev dependencies and scripts inside an installer for no reason at all.
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  await writeFile(
    path.join(staged, 'package.json'),
    `${JSON.stringify(
      {
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        license: manifest.license,
        type: 'module',
        private: true,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const size = (await bytes(path.join(staged, 'dist', 'nazar.mjs'))) / 1024;
  process.stdout.write(
    `desktop: staged the ${manifest.version} package layout (nazar.mjs ${size.toFixed(1)} KB + web/) into ${path.relative(root, staged)}\n`,
  );
}

async function main() {
  if (flags.has('--icons')) {
    run(process.execPath, ['scripts/render-app-icons.mjs']);
    process.stdout.write('desktop: icons regenerated from packages/ui/assets/nazar.svg\n');
    return;
  }

  if (!flags.has('--skip-npm-build')) {
    run('npm', ['run', 'build'], { shell: process.platform === 'win32' });
  }
  await stage();

  if (flags.has('--stage')) return;

  const debug = flags.has('--debug');
  const args = ['tauri', 'build'];
  if (debug) args.push('--debug');
  run('cargo', args, debug ? {} : { env: remappedEnvironment() });
}

await main();
