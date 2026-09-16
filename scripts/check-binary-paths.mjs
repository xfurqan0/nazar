// Look inside a built artifact for the build machine's own paths.
//
// **The leak this exists for.** Every `panic!`, every `#[track_caller]` location and every
// `file!()` carries the source path it was compiled from as a *string literal*, so
// `strip = true` never touches them and no grep of the working tree can see them. A
// release binary built on a laptop therefore ships that laptop's account name to everyone
// who downloads it — measured in this family of projects at **182 copies of
// `C:\Users\<account>\.cargo\registry\…` in one Windows installer**, found only by reading
// the artifact. `scripts/build-desktop.mjs` passes `--remap-path-prefix` and
// `-ffile-prefix-map` to stop it happening; this is the gate that says whether they worked,
// because the two flags cover different compilers and a crate that builds C of its own
// (`ring`, `aws-lc-sys`, anything with a `cc` build script) obeys only the second.
//
// **What it reads.** Raw bytes, twice: once as UTF-8 and once as UTF-16LE, because a
// Windows binary carries wide strings and a scan that only looked at one encoding would
// pass an installer full of them. A `.deb` is an `ar` archive whose payload is compressed,
// so it is unpacked in memory (gzip or zstd, both from `node:zlib` — this script has no
// dependencies for the same reason the package it checks has none) and the payload is
// scanned as well. A container this script cannot open is a **failure**, never a pass: a
// check that cannot see inside must not report that what it could not see is clean.
//
// **What it cannot read**, and says so rather than implying otherwise. An `.AppImage` is a
// squashfs image and an NSIS installer compresses its payload with LZMA; neither opens
// without a tool this repository does not depend on. Both are reported as *read as bytes
// only*, and neither is a hole, because the same files are scanned uncompressed elsewhere
// in the same run — the `AppDir` the bundler leaves beside the image, and the executable
// the installer was built from. A container that *should* open and does not is the other
// thing entirely, and that one fails the check.
//
// Usage:
//   node scripts/check-binary-paths.mjs                  the release artifacts of this tree
//   node scripts/check-binary-paths.mjs <path…>          these files or directories
//   --account <name>     the account to hunt for; defaults to this machine's
//   --home <path>        the home directory to hunt for; defaults to this machine's
//   --json               machine-readable findings
//
// Exit status is 1 when anything was found, or when a container could not be opened.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * How many characters of a match to print.
 *
 * The finding is a path, and the path is the point — a count with nothing to look at
 * leaves whoever reads it guessing which crate or which flag to blame. It is cut short
 * because the strings around one of these are often the rest of a registry path and the
 * output is meant to be read.
 */
const EXCERPT = 90;

/** How many examples of one rule to print before the rest become a count. */
const EXAMPLES = 4;

/**
 * The paths that must never reach an artifact, as patterns rather than as one grep.
 *
 * Each is a *category*: a Windows profile directory, a Unix home, a macOS home. They are
 * written without an account name in them so that this file says nothing about the machine
 * it happens to be run on, and so that the check is the same check on a CI runner — where
 * the account is `runner` and the leak is no less a leak — as it is on a laptop.
 */
export const RULES = [
  {
    name: 'windows-profile',
    pattern: /[A-Za-z]:[\\/]Users[\\/][A-Za-z0-9 ._-]{1,64}/g,
    why: 'a Windows profile directory, which carries the account name',
  },
  {
    name: 'unix-home',
    pattern: /\/home\/[A-Za-z0-9._-]{1,64}/g,
    why: 'a Linux home directory, which carries the account name',
  },
  {
    name: 'macos-home',
    pattern: /\/Users\/[A-Za-z0-9._-]{1,64}/g,
    why: 'a macOS home directory, which carries the account name',
  },
];

/**
 * Is this byte position inside a longer word?
 *
 * The lesson `packages/core/test/history-leak.test.ts` learned the hard way: an account
 * name checked with `includes` fires on every longer name that contains it, and a project
 * directory called `adaOS` is not the account `ada`. A match is only a match when neither
 * side of it is a letter or a digit.
 */
