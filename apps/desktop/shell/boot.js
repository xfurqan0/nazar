/*
 * The boot page's script. Plain ES2022, no build step, no framework, no import: this file
 * has to run when everything else has failed, so it depends on nothing that could fail.
 *
 * It reads one shape — the `BootState` `boot.rs` serialises — and paints it. The state
 * arrives twice over, on purpose: once by asking (`boot_state`), because the page can
 * load after the answer is already known, and then on every change by listening
 * (`boot-state`), because the answer arrives asynchronously and polling for it would be
 * a timer nobody can see. Neither path is a fallback for the other; both always run.
 *
 * Navigation away from this page is done in Rust, not here. A page that navigated itself
 * would have to trust a URL that came over IPC; the Rust side already has the URL, so it
 * is the one that moves the webview.
 */

const api = window.__TAURI__;

const headline = document.getElementById('headline');
const detail = document.getElementById('detail');
const requirement = document.getElementById('requirement');
const doctorSection = document.getElementById('doctor-section');
const doctor = document.getElementById('doctor');
const download = document.getElementById('download');
const shellVersion = document.getElementById('shell-version');
const root = document.querySelector('.boot');

/** Phases that mean "still working"; anything else is a resting state. */
const WAITING = new Set(['checking-node', 'starting-server']);

const HEADLINES = {
  'checking-node': 'looking for Node…',
  'starting-server': 'starting the local server…',
  ready: 'canvas ready',
  'node-missing': 'Node is not installed, or not on PATH',
  'node-too-old': 'this machine has an older Node than Nazar needs',
  'node-unreadable': 'Node answered, but not with a version',
  'server-failed': 'the local server did not start',
};

function paint(state) {
  if (!state || typeof state.phase !== 'string') return;

  headline.textContent = HEADLINES[state.phase] ?? state.phase;
  root.classList.toggle('boot--waiting', WAITING.has(state.phase));
  root.classList.toggle('boot--failed', state.phase.startsWith('node-') || state.phase === 'server-failed');

  const message = typeof state.detail === 'string' ? state.detail.trim() : '';
  detail.textContent = message;
  detail.hidden = message.length === 0;

  requirement.hidden = !state.phase.startsWith('node-');

  const report = typeof state.doctor === 'string' ? state.doctor.trim() : '';
  doctor.textContent = report;
  doctorSection.hidden = report.length === 0;

  if (typeof state.version === 'string') {
    shellVersion.textContent = `Nazar desktop ${state.version}`;
  }
}

// The install link opens in the machine's browser rather than in this window: a webview
// that navigates to nodejs.org is a webview with no way back to this page. The URL comes
// from Rust so that the one written in `node.rs` is the one shown here.
download.addEventListener('click', (event) => {
  event.preventDefault();
  api?.core?.invoke('open_download_page').catch(() => {
    // Nothing to fall back to but the text of the link, which is already on screen.
  });
});

async function main() {
  if (api?.event?.listen) {
    await api.event.listen('boot-state', (event) => paint(event.payload));
  }
  if (api?.core?.invoke) {
    paint(await api.core.invoke('boot_state'));
  } else {
    // Opened outside the shell — a developer with the file in a browser. Say so rather
    // than sitting on "starting…" forever.
    headline.textContent = 'this page is the desktop shell’s, and needs the desktop shell';
    root.classList.remove('boot--waiting');
  }
}

void main();
