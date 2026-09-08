/**
 * The "fresh machine" acceptance test, run locally.
 *
 * WP6's acceptance criterion is `npx @xfurqan0/nazar` drawing a canvas within a
 * minute on a machine that has never seen the package. This script is that
 * criterion, minus the registry: it packs the tarball, installs it into an
 * empty directory with a cold npm cache, and drives the installed binary.
 *
 *   1. `npm pack` and list the tarball's contents with sizes.
 *   2. `npm install <tarball>` into a fresh temp directory.
 *   3. `nazar --version` and `nazar --help` from the installed package.
 *   4. `nazar doctor`, which must start no server.
 *   5. `nazar --no-open --port <free>` and a `GET /api/state` that answers 200
 *      with a snapshot, then SIGTERM.
 *
 * It never touches `~/.claude`, never publishes, and cleans up after itself.
 * CI runs the same script on windows-latest, ubuntu-latest and macos-latest.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * Run a command to completion and return its output. Rejects on a non-zero
 * exit. The shell is used for `npm` alone, because on Windows it is a `.cmd`
 * shim that `spawn` refuses to start directly — and never for `node`, whose
 * path contains a space that an unquoted shell command line would split.
 */
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      shell: command === npm && process.platform === 'win32',
      env: { ...process.env, ...options.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}

/** A port nothing is listening on right now. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Poll a URL until it answers or the budget runs out. */
async function waitFor(url, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let lastError = 'never tried';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${url} never answered within ${budgetMs} ms (last: ${lastError})`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * List a `.tgz` without shelling out.
 *
 * `tar` is not the same program on the three runners — the Windows box has
 * bsdtar, a Git installation puts GNU tar first, and GNU tar reads `C:\…` as a
 * remote host and fails. A tar header is 512 bytes with the name in the first
 * 100 and the size as octal at offset 124, so listing one is shorter than
 * arguing with the shell about it.
 */
async function listTarball(file) {
  const raw = gunzipSync(await readFile(file));
  const files = [];
  for (let offset = 0; offset + 512 <= raw.length; ) {
    const header = raw.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    if (name.length === 0) break;
    const size = Number.parseInt(
      header.subarray(124, 136).toString('utf8').replace(/[\0 ]/g, '') || '0',
      8,
    );
    const type = header.subarray(156, 157).toString('utf8');
    if (type === '0' || type === '') files.push({ name, size });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

async function main() {
  const started = Date.now();
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'nazar-smoke-'));
  const packDir = path.join(tmp, 'pack');
  // `--pack-destination` writes into the directory, it does not create it.
  await mkdir(packDir, { recursive: true });
  await run(npm, ['pack', '--pack-destination', packDir], { cwd: root });

  const packed = (await readdir(packDir)).filter((name) => name.endsWith('.tgz'));
  assert(packed.length === 1, `expected one tarball, found ${packed.length}`);
  const tarball = path.join(packDir, packed[0]);
  process.stdout.write(`smoke: packed ${packed[0]}\n`);

  const listing = await listTarball(tarball);
  const width = Math.max(...listing.map((file) => file.name.length));
  let total = 0;
  for (const file of listing) {
    total += file.size;
    process.stdout.write(`  ${file.name.padEnd(width)}  ${String(file.size).padStart(8)} B\n`);
  }
  process.stdout.write(
    `  ${'total'.padEnd(width)}  ${String(total).padStart(8)} B in ${listing.length} files\n`,
  );

  // An empty consumer, so the install resolves nothing but the tarball itself.
  await writeFile(
    path.join(tmp, 'package.json'),
    `${JSON.stringify({ name: 'nazar-smoke', version: '1.0.0', private: true }, null, 2)}\n`,
    'utf8',
  );
  await run(npm, ['install', '--no-audit', '--no-fund', tarball], { cwd: tmp });

  const installed = path.join(tmp, 'node_modules', '@xfurqan0', 'nazar', 'bin', 'nazar.mjs');

  const version = await run(process.execPath, [installed, '--version']);
  assert(/^\d+\.\d+\.\d+\s*$/.test(version.stdout), `--version printed ${version.stdout.trim()}`);
  process.stdout.write(`smoke: --version ${version.stdout.trim()}\n`);

  const help = await run(process.execPath, [installed, '--help']);
  assert(help.stdout.includes('--no-open'), '--help does not mention --no-open');
  assert(help.stdout.includes('doctor'), '--help does not mention the doctor subcommand');
  process.stdout.write('smoke: --help ok\n');

  // The real entry point users take. `npx` resolves the bin field, writes its
  // own shim and runs it, which is the step a broken `bin` path fails at and
  // the installed-file check above would not.
  const viaNpx = await run(npm, ['exec', '--yes', '--package', tarball, '--', 'nazar', '--version'], {
    cwd: tmp,
  });
  assert(
    viaNpx.stdout.includes(version.stdout.trim()),
    `npx printed ${JSON.stringify(viaNpx.stdout)}`,
  );
  process.stdout.write('smoke: npx entry ok\n');

  const doctor = await run(process.execPath, [installed, 'doctor']);
  assert(doctor.stdout.includes('Pinned formats'), 'doctor printed no pinned-format section');
  assert(doctor.stdout.includes('Canvas'), 'doctor printed no canvas verdict');
  assert(!doctor.stdout.includes(os.homedir()), 'doctor printed a home path without --verbose');
  process.stdout.write('smoke: doctor ok\n');

  const port = await freePort();
  const server = spawn(process.execPath, [installed, '--no-open', '--port', String(port)], {
    cwd: tmp,
    env: process.env,
  });
  let serverOut = '';
  server.stdout.on('data', (chunk) => (serverOut += chunk));
  server.stderr.on('data', (chunk) => (serverOut += chunk));

  try {
    const state = await waitFor(`http://127.0.0.1:${port}/api/state`, 60_000);
    assert(Array.isArray(state.sessions), '/api/state has no sessions array');
    assert(typeof state.generatedAt === 'number', '/api/state has no generatedAt');
    process.stdout.write(
      `smoke: /api/state ok — ${state.sessions.length} session(s), generatedAt present\n`,
    );

    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert(page.ok, `GET / answered ${page.status}`);
    const html = await page.text();
    assert(html.includes('<svg') || html.includes('bundle.js'), 'the canvas page looks empty');
    process.stdout.write('smoke: canvas page ok\n');
  } finally {
    server.kill('SIGTERM');
  }

  await rm(tmp, { recursive: true, force: true, maxRetries: 5 });
  process.stdout.write(
    `smoke: passed on ${process.platform} in ${((Date.now() - started) / 1000).toFixed(1)} s\n`,
  );
  if (serverOut.length > 0 && process.env['NAZAR_SMOKE_VERBOSE'] === '1') {
    process.stdout.write(`--- server output ---\n${serverOut}`);
  }
}

await main();
