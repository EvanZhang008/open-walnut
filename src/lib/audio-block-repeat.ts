/**
 * A recording that holds every 10 ms of sound twice (or three times), found
 * and undone.
 *
 * 2026-11-20, the user in the Mac app, with a Bluetooth headset: the live text
 * stayed empty for long stretches and the final text took 16.6 s. The Mac app's
 * MediaRecorder had written each 10 ms of the headset's 24 kHz audio twice in a
 * row: a 152 s dictation came back as 304 s of WebM. The engine then heard
 * speech at half its tempo (the drafts it was given came back empty, the whole
 * clip took twice as long and read the context back), and the recording's bytes
 * grew twice as fast. 17 of the 20 headset recordings with speech in the user's
 * voice history have it; none at 48 kHz do. It comes and goes between
 * recordings on the same headset, so it is found from the sound itself, never
 * from the header or the device.
 *
 * Finding it: in a repeated stream, a 10 ms block and the block after it are
 * nearly the same waveform (correlation about 0.95), while the block after
 * that, the start of the next pair, is not. Ordinary speech gives 0.1 to 0.2 for
 * both, and a steady tone gives a high value for both, so the gap between the
 * two is what tells a repeat from a held note. In the user's recordings a take
 * that repeats does so from its first sound to its last at one phase (checked
 * per 5 s over 20 headset takes, up to 304 s); one that repeats only in part
 * is left as it is.
 */

export interface BlockRepeat {
  /** How many copies of each block the stream holds (2 or 3). */
  factor: number;
  /** Samples per block (10 ms). */
  block: number;
  /** Sample where the first whole group of copies starts. */
  phase: number;
  /** Mean correlation of a block with its copy. */
  within: number;
  /** Mean correlation of a group's last block with the next group's first. */
  across: number;
}

/** `none`: enough sound was heard and it repeats nothing; null: too little sound to tell. */
export type BlockRepeatVerdict = BlockRepeat | 'none' | null;

const FACTORS = [2, 3];
/** Groups compared per candidate; the loudest of the clip, spread over it. */
const SAMPLE_GROUPS = 48;
/** Fewer loud groups than this is not enough sound to tell. */
const MIN_GROUPS = 12;
/** A group quieter than this (RMS) holds no sound worth comparing. */
const LOUD_RMS = 0.004;
const MIN_WITHIN = 0.85;
const MIN_GAP = 0.35;
/** Stretches of the clip the loud groups are spread over. */
const TIME_BINS = 8;
/** Stretches that must each repeat at the found phase (at most; each at least 1 s of input). */
const CHECK_SLICES = 8;

function corr(s: ArrayLike<number>, a: number, b: number, n: number): number | null {
  let sa = 0, sb = 0, sab = 0;
  for (let i = 0; i < n; i++) {
    const x = s[a + i], y = s[b + i];
    sa += x * x; sb += y * y; sab += x * y;
  }
  if (sa < 1e-9 || sb < 1e-9) return null;
  return sab / Math.sqrt(sa * sb);
}

/**
 * Start positions (multiples of `group`) of the loudest groups, in order, taken
 * evenly over the clip's time (the loudest few of each stretch), so one loud
 * stretch cannot decide for all of it.
 */
function loudGroups(s: ArrayLike<number>, group: number, from = 0, to = s.length, want = SAMPLE_GROUPS): number[] {
  const first = Math.ceil(from / group);
  const count = Math.floor(to / group) - 2 - first;
  if (count <= 0) return [];
  // Look at a bounded number of candidates so a long clip costs the same.
  const stride = Math.max(1, Math.floor(count / 2000));
  const bins = Math.min(TIME_BINS, Math.max(1, Math.floor(count / 50)));
  const perBin = Math.ceil(want / bins);
  const scored: Array<Array<{ at: number; e: number }>> = Array.from({ length: bins }, () => []);
  for (let g = 0; g < count; g += stride) {
    const at = (first + g) * group;
    let e = 0;
    for (let i = 0; i < group; i += 4) e += s[at + i] * s[at + i];
    const rms = Math.sqrt(e / Math.ceil(group / 4));
    if (rms >= LOUD_RMS) scored[Math.min(bins - 1, Math.floor((g * bins) / count))].push({ at, e });
  }
  return scored.flatMap((bin) => bin.sort((x, y) => y.e - x.e).slice(0, perBin).map((x) => x.at)).sort((x, y) => x - y);
}