function standsAlone(text, at, length) {
  const before = at === 0 ? '' : text[at - 1];
  const after = text[at + length] ?? '';
  return !/[A-Za-z0-9]/.test(before) && !/[A-Za-z0-9]/.test(after);
}

/** Escape a string so it can be dropped into a regular expression as a literal. */
function literal(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The rule set for one machine: the categories above, plus this machine's own two names.
 *
 * The home directory is asked for by path because a home is not always under `/home` — a
 * Fedora Silverblue account lives in `/var/home/<name>`, and a pattern that only knew the
 * usual shape would report a clean binary on the machine most likely to be building one.
 */
export function rulesFor({ account, home } = {}) {
  const rules = [...RULES];
  if (typeof home === 'string' && home.length > 1) {
    rules.push({
      name: 'this-home',
      pattern: new RegExp(literal(home), 'g'),
      why: "this machine's home directory",
    });
  }
  if (typeof account === 'string' && account.length > 0) {
    rules.push({
      name: 'this-account',
      pattern: new RegExp(literal(account), 'g'),
      why: "this machine's account name",
      // The one rule that needs a boundary: an account called `ada` must not fire on
      // `adaptive-layout`, and a two-letter account would otherwise fire on everything.
      whole: true,
    });
  }
  return rules;
}

/**
 * Every finding in one run of text.
 *
 * Duplicates are kept, because the number is the measurement: *238 copies* is what said
 * the registry path was being written once per panic site rather than once, and a set
 * would have reported a single innocuous-looking hit.
 */
export function findLeaks(text, rules, encoding = 'utf8') {
  const found = [];
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    for (let match = rule.pattern.exec(text); match !== null; match = rule.pattern.exec(text)) {
      if (rule.whole === true && !standsAlone(text, match.index, match[0].length)) continue;
      found.push({
        rule: rule.name,
        why: rule.why,
        encoding,
        at: match.index,
        text: text.slice(match.index, match.index + EXCERPT).replace(/[\0-\x1f\x7f]/g, ' ').trim(),
      });
      // A zero-length match cannot happen with these patterns, but a regular expression
      // that was edited into one would loop here forever.
      if (match[0].length === 0) rule.pattern.lastIndex += 1;
    }
  }
  return found;
}

/**
 * One buffer, read in both encodings a compiler can leave a path in.
 *
 * UTF-16LE is read at both byte alignments: a wide string in a PE file starts wherever the
 * linker put it, and half of them start on an odd offset.
 */
export function scanBuffer(buffer, rules) {
  const found = findLeaks(buffer.toString('latin1'), rules, 'utf8');
  found.push(...findLeaks(buffer.toString('utf16le'), rules, 'utf16le'));
  if (buffer.length > 1) {
    found.push(...findLeaks(buffer.subarray(1).toString('utf16le'), rules, 'utf16le+1'));
  }
  return found;
}

/**
 * The members of an `ar` archive, which is all a `.deb` is.
 *
 * Sixty bytes of header per member — name, four numbers, a two-byte end mark — then the
 * data, padded to an even length. The GNU long-name table is not handled and does not need
 * to be: a `.deb` carries `debian-binary`, `control.tar.*` and `data.tar.*`, and none of
 * those is over sixteen characters.
 */
export function arMembers(buffer) {
  if (buffer.subarray(0, 8).toString('latin1') !== '!<arch>\n') return [];
  const members = [];
  let at = 8;
  while (at + 60 <= buffer.length) {
    const name = buffer.subarray(at, at + 16).toString('latin1').trim();
    const size = Number.parseInt(buffer.subarray(at + 48, at + 58).toString('latin1').trim(), 10);
    if (!Number.isFinite(size) || size < 0) break;
    const start = at + 60;
    members.push({ name, data: buffer.subarray(start, start + size) });
    at = start + size + (size % 2);
  }
  return members;
}

/**
 * A compressed member, decompressed, or `undefined` when nothing here can open it.
 *
 * Only what `node:zlib` carries. `xz` is deliberately absent: adding a decompressor as a
 * dependency to a repository whose whole claim is zero runtime dependencies would be a
 * strange way to check that claim, and the honest answer for an artifact this cannot open
 * is to say so and fail.
 */
