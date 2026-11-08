/**
 * A browser under automation makes no sound (2026-11-08: a Playwright WebKit run on
 * someone else's Mac, with a person at it, woke its built-in speaker at every first
 * click of a page, through the reminder chime's audio unlock).
 *
 * "Under automation" is `navigator.webdriver`, which every Playwright, WebDriver and
 * MCP-driven browser sets, in every frame. A person's browser and the Mac app are
 * untouched. Nothing here changes the machine's volume or mute: the page itself stops
 * reaching the speakers.
 *
 * - media elements (`<audio>`, `<video>`, `new Audio()`) are muted before they play,
 *   and stay muted when code unmutes them;
 * - Web Audio wired to the speakers goes through a gain of zero (a context still runs,
 *   so a meter, a recorder's capture node and a test's synthetic microphone work);
 * - speech is spoken at volume zero, so its events still come.
 *
 * The function is self-contained (globals only) because Walnut's own sandboxed frames
 * run it too, as source (`AUTOMATION_SILENCE_JS`), ahead of any script in them: the Board
 * and rich islands, and the Files preview's documents, which the server serves with it
 * (src/web/preview-bridge.ts). Every Playwright context runs it at document start in every
 * frame (tests/e2e/browser/pw-silence.ts). Browser-safe: the web app imports it.
 * The guard test is tests/web/automation-silence.test.ts.
 */
export function silenceAutomatedAudio(target?: unknown): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = (target || globalThis) as any;
    if (!w.navigator || w.navigator.webdriver !== true || w.__walnutSilent) return;
    w.__walnutSilent = true;

    const media = w.HTMLMediaElement && w.HTMLMediaElement.prototype;
    if (media) {
      const muted = Object.getOwnPropertyDescriptor(media, 'muted');
      if (muted && muted.get && muted.set) {
        const set = muted.set;
        Object.defineProperty(media, 'muted', {
          configurable: true,
          enumerable: muted.enumerable,
          get: muted.get,
          set: function () { set.call(this, true); },
        });
      }
      const play = media.play;
      if (typeof play === 'function') {
        media.play = function (this: { muted: boolean }) {
          try { this.muted = true; } catch { /* a detached element */ }
          // eslint-disable-next-line prefer-rest-params
          return play.apply(this, arguments);
        };
      }
      // An `autoplay` element starts without play(): mute it as it starts loading. The
      // browser's own controls unmute without the setter above: their volumechange
      // mutes it again.
      const quiet = (e: Event) => {
        const el = e.target as { muted?: boolean } | null;
        if (el && media.isPrototypeOf(el) && !el.muted) { try { el.muted = true; } catch { /* ignore */ } }
      };
      if (w.document && w.document.addEventListener) {
        w.document.addEventListener('loadstart', quiet, true);
        w.document.addEventListener('play', quiet, true);
        w.document.addEventListener('volumechange', quiet, true);
      }
    }

    const node = w.AudioNode && w.AudioNode.prototype;
    const Dest = w.AudioDestinationNode;
    if (node && Dest && typeof node.connect === 'function') {
      const connect = node.connect;
      const zero = new WeakMap();
      node.connect = function (this: unknown, target: unknown) {
        // eslint-disable-next-line prefer-rest-params
        const rest = Array.prototype.slice.call(arguments, 1);
        // An offline context renders into a buffer, never a speaker.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ctx = target instanceof Dest ? (target as any).context : null;
        if (!ctx || (w.OfflineAudioContext && ctx instanceof w.OfflineAudioContext)) {
          return connect.apply(this, [target].concat(rest));
        }
        let gain = zero.get(ctx);
        if (!gain) {
          gain = ctx.createGain();
          gain.gain.value = 0;
          connect.call(gain, target);
          zero.set(ctx, gain);
        }
        connect.apply(this, [gain].concat(rest));
        return target;
      };
    }

    const speech = w.SpeechSynthesis && w.SpeechSynthesis.prototype;
    if (speech && typeof speech.speak === 'function') {
      const speak = speech.speak;
      speech.speak = function (this: unknown, u: { volume?: number }) {
        try { if (u) u.volume = 0; } catch { /* ignore */ }
        return speak.call(this, u);
      };
    }
  } catch {
    // Best-effort: never break the page over it.
  }
}

/** The same, as source a frame's own first script runs. */
export const AUTOMATION_SILENCE_JS = `(${silenceAutomatedAudio.toString()})();`;

/** True in a browser under automation (Playwright, WebDriver, an MCP browser). */
export function automatedBrowser(): boolean {
  try {
    return typeof navigator !== 'undefined' && navigator.webdriver === true;
  } catch {
    return false;
  }
}