/** Mean correlation of each block with its copies (within) and of a group's last block with the next group (across). */
function score(s: ArrayLike<number>, starts: number[], phase: number, block: number, factor: number) {
  const group = block * factor;
  let within = 0, across = 0, nw = 0, na = 0;
  for (const start of starts) {
    const at = start + phase;
    if (at + group + block > s.length) continue;
    let w = 0, wn = 0;
    for (let k = 0; k + 1 < factor; k++) {
      const c = corr(s, at + k * block, at + (k + 1) * block, block);
      if (c !== null) { w += c; wn++; }
    }
    if (wn) { within += w / wn; nw++; }
    const c = corr(s, at + (factor - 1) * block, at + group, block);
    if (c !== null) { across += c; na++; }
  }
  return { within: nw ? within / nw : 0, across: na ? across / na : 0, n: Math.min(nw, na) };
}

/**
 * Whether every stretch of the clip that holds sound repeats at the same
 * phase. A stream that repeats only in part, or slips its alignment, is left
 * alone: dropping every other block of sound that never repeated would cut the
 * user's words in half.
 */
function holdsThroughout(s: ArrayLike<number>, r: BlockRepeat): boolean {
  const group = r.block * r.factor;
  const step = Math.max(1, Math.round(r.block / 40));
  const slices = Math.min(CHECK_SLICES, Math.max(1, Math.floor(s.length / (group * 100))));
  for (let k = 0; k < slices; k++) {
    const from = Math.floor((s.length * k) / slices), to = Math.floor((s.length * (k + 1)) / slices);
    const starts = loudGroups(s, group, from, to, SAMPLE_GROUPS / 2);
    if (starts.length < MIN_GROUPS / 2) continue;                // too little sound here to tell
    let best = 0;
    for (let d = -2 * step; d <= 2 * step; d += step) {
      const phase = (((r.phase + d) % group) + group) % group;
      const sc = score(s, starts, phase, r.block, r.factor);
      // The gap was asked of the clip as a whole (a held note); here only a
      // stretch that plainly does not repeat counts against it.
      if (sc.n >= MIN_GROUPS / 2) best = Math.max(best, sc.within);
    }
    if (best < MIN_WITHIN - 0.05) return false;
  }
  return true;
}

/**
 * Whether `samples` repeats each 10 ms block, read from the sound. Costs a few
 * milliseconds whatever the clip's length.
 */
export function findBlockRepeat(samples: ArrayLike<number>, sampleRate: number): BlockRepeatVerdict {
  const block = Math.round(sampleRate / 100);
  const step = Math.max(1, Math.round(block / 40));
  let best: BlockRepeat | null = null;
  let heardEnough = false;
  for (const factor of FACTORS) {
    const group = block * factor;
    const starts = loudGroups(samples, group);
    if (starts.length < MIN_GROUPS) continue;
    heardEnough = true;
    for (let phase = 0; phase < group; phase += step) {
      const sc = score(samples, starts, phase, block, factor);
      if (sc.n < MIN_GROUPS) continue;
      if (best && sc.within <= best.within) continue;
      if (sc.within >= MIN_WITHIN && sc.within - sc.across >= MIN_GAP) {
        best = { factor, block, phase, within: sc.within, across: sc.across };
      }
    }
  }
  if (best) return holdsThroughout(samples, best) ? best : 'none';
  return heardEnough ? 'none' : null;
}

/** Length of `n` samples once the copies are dropped. */
export function blockRepeatLength(n: number, r: BlockRepeat): number {
  if (n <= r.phase) return n;
  const group = r.block * r.factor;
  const whole = Math.floor((n - r.phase) / group);
  const rest = Math.min(r.block, (n - r.phase) - whole * group);
  return r.phase + whole * r.block + rest;
}

/** Keeps the first copy of every block: the stream as it was spoken. */
export function removeBlockRepeat<T extends Float32Array | Int16Array>(samples: T, r: BlockRepeat): T {
  const out = new (samples.constructor as { new (n: number): T })(blockRepeatLength(samples.length, r));
  const group = r.block * r.factor;
  const head = Math.min(r.phase, samples.length);
  out.set(samples.subarray(0, head) as never, 0);
  let w = head;
  for (let at = r.phase; at < samples.length; at += group) {
    const end = Math.min(samples.length, at + r.block);
    out.set(samples.subarray(at, end) as never, w);
    w += end - at;
  }
  return out;
}