export function decompress(data) {
  if (data.length > 2 && data[0] === 0x1f && data[1] === 0x8b) return gunzipSync(data);
  if (data.length > 4 && data.readUInt32LE(0) === 0xfd2fb528) return zstdDecompressSync(data);
  // An uncompressed `data.tar` is a tar, and a tar is already readable bytes.
  if (data.subarray(257, 262).toString('latin1') === 'ustar') return data;
  return undefined;
}

/**
 * Where the payload of an `.rpm` starts, found by its magic rather than by its header.
 *
 * An rpm's lead and header blocks are uncompressed and are scanned as themselves; the
 * payload after them is a compressed cpio whose compressor is named in a header tag. This
 * looks for the first gzip or zstd frame instead of parsing the tag table, because the two
 * magics are four bytes and a header-tag parser would be two hundred lines that this file
 * would then have to be trusted about.
 */
export function rpmPayload(buffer) {
  for (let at = 96; at + 4 < buffer.length; at += 1) {
    if (buffer[at] === 0x1f && buffer[at + 1] === 0x8b && buffer[at + 2] === 0x08) {
      return gunzipSync(buffer.subarray(at));
    }
    if (buffer.readUInt32LE(at) === 0xfd2fb528) return zstdDecompressSync(buffer.subarray(at));
  }
  return undefined;
}

/**
 * The buffers one path contributes: the file itself, and whatever is inside it.
 *
 * A container that cannot be opened comes back as a `problem`, which the caller turns into
 * a failure. That direction matters more than it looks: the silent alternative is a check
 * that prints *clean* about bytes it never read.
 */
export function open(file) {
  const raw = readFileSync(file);
  const parts = [{ label: 'raw', buffer: raw }];
  const name = basename(file).toLowerCase();

  if (name.endsWith('.deb')) {
    const members = arMembers(raw);
    if (members.length === 0) return { parts, problem: 'not an ar archive, so nothing was unpacked' };
    for (const member of members) {
      if (!member.name.startsWith('data.tar') && !member.name.startsWith('control.tar')) continue;
      const inside = decompress(member.data);
      if (inside === undefined) {
        return { parts, problem: `${member.name} is compressed with something node:zlib cannot open` };
      }
      parts.push({ label: member.name, buffer: inside });
    }
    return { parts };
  }

  if (name.endsWith('.rpm')) {
    const payload = rpmPayload(raw);
    if (payload === undefined) return { parts, problem: 'no gzip or zstd payload was found inside' };
    parts.push({ label: 'payload', buffer: payload });
    return { parts };
  }

  if (name.endsWith('.appimage')) {
    // Not a failure, and the difference from the two above is the whole reason there are
    // two words for it: the bundler leaves the `AppDir` it squashed beside the image, so
    // a scan of the bundle directory has already read every file inside this one. A
    // `.deb` whose payload will not open is a hole; this is a duplicate.
    return { parts, skipped: 'a squashfs image; the AppDir beside it holds the same files' };
  }

  if (name.endsWith('.exe') || name.endsWith('.msi')) {
    // An NSIS installer compresses its payload with LZMA, which nothing here unpacks. The
    // executable it carries is scanned directly — it is the same file — so this is a
    // partial read rather than a blind one, and it says which.
    return { parts, skipped: 'an installer payload is compressed; scan the executable it carries too' };
  }

  return { parts };
}

/** Every file under a path, or the path itself when it is one. */
export function walk(target) {
  const info = statSync(target);
  if (!info.isDirectory()) return [target];
  const files = [];
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    // The bundler downloads these for itself and they are nobody's build output.
    if (entry.name.startsWith('linuxdeploy')) continue;
    files.push(...walk(join(target, entry.name)));
  }
  return files;
}

/**
 * What to scan when nobody said: the release artifacts this tree has produced.
 *
 * Every entry is optional. A machine that has built the Linux bundles and not the Windows
 * installer should get a report about what it built, not an error about what it did not.
 */
