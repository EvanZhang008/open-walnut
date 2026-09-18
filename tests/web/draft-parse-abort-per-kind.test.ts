/**
 * DraftSessionPanel's background parse: one AbortController PER KIND.
 *
 * The composer asks `/api/tasks/quick-parse` about the same sentence along TWO
 * paths — an EAGER one that fires mid-typing (throttled to one per
 * PARSE_THROTTLE_MS = 900ms, so the launch pills fill while the sentence is still
 * being written) and a TRAILING one that fires PARSE_DEBOUNCE_MS = 350ms after a
 * pause. Two regressions live here, in opposite directions:
 *
 *  1. ORIGINAL: nothing was aborted, so a superseded request kept its connection
 *     slot until the server's 10s timeout — one continuous sentence put ~11 parses
 *     in the air at once and took the whole six-slot pool.
 *  2. THE FIRST FIX: one SHARED controller aborted whatever was in flight before
 *     starting the next request. The trailing fire is always 350ms behind the eager
 *     one, so it cancelled the eager parse every single time — the eager feature
 *     was silently deleted while the change looked like a performance win.
 *
 * The shipped shape is `parseAbortRef.current = { eager, trailing }`: an eager
 * parse only ever supersedes the previous EAGER parse. Ceiling: 2 in flight per
 * composer.
 *
 * Harness: the real component, mounted for real (react + react-dom from
 * web/node_modules over a linkedom document — the repo has no jsdom; same import
 * trick as tests/web/setup-banner.test.ts). Only the things AROUND the effect are
 * stubbed: the composer (so a keystroke is one call to `onValueChange`), the
 * launch bar, the slash-command hook, the config flag, and `quickParseTask`
 * itself — which is the seam being observed, since the whole question is which
 * AbortSignal is aborted when. Every parse is left pending forever, modelling the
 * 10s server timeout that made the original bug expensive.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { createElement, act } from '../../web/node_modules/react/index.js';
import { createRoot } from '../../web/node_modules/react-dom/client.js';

/** Recorded parse requests, in order, with the signal the component handed us. */
const spy = vi.hoisted(() => ({
  calls: [] as Array<{ text: string; signal: AbortSignal }>,
  /** Set by the ChatInput stub — the composer's text mirror (`onValueChange`). */
  typeInto: null as null | ((text: string) => void),
}));

vi.mock('@/api/tasks', () => ({
  quickParseTask: (text: string, signal?: AbortSignal) => {
    spy.calls.push({ text, signal: signal! });
    // Never settles: the request holds its slot exactly as a 10s server timeout would.
    return new Promise(() => {});
  },
}));

// The effect is gated off unless `agent.quick_parse` is on.
vi.mock('@/api/config', () => ({
  quickParseEnabled: () => true,
  loadQuickParseEnabled: async () => true,
}));

// A keystroke is "the composer told the panel its new text" — nothing else about
// ChatInput matters here, and the real one is a whole editor.
vi.mock('@/components/chat/ChatInput', () => ({
  ChatInput: ({ onValueChange }: { onValueChange: (t: string) => void }) => {
    spy.typeInto = onValueChange;
    return createElement('div', { className: 'chat-input-stub' });
  },
}));

// Launch bar / slash commands are unrelated surfaces; keep them out of the mount.
vi.mock('@/components/sessions/DraftLaunchBar', () => ({
  DraftLaunchBar: () => createElement('div', { className: 'draft-launch-bar-stub' }),
}));
vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({
    items: [], search: () => [], refresh: () => {}, status: 'ready', onPaletteOpen: () => {},
  }),
}));

import { DraftSessionPanel } from '../../web/src/components/sessions/DraftSessionPanel';

/** PARSE_* constants in DraftSessionPanel.tsx — kept here so a change there makes
 *  these cases fail loudly instead of quietly testing the wrong window. */
const PARSE_DEBOUNCE_MS = 350;
const PARSE_THROTTLE_MS = 900;
/** Long enough to clear PARSE_MIN_CHARS (12) on the very first "keystroke". */
const SENTENCE = 'ship the release notes for the walnut board';

