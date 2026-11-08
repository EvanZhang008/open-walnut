/**
 * A browser under automation makes no sound and opens no audio output (2026-11-08: a
 * Playwright WebKit run on someone else's Mac, with a person near it, switched its speaker
 * on at every page's first click, through the reminder chime's audio unlock; muted output
 * was not enough: the person heard it).
 *
 * "Under automation" is `navigator.webdriver`, which every Playwright, WebDriver and
 * MCP-driven browser sets, in every frame. A person's browser and the Mac app are
 * untouched. Nothing here changes the machine's volume or mute: the page never reaches
 * an audio device at all.
 *
 * - media elements (`<audio>`, `<video>`, `new Audio()`) never play: play() rejects as an
 *   autoplay block does (`NotAllowedError`), an `autoplay` element is paused as it starts,
 *   and every element stays muted;
 * - an AudioContext gets no output device: where the engine can run one without a device
 *   (Chromium's `sinkId: { type: 'none' }`) it is made that way, so a meter, a recorder's
 *   capture node and a synthetic microphone still work; anywhere else (WebKit) making one
 *   throws `NotSupportedError`, which every caller in the web app treats as "no Web Audio",
 *   except in the WebKit voice specs, whose user agent ends ` WalnutVoiceTest` (a synthetic
 *   microphone needs a context; Macs run them only by day and muted);
 * - Web Audio wired to a destination goes through a gain of zero as well;
 * - speech is never spoken.
 *
 * `window.__walnutAudio` counts what a page tried (contexts, blocked contexts, plays,
 * speech), for the guard spec. The function is self-contained (globals only, ES5 inside)
 * because Walnut's own sandboxed frames run it too, as source (`AUTOMATION_SILENCE_JS`),
 * ahead of any script in them: the Board and rich islands, and the Files preview's
 * documents (src/web/preview-bridge.ts). Every Playwright context runs it at document start
 * in every frame (tests/e2e/browser/pw-silence.ts), and so does every run the Macs' runners
 * start, whatever branch it builds (tests/e2e/browser/pw-silence-preload.cjs, the same rules
 * in ES5, as is the iOS app's AudioSilence.webScript). The guard test is
 * tests/web/automation-silence.test.ts.
 */
export function silenceAutomatedAudio(target?: unknown): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = (target || globalThis) as any;
    if (!w.navigator || w.navigator.webdriver !== true || w.__walnutSilent) return;
    w.__walnutSilent = true;
    const tried = { contexts: 0, blocked: 0, plays: 0, speech: 0 };
    w.__walnutAudio = tried;
    const refuse = (name: string) => {
      const E = w.DOMException;
      return E ? new E('No audio in a test run', name) : new Error('No audio in a test run');
    };

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
      if (typeof media.play === 'function') {
        media.play = function (this: { muted: boolean; pause?: () => void }) {
          tried.plays++;
          try { this.muted = true; if (this.pause) this.pause(); } catch { /* a detached element */ }
          return w.Promise.reject(refuse('NotAllowedError'));
        };
      }
      // An `autoplay` element starts without play(): muted as it starts loading, paused as
      // it starts playing. The browser's own controls unmute without the setter above:
      // their volumechange mutes it again.
      const quiet = (e: Event) => {
        const el = e.target as { muted?: boolean; pause?: () => void } | null;
        if (!el || !media.isPrototypeOf(el)) return;
        try {
          if (!el.muted) el.muted = true;
          if (e.type === 'play' && el.pause) { tried.plays++; el.pause(); }
        } catch { /* ignore */ }
      };
      if (w.document && w.document.addEventListener) {
        w.document.addEventListener('loadstart', quiet, true);
        w.document.addEventListener('play', quiet, true);
        w.document.addEventListener('volumechange', quiet, true);
      }
    }

    for (const name of ['AudioContext', 'webkitAudioContext']) {
      const Native = w[name];
      if (typeof Native !== 'function' || Native.__walnutSilent) continue;
      const deviceless = !!Native.prototype && typeof Native.prototype.setSinkId === 'function';
      const Silent = function (this: unknown, options?: Record<string, unknown>) {
        tried.contexts++;
        if (!deviceless) {
          // The WebKit voice specs (VOICE_TEST_SPECS in tests/web/automation-silence.test.ts)
          // need a context for their synthetic microphone and the app's meter: they say so in
          // their user agent, and only reach the destination through the gain of zero below.
          if (/ WalnutVoiceTest$/.test(String((w.navigator && w.navigator.userAgent) || ''))) return new Native(options);
          tried.blocked++;
          throw refuse('NotSupportedError');
        }
        const opts: Record<string, unknown> = {};
        if (options) for (const k in options) opts[k] = options[k];
        opts.sinkId = { type: 'none' };
        return new Native(opts);
      } as unknown as { prototype: unknown; __walnutSilent?: boolean };
      Silent.prototype = Native.prototype;
      Silent.__walnutSilent = true;
      // A context made without a device is never moved onto one.
      if (deviceless) Native.prototype.setSinkId = function () { return w.Promise.resolve(); };
      w[name] = Silent;
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
      speech.speak = function () { tried.speech++; };
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
