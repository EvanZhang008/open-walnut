/**
 * The waiting cue: a soft two-note chime that repeats while voice mode waits for the
 * session to say something, so the person hears that it is working (the first words of
 * a turn that runs tools can take seconds).
 *
 * Made with Web Audio (two sine notes with a smooth attack and release, at a low
 * gain), no audio file. It plays into the node it is given, the speaker's output
 * analyser, so whatever measures the voice's own output hears the cue too. It stops at
 * once: a note still sounding fades out in a few milliseconds. It goes quiet by itself
 * after `MAX_MS` (a turn that works that long needs no metronome), and makes no notes
 * while the audio context is not running.
 */

/** The first chime waits this long, so an answer that comes quickly gets no chime at all. */
const FIRST_MS = 700;
/** One chime every this often. */
const PERIOD_MS = 1800;
/** No chime after this long in one wait. */
const MAX_MS = 60_000;
/** Peak loudness of a note (0..1): quiet, under the voice. */
const PEAK = 0.045;
/** The two notes (C5 then E5) and when the second starts, in seconds. */
const NOTES: { hz: number; at: number }[] = [{ hz: 523.25, at: 0 }, { hz: 659.25, at: 0.16 }];
const ATTACK_S = 0.03;
const RELEASE_S = 0.55;

export class WaitingCue {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private notes: { osc: OscillatorNode; gain: GainNode }[] = [];
  /** This wait ran past MAX_MS: quiet until stop() ends the wait. */
  private spent = false;

  constructor(private readonly ctx: AudioContext, private readonly out: AudioNode) {}

  /** A chime is due or sounding. */
  get playing(): boolean {
    return this.timer !== null || this.notes.length > 0;
  }

  start(): void {
    if (this.timer !== null || this.spent) return;
    const since = Date.now();
    const tick = () => {
      if (Date.now() - since > MAX_MS) { this.timer = null; this.spent = true; return; }
      this.chime();
      this.timer = setTimeout(tick, PERIOD_MS);
    };
    this.timer = setTimeout(tick, FIRST_MS);
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.spent = false;
    const now = this.ctx.currentTime;
    for (const { osc, gain } of this.notes) {
      try {
        gain.gain.cancelScheduledValues(now);
        gain.gain.setTargetAtTime(0, now, 0.01);
        osc.stop(now + 0.06);
      } catch { /* already stopped */ }
    }
    this.notes = [];
  }

  private chime(): void {
    // A suspended context would only pile the notes up to sound at once later.
    if (this.ctx.state !== 'running') {
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
      return;
    }
    const now = this.ctx.currentTime;
    for (const note of NOTES) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = note.hz;
      const start = now + note.at;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(PEAK, start + ATTACK_S);
      // An exponential-like fade to silence: soft, no click at the end.
      gain.gain.setTargetAtTime(0, start + ATTACK_S, RELEASE_S / 4);
      osc.connect(gain);
      gain.connect(this.out);
      osc.start(start);
      osc.stop(start + ATTACK_S + RELEASE_S + 0.1);
      const entry = { osc, gain };
      this.notes.push(entry);
      osc.onended = () => {
        this.notes = this.notes.filter((n) => n !== entry);
        try { gain.disconnect(); } catch { /* gone */ }
      };
    }
  }
}