describe('draft composer parse: one abort controller per kind', () => {
  let doc: Document;
  let root: { render: (n: unknown) => void; unmount: () => void } | null = null;

  beforeAll(() => {
    const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>');
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = dom.window;
    g.document = dom.document;
    g.IS_REACT_ACT_ENVIRONMENT = true;
    // The panel's autoFocus effect is the only rAF user and we never enable it,
    // but React logs on a missing global in some paths — give it a real one.
    g.requestAnimationFrame ??= (cb: (t: number) => void) => setTimeout(() => cb(0), 0);
    g.cancelAnimationFrame ??= (id: number) => clearTimeout(id);
    doc = dom.document as unknown as Document;
  });

  beforeEach(() => {
    // Explicit starting state: no parses recorded, no composer bound, fake clock
    // at zero elapsed (Date.now() is faked too — the eager throttle reads it).
    spy.calls.length = 0;
    spy.typeInto = null;
    root = null;
    vi.useFakeTimers();
  });

  afterEach(async () => {
    if (root) {
      await act(async () => { root!.unmount(); });
      root = null;
    }
    vi.useRealTimers();
  });

  /** Mount the real panel with the AI backfill enabled. */
  async function mountPanel(): Promise<void> {
    const host = doc.createElement('div');
    doc.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(DraftSessionPanel, {
        draft: {
          id: 'draft:test-1',
          cwd: '/tmp/acme',
          host: null,
          meta: {},
        },
        onStart: async () => true,
        onSaveAsTask: () => {},
        onClose: () => {},
        onPathChange: () => {},
        onProjectChange: () => {},
        onMetaChange: () => {},
        isKnownProject: () => true,
        // Required, or the effect returns before firing anything.
        onAiParse: () => {},
      } as never));
    });
    expect(spy.typeInto, 'the composer stub must have been rendered').toBeTypeOf('function');
  }

  /** One keystroke burst: the composer reports new text. Returns the parses that
   *  fired SYNCHRONOUSLY with the text change — i.e. the EAGER ones. */
  async function type(text: string): Promise<Array<{ text: string; signal: AbortSignal }>> {
    const before = spy.calls.length;
    await act(async () => { spy.typeInto!(text); });
    return spy.calls.slice(before);
  }

  /** Advance the clock. Returns the parses that fired from a TIMER — i.e. trailing. */
  async function advance(ms: number): Promise<Array<{ text: string; signal: AbortSignal }>> {
    const before = spy.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    return spy.calls.slice(before);
  }

  const inFlight = () => spy.calls.filter((c) => !c.signal.aborted).length;

  it('the trailing parse does NOT abort the eager parse for the same sentence', async () => {
    // THE regression. Starting state: freshly mounted panel, nothing typed.
    await mountPanel();
    const eager = await type(SENTENCE);
    expect(eager, 'a >=12-char first keystroke fires the eager parse immediately').toHaveLength(1);
    expect(eager[0].signal.aborted).toBe(false);

    const trailing = await advance(PARSE_DEBOUNCE_MS);
    expect(trailing, 'the pause fires the trailing parse').toHaveLength(1);

    // With one shared controller the trailing fire aborted this — the eager parse
    // could never answer, so the pills never filled while typing.
    expect(eager[0].signal.aborted).toBe(false);
    expect(trailing[0].signal.aborted).toBe(false);
    expect(inFlight()).toBe(2);
  });

  it('a second eager parse DOES supersede the first eager one, leaving the trailing one alone', async () => {
    // Starting state: freshly mounted panel. Per-kind must still bound concurrency
    // — "one controller per kind" is not "never abort".
    await mountPanel();
    const eager1 = await type(SENTENCE);
    const trailing1 = await advance(PARSE_DEBOUNCE_MS);
    expect(eager1).toHaveLength(1);
    expect(trailing1).toHaveLength(1);

    // Past the throttle window, then type again → a second eager fire.
    await advance(PARSE_THROTTLE_MS);
    const eager2 = await type(`${SENTENCE} today`);
    expect(eager2, 'the throttle window has passed, so this keystroke parses eagerly').toHaveLength(1);

    expect(eager1[0].signal.aborted, 'eager supersedes eager').toBe(true);
    expect(trailing1[0].signal.aborted, 'and leaves the other kind running').toBe(false);
    expect(eager2[0].signal.aborted).toBe(false);
    expect(inFlight()).toBe(2);
  });

  it('a long typing session never exceeds 2 parses in flight, however many it fires', async () => {
    // Starting state: freshly mounted panel. This is the ORIGINAL bug's bound —
    // with no aborts at all, a continuous sentence reached ~11 in flight, each
    // holding a connection for its full 10s server timeout.
    //
    // Drive: four bursts of 15 keystrokes 60ms apart (≈900ms each, so several
    // eager windows), separated by real pauses so the TRAILING path fires too.
    // A gap-free burst would never let it fire at all — the effect reschedules
    // the 350ms timer on every keystroke — and the ceiling would trivially be 1,
    // which is exactly the shape this test must not be fooled by.
    await mountPanel();
    let text = SENTENCE;
    let eagerFires = 0;
    let trailingFires = 0;
    let maxInFlight = 0;
    const record = (where: string) => {
      expect(inFlight(), `in flight ${where}`).toBeLessThanOrEqual(2);
      maxInFlight = Math.max(maxInFlight, inFlight());
    };

    for (let burst = 0; burst < 4; burst++) {
      for (let i = 0; i < 15; i++) {
        text += i % 5 === 0 ? ' ' : 'x';
        eagerFires += (await type(text)).length;
        record(`during burst ${burst}, keystroke ${i}`);
        await advance(60);
        record(`between burst ${burst} keystrokes ${i}/${i + 1}`);
      }
      trailingFires += (await advance(PARSE_DEBOUNCE_MS + 10)).length;
      record(`after the pause ending burst ${burst}`);
    }

    // The bound is real work, not a switched-off feature: it kept asking (both
    // kinds, many times) while never holding more than two connections.
    expect(trailingFires, 'every pause finalizes the sentence').toBe(4);
    expect(eagerFires, '≈3.6s of typing spans several 900ms throttle windows')
      .toBeGreaterThanOrEqual(4);
    // Total fires ≫ 2 while in flight never passed 2 — i.e. superseded requests
    // really were aborted. Under the original (no-abort) code these two numbers
    // were the same number, because nothing ever released a slot.
    expect(spy.calls.length).toBeGreaterThanOrEqual(8);
    expect(maxInFlight, 'both kinds genuinely overlap — the ceiling is 2, not 1').toBe(2);
  });

  it('unmount aborts BOTH kinds', async () => {
    // Starting state: freshly mounted panel with one parse of each kind in flight.
    // A closed column must not leave requests holding connections.
    await mountPanel();
    const eager = await type(SENTENCE);
    const trailing = await advance(PARSE_DEBOUNCE_MS);
    expect(inFlight()).toBe(2);

    await act(async () => { root!.unmount(); });
    root = null;

    expect(eager[0].signal.aborted).toBe(true);
    expect(trailing[0].signal.aborted).toBe(true);
    expect(inFlight()).toBe(0);
  });
});
