// Licence gate for every dependency the desktop shell links.
//
// The rule: permissive only. A copyleft dependency in an MIT product is not a licence
// question at release time, it is a rewrite, so it is caught on the day it is added.
// `cargo deny` does a stricter job with the same policy; this script exists so the check
// runs with nothing installed beyond the toolchain the repository already needs.
//
// **The allow-list is `deny.toml`'s, read at run time (N-WP9).** It used to be a second
// copy of the same fifteen identifiers, kept in step by hand — and a release audit found
// what that always becomes: two lists nobody had compared since the day they were written,
// either of which could quietly stop meaning what the other one said. `cargo deny` cannot
// read a JavaScript array, so the direction of the copy was never in question: the TOML
// file is the source and this script is the reader. The parser below understands one
// construct, which is the one that has to be read.
//
// **Why this arrived with WP8 and not with WP0.** Until the desktop shell there was
// nothing to check: `@xfurqan0/nazar` has zero runtime dependencies, and its dev
// dependencies are build tools that ship in nothing. The shell links roughly six hundred
// Rust crates into a binary that is distributed, and every one of their licences is now
// this project's problem. The npm side is still reported, and still dev-only.
//
// Usage: node scripts/check-licenses.mjs [--json]

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The one file that says what may be linked. */
export const DENY_TOML = join(REPO, 'deny.toml');

/**
 * The `allow` array of the `[licenses]` table, out of a `deny.toml`.
 *
 * Not a TOML parser, and it does not want to become one: it finds the `[licenses]` table,
 * takes the `allow = [ … ]` array inside it, drops `#` comments, and returns the quoted
 * strings. Everything else in that file — the bans, the advisories, the sources — belongs
 * to `cargo deny` and is none of this script's business.
 *
 * It throws rather than falling back to a built-in list. A licence gate that silently
 * degrades to "allow whatever I remembered" is worse than no gate, because it keeps
 * printing the reassuring line.
 */
