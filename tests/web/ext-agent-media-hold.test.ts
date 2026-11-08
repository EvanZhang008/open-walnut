/**
 * An agent's tab keeps its media from playing by itself, and lets the agent's own click on
 * Play through (packages/browser-extension/src/agent-media.ts). Tested here, in a stand-in
 * page, because a test browser never plays media at all (src/lib/automation-silence.ts), so
 * tests/e2e/browser/extension-agent-net.spec.ts can only see that the click asked to play.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../packages/browser-extension/src/ext', () => ({ ext: {} }));
vi.mock('../../packages/browser-extension/src/agent-api', () => ({ more: {} }));
vi.mock('../../packages/browser-extension/src/agent-shared', () => ({ agentTabs: { get: async () => undefined }, personsTab: () => false }));

class FakeMedia { paused = false; autoplay = true; pauses = 0; pause() { this.paused = true; this.pauses++; } }

function page(elements: FakeMedia[]) {
  const win: Record<string, Array<() => void>> = {};
  const doc: Record<string, Array<(e: { target: unknown }) => void>> = {};
  vi.stubGlobal('HTMLMediaElement', FakeMedia);
  vi.stubGlobal('window', {});
  vi.stubGlobal('addEventListener', (t: string, f: () => void) => { (win[t] ||= []).push(f); });
  vi.stubGlobal('document', {
    readyState: 'complete',
    addEventListener: (t: string, f: (e: { target: unknown }) => void) => { (doc[t] ||= []).push(f); },
    querySelectorAll: () => elements,
  });
  return {
    press: (t = 'click') => win[t]?.forEach((f) => f()),
    play: (el: FakeMedia) => { el.paused = false; doc.play?.forEach((f) => f({ target: el })); },
  };
}

describe('an agent tab\'s media hold', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('pauses media that starts by itself and lets a play right after a click or key through', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const already = new FakeMedia();
    const p = page([already]);
    const { holdAutoplay, ASKED_PLAY_MS } = await import('../../packages/browser-extension/src/agent-media');
    holdAutoplay();
    // An element playing when the hold arrives (its autoplay) is paused, and autoplays no more.
    expect(already).toMatchObject({ paused: true, autoplay: false });

    const el = new FakeMedia();
    vi.setSystemTime(20_000);
    p.play(el);
    expect(el.pauses, 'a play no one asked for').toBe(1);

    for (const key of ['click', 'keydown', 'pointerdown']) {
      p.press(key);
      vi.setSystemTime(Date.now() + ASKED_PLAY_MS - 100);
      p.play(el);
      expect(el.paused, `a play right after a ${key}`).toBe(false);
      vi.setSystemTime(Date.now() + 2 * ASKED_PLAY_MS);
      p.play(el);
      expect(el.paused, `a play long after a ${key}`).toBe(true);
    }
  });
});
