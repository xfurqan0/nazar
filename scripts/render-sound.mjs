// Synthesise the bead tick: the 250 ms sound a finished session makes.
//
// Why not a stock chime: the same reason the icon is sixty integer rects rather than a
// downloaded PNG. A stock file arrives with a licence to track, a provenance nobody can
// check, and a character that belongs to somebody else's product. Sixty lines of arithmetic
// arrive with none of that, and the sound can be *described* in the repository — two
// partials, an 8 ms attack, an exponential tail — instead of being a binary blob that has
// to be trusted.
//
// **The output is committed, and this script is the proof of it.** `bead-tick.wav` is a
// shipped asset: the browser fetches it and no synthesis happens at runtime, so the canvas
// keeps its zero runtime dependencies and its "the page loads one static file" story. What
// keeps the committed bytes honest is that re-running this script has to produce them
// again, byte for byte — `packages/ui/test/sound-asset.test.ts` renders into memory and
// compares. It is the icon discipline, applied to a sound.
//
// **Determinism.** Every number below is IEEE 754 double arithmetic plus `Math.sin`, which
// V8 implements from its own fdlibm port rather than the platform's libm precisely so the
// answer does not depend on the machine. The three CI platforms therefore agree, and a
// future V8 that changed the answer would fail the test rather than quietly ship a
// different sound.
//
// Usage: node scripts/render-sound.mjs [output.wav]

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const DEFAULT_OUTPUT = 'packages/ui/assets/bead-tick.wav';

/** CD rate. Every browser's `decodeAudioData` resamples to its own context anyway. */
export const SAMPLE_RATE = 44_100;

/** How long the whole tick lasts. Long enough to be a sound, short enough not to be an event. */
export const DURATION_MS = 250;

/** The rise, linear from silence. Below ~5 ms a sine starts with an audible click. */
export const ATTACK_MS = 8;

/** Time constant of the exponential tail, in milliseconds. */
export const DECAY_TAU_MS = 55;

/**
 * The two partials.
 *
 * 880 Hz is A5 and 1320 Hz is its perfect fifth (3:2), so the pair reads as one pitched
 * tick rather than as two tones. The fifth sits 9 dB down: enough to give the attack its
 * edge, not enough to be heard as a separate note.
 */
export const PARTIALS = [
  { hz: 880, db: 0 },
  { hz: 1320, db: -9 },
];

/** Peak level of the finished file. Headroom on purpose: a notification is not a track. */
export const PEAK_DBFS = -6;

/** The ceiling the asset is held to. The file is ~22 KB, so this is not a tight fit. */
export const MAX_BYTES = 25 * 1024;

/** Full scale for signed 16-bit samples. */
const FULL_SCALE = 32_767;

/** Decibels relative to full scale, as a linear gain. */
export function gainFromDb(db) {
  return 10 ** (db / 20);
}

/**
 * The amplitude envelope at sample `index`, between 0 and 1.
 *
 * Linear up over the attack, then exponential down — and the decay is written as
 * `(e^-x/τ − floor) / (1 − floor)` rather than as a bare `e^-x/τ` so it reaches **exactly**
 * zero at the last sample. A tail that stops at 1 % of full scale instead of at silence is
 * a click at the end of every notification, which is the one artefact a short sound cannot
 * hide.
 */
export function envelopeAt(index, total, attack, tau) {
  if (index < attack) return index / attack;
  const decaySamples = total - attack;
  const floor = Math.exp(-decaySamples / tau);
  return (Math.exp(-(index - attack) / tau) - floor) / (1 - floor);
}

/**
 * The tick as signed 16-bit samples, normalised so its loudest sample is {@link PEAK_DBFS}.
 *
 * Normalisation is measured rather than assumed: the two partials do not peak at the same
 * instant, so the sum's maximum is not the sum of the maxima, and hard-coding a gain would
 * either clip or leave the sound quieter than it says it is.
 */
export function renderSamples() {
  const total = Math.round((SAMPLE_RATE * DURATION_MS) / 1000);
  const attack = Math.round((SAMPLE_RATE * ATTACK_MS) / 1000);
  const tau = (SAMPLE_RATE * DECAY_TAU_MS) / 1000;

  const floats = new Float64Array(total);
  let loudest = 0;
  for (let index = 0; index < total; index += 1) {
    let value = 0;
    for (const partial of PARTIALS) {
      value += gainFromDb(partial.db) * Math.sin((2 * Math.PI * partial.hz * index) / SAMPLE_RATE);
    }
    value *= envelopeAt(index, total, attack, tau);
    floats[index] = value;
    const size = Math.abs(value);
    if (size > loudest) loudest = size;
  }

  const scale = loudest === 0 ? 0 : (FULL_SCALE * gainFromDb(PEAK_DBFS)) / loudest;
  const samples = new Int16Array(total);
  for (let index = 0; index < total; index += 1) {
    const value = Math.round(floats[index] * scale);
    samples[index] = Math.min(FULL_SCALE, Math.max(-FULL_SCALE - 1, value));
  }
  return samples;
}

/** Wrap 16-bit mono samples in the 44-byte canonical WAV header. */
export function toWav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) data.writeInt16LE(samples[index], index * 2);

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // the PCM fmt chunk is 16 bytes
  header.writeUInt16LE(1, 20); // format 1: uncompressed PCM
  header.writeUInt16LE(1, 22); // one channel
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate: one mono 16-bit frame is 2 bytes
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}

/** The whole file, in memory. What the test compares the committed asset against. */
export function renderSound() {
  return toWav(renderSamples());
}

// Run as a script rather than imported: write the asset.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = resolve(REPO, process.argv[2] ?? DEFAULT_OUTPUT);
  const wav = renderSound();
  if (wav.length > MAX_BYTES) {
    throw new Error(`the tick is ${wav.length} bytes, over the ${MAX_BYTES}-byte ceiling`);
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, wav);
  process.stdout.write(
    `rendered ${DURATION_MS} ms tick (${(wav.length / 1024).toFixed(1)} KB) to ${relative(REPO, output)}\n`,
  );
}