export function defaultTargets(root = REPO) {
  const candidates = [
    join(root, 'target', 'release', 'nazar-desktop'),
    join(root, 'target', 'release', 'nazar-desktop.exe'),
    join(root, 'target', 'release', 'bundle'),
  ];
  return candidates.filter((candidate) => existsSync(candidate));
}

function parseArguments(argv) {
  const targets = [];
  let account = os.userInfo().username;
  let home = os.homedir();
  let asJson = false;

  for (let at = 0; at < argv.length; at += 1) {
    const argument = argv[at];
    if (argument === '--json') {
      asJson = true;
    } else if (argument === '--account') {
      account = argv[++at] ?? '';
    } else if (argument === '--home') {
      home = argv[++at] ?? '';
    } else {
      targets.push(resolve(argument));
    }
  }

  return { targets, account, home, asJson };
}

function main() {
  const { targets, account, home, asJson } = parseArguments(process.argv.slice(2));
  const files = (targets.length > 0 ? targets : defaultTargets()).flatMap(walk);

  if (files.length === 0) {
    process.stderr.write(
      'nothing to scan. Build first, or name the files:\n' +
        '  node scripts/check-binary-paths.mjs target/release/nazar-desktop\n',
    );
    process.exit(1);
  }

  const rules = rulesFor({ account, home });
  const report = [];
  let findings = 0;
  let problems = 0;

  for (const file of files) {
    const { parts, problem, skipped } = open(file);
    const found = parts.flatMap((part) =>
      scanBuffer(part.buffer, rules).map((one) => ({ ...one, part: part.label })),
    );
    findings += found.length;
    if (problem !== undefined) problems += 1;
    report.push({ file: relative(REPO, file), bytes: statSync(file).size, problem, skipped, found });
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ account, home, files: report }, null, 2)}\n`);
  } else {
    for (const entry of report) {
      const size = `${(entry.bytes / (1024 * 1024)).toFixed(1)} MB`;
      const verdict = entry.found.length === 0 ? 'clean' : `${entry.found.length} found`;
      process.stdout.write(`${entry.found.length === 0 ? '  ok  ' : 'LEAK  '}${entry.file}  (${size}, ${verdict})\n`);
      if (entry.problem !== undefined) {
        process.stdout.write(`      unreadable: ${entry.problem}\n`);
      }
      if (entry.skipped !== undefined) {
        process.stdout.write(`      read as bytes only: ${entry.skipped}\n`);
      }
      const byRule = new Map();
      for (const one of entry.found) byRule.set(one.rule, [...(byRule.get(one.rule) ?? []), one]);
      for (const [rule, list] of byRule) {
        process.stdout.write(`      ${rule} × ${list.length} — ${list[0].why}\n`);
        for (const one of list.slice(0, EXAMPLES)) {
          process.stdout.write(`        ${one.part}/${one.encoding} @${one.at}: ${one.text}\n`);
        }
        if (list.length > EXAMPLES) {
          process.stdout.write(`        … and ${list.length - EXAMPLES} more\n`);
        }
      }
    }
  }

  if (findings > 0 || problems > 0) {
    if (!asJson) {
      process.stderr.write(
        `\n${findings} build-machine path${findings === 1 ? '' : 's'} in ${files.length} artifact${files.length === 1 ? '' : 's'}` +
          `${problems > 0 ? `, and ${problems} that could not be read` : ''}.\n` +
          'The remapping lives in scripts/build-desktop.mjs: RUSTFLAGS for Rust sources and\n' +
          'CFLAGS/CXXFLAGS for the crates that compile C of their own. A path that survives both\n' +
          'is coming from somewhere else and is worth finding before a release carries it.\n',
      );
    }
    process.exit(1);
  }

  if (!asJson) {
    process.stdout.write(
      `\nno build-machine paths in ${files.length} artifact${files.length === 1 ? '' : 's'}\n`,
    );
  }
}

// `process.argv[1]` is the script Node was given. Comparing resolved paths rather than
// URLs keeps this working when the script is reached through a symlink.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
