/**
 * A short, soft two-note chime, synthesised with WebAudio (no asset file).
 *
 * Best-effort by design: no AudioContext (an old WebView), an autoplay policy that
 * refuses to start audio before a gesture, or a suspended device all end in
 * silence, never in an error. The context is created once and reused, because a
 * browser caps how many a page may open.
 */

type Ctx = AudioContext;
let ctx: Ctx | null = null;
/** One pending "park the device" timer: a second chime must not be cut by the first's. */
let parkTimer: ReturnType<typeof setTimeout> | null = null;

function audioContext(): Ctx | null {
  if (ctx) return ctx;
  const Ctor = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
    .AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }
  return ctx;
}

/** One sine note with a fast attack and an exponential tail, so it never clicks. */
function note(c: Ctx, freq: number, start: number, length: number, peak: number): void {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  osc.connect(gain).connect(c.destination);
  osc.start(start);
  osc.stop(start + length + 0.05);
}

/**
 * Unlock audio on the human's first gesture. A reminder arrives over the
 * WebSocket, never inside a click, and a context first created outside a gesture
 * starts suspended in most browsers; creating and resuming it on the first
 * pointer/key press means the later chime can actually sound. It is suspended
 * again right away: a running context keeps the audio device awake for nothing.
 * Returns a cleanup.
 */
export function armChime(): () => void {
  if (typeof window === 'undefined') return () => {};
  const unlock = () => {
    disarm();
    try {
      const c = audioContext();
      if (c && c.state === 'suspended') void c.resume().then(() => c.suspend()).catch(() => {});
    } catch { /* no audio on this device */ }
  };
  const disarm = () => {
    window.removeEventListener('pointerdown', unlock, true);
    window.removeEventListener('keydown', unlock, true);
  };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
  return disarm;
}

export function playChime(kind: 'reminder'): void {
  void kind; // one voice today; the parameter names the call site's intent
  try {
    const c = audioContext();
    if (!c) return;
    const play = () => {
      const t = c.currentTime + 0.01;
      note(c, 880, t, 0.35, 0.08);        // A5
      note(c, 1318.5, t + 0.16, 0.5, 0.06); // E6, a fifth above
      // Park the device once the tail has rung out (see armChime).
      if (parkTimer) clearTimeout(parkTimer);
      parkTimer = setTimeout(() => { parkTimer = null; void c.suspend().catch(() => {}); }, 1_200);
    };
    if (c.state === 'suspended') {
      c.resume().then(play, () => { /* autoplay refused: stay silent */ });
      return;
    }
    play();
  } catch {
    // Audio is decoration here; nothing about the reminder depends on it.
  }
}