export function parseAllowedLicenses(toml) {
  const table = /^\s*\[licenses\]\s*$/m.exec(toml);
  if (table === null) throw new Error('deny.toml has no [licenses] table');

  const rest = toml.slice(table.index + table[0].length);
  // The next table header ends this one; without it, a later `allow` would be read.
  const nextTable = /^\s*\[[^\]]+\]\s*$/m.exec(rest);
  const section = nextTable === null ? rest : rest.slice(0, nextTable.index);

  const opened = section.indexOf('allow');
  const start = section.indexOf('[', opened);
  const end = section.indexOf(']', start);
  if (opened === -1 || start === -1 || end === -1) {
    throw new Error('deny.toml has no "allow" array in its [licenses] table');
  }

  const body = section
    .slice(start + 1, end)
    .split('\n')
    .map((line) => line.replace(/#.*$/, ''))
    .join('\n');

  const found = [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  if (found.length === 0) throw new Error('deny.toml allows no licence at all');
  return found;
}

/**
 * SPDX identifiers this project accepts. Anything else stops the build.
 *
 * The same list nazar-tray uses, minus the entries that only its opt-in HTTP client
 * pulled in. `CDLA-Permissive-2.0` is kept for the same reason it is there: it covers
 * Mozilla's root certificate list, which is data rather than code, grants unrestricted
 * use with no share-alike clause, and arrives through `reqwest` — a dependency of `tauri`
 * itself, so it cannot be dropped without dropping Tauri. The reasons are written beside
 * the entries, in `deny.toml`, where the list lives.
 */
export const ALLOWED = new Set(parseAllowedLicenses(readFileSync(DENY_TOML, 'utf8')));

/**
 * Evaluate an SPDX expression against the allowlist.
 *
 * `A OR B` passes when either side does, because the user picks. `A AND B` needs both.
 * Exceptions (`Apache-2.0 WITH LLVM-exception`) narrow a licence, so the base decides.
 */
export function isAllowed(expression) {
  if (!expression) return false;
  const normalised = expression.replace(/\//g, ' OR ').replace(/[()]/g, ' ');
  const terms = (clause) =>
    clause
      .split(/\s+/)
      .filter((word) => word && !['OR', 'AND', 'WITH'].includes(word.toUpperCase()))
      .filter((word) => !word.endsWith('-exception'));

  if (/\sAND\s/i.test(normalised)) {
    return normalised
      .split(/\sAND\s/i)
      .every((clause) => terms(clause).some((term) => ALLOWED.has(term)));
  }
  return terms(normalised).some((term) => ALLOWED.has(term));
}

function cargoDependencies() {
  const raw = execFileSync('cargo', ['metadata', '--format-version', '1', '--locked'], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const metadata = JSON.parse(raw);
  const workspace = new Set(metadata.workspace_members);

  return metadata.packages
    .filter((pkg) => !workspace.has(pkg.id))
    .map((pkg) => ({
      ecosystem: 'cargo',
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? (pkg.license_file ? `file: ${pkg.license_file}` : null),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function npmDependencies() {
  const modules = join(REPO, 'node_modules');
  if (!existsSync(modules)) return [];

  const found = [];
  const visit = (dir, scope) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.bin') continue;
      if (entry.name.startsWith('@') && !scope) {
        visit(join(dir, entry.name), entry.name);
        continue;
      }
      const manifest = join(dir, entry.name, 'package.json');
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      // The three workspace packages are linked in here and are this repository's own.
      if (typeof pkg.name === 'string' && pkg.name.startsWith('@nazar/')) continue;
      found.push({
        ecosystem: 'npm',
        name: pkg.name ?? (scope ? `${scope}/${entry.name}` : entry.name),
        version: pkg.version ?? 'unknown',
        license:
          typeof pkg.license === 'string'
            ? pkg.license
            : (pkg.license?.type ?? pkg.licenses?.[0]?.type ?? null),
      });
    }
  };
  visit(modules, null);
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The whole check. Only run when this file is the program, so a test can import
 * {@link parseAllowedLicenses} and {@link isAllowed} without spawning `cargo metadata`.
 */
function main() {
  const dependencies = [...cargoDependencies(), ...npmDependencies()];
  const rejected = dependencies.filter((dep) => !isAllowed(dep.license));
  const asJson = process.argv.includes('--json');

  if (asJson) {
    // Nothing but JSON on stdout, so the output stays pipeable.
    process.stdout.write(`${JSON.stringify(dependencies, null, 2)}\n`);
  } else {
    const counts = new Map();
    for (const dep of dependencies) {
      counts.set(dep.license ?? 'unknown', (counts.get(dep.license ?? 'unknown') ?? 0) + 1);
    }
    const cargo = dependencies.filter((dep) => dep.ecosystem === 'cargo').length;
    process.stdout.write(
      `${dependencies.length} dependencies (${cargo} cargo, ${dependencies.length - cargo} npm, dev only)\n\n`,
    );
    for (const [license, count] of [...counts].sort((a, b) => b[1] - a[1])) {
      process.stdout.write(`  ${String(count).padStart(4)}  ${license}\n`);
    }
  }

  if (rejected.length > 0) {
    process.stderr.write('\nnot on the allowlist:\n');
    for (const dep of rejected) {
      process.stderr.write(
        `  ${dep.ecosystem}  ${dep.name}@${dep.version}  ${dep.license ?? 'no licence'}\n`,
      );
    }
    process.stderr.write(
      '\nAdd the identifier to the [licenses] allow list in deny.toml only if it is\n' +
        'permissive, or drop the dependency. That file is the one place the list lives.\n',
    );
    process.exit(1);
  }

  if (!asJson) {
    process.stdout.write(
      `\nevery dependency is permissively licensed (${ALLOWED.size} identifiers allowed by deny.toml)\n`,
    );
  }
}

// `process.argv[1]` is the script Node was given. Comparing the resolved paths rather
// than the URLs keeps this working when the script is reached through a symlink.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
