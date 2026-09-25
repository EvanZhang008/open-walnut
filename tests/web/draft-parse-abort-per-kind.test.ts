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
  calls: [] as Array<{ text: string; signal: AbortSignal; resolve: (parse: unknown) => void }>,
  /** Set by the ChatInput stub — the composer's text mirror (`onValueChange`). */
  typeInto: null as null | ((text: string) => void),
  /** The props the launch bar stub last received. */
  barProps: null as null | Record<string, unknown>,
}));

vi.mock('@/api/tasks', () => ({
  quickParseTask: (text: string, signal?: AbortSignal) =>
    // Pending until a case resolves it: unresolved, the request holds its slot
    // exactly as a 10s server timeout would.
    new Promise((resolve) => { spy.calls.push({ text, signal: signal!, resolve }); }),
}));

// The effect is gated off unless `agent.quick_parse` is on. The real hook reads
// config over the network; these cases are about abort bookkeeping, so the flag is
// pinned on. (Its own behaviour — default off, persistence, sibling keys — is
// covered in tests/web/quick-parse-toggle.test.ts.)
vi.mock('@/hooks/useQuickParse', () => ({
  useQuickParseEnabled: () => true,
  setQuickParseEnabled: () => {},
  ensureQuickParseLoaded: async () => {},
}));

// A keystroke is "the composer told the panel its new text" — nothing else about
// ChatInput matters here, and the real one is a whole editor.
vi.mock('@/components/chat/ChatInput', () => ({
  ChatInput: ({ onValueChange }: { onValueChange: (t: string) => void }) => {
    spy.typeInto = onValueChange;
    // A div, not a textarea: React's input-event polyfill trips on linkedom's
    // text controls. The panel only matches the class.
    return createElement('div', { className: 'chat-input-stub' },
      createElement('div', { className: 'chat-input-textarea', tabIndex: 0 }));
  },
}));

// Launch bar / slash commands / the bound task kebab are unrelated surfaces;
// keep them out of the mount. The stubs matter for the harness: the real draft
// menu (reached only through DraftLaunchBar, never imported by the panel) and the
// task kebab reach the markdown renderer, and DOMPurify's hook registration at
// module load has no window under linkedom. The bar stub records its props.
vi.mock('@/components/sessions/DraftLaunchBar', () => ({
  DraftLaunchBar: (props: Record<string, unknown>) => {
    spy.barProps = props;
    return createElement('div', { className: 'draft-launch-bar-stub' });
  },
}));
vi.mock('@/components/sessions/TaskQuickActions', () => ({
  TaskQuickActions: () => createElement('div', { className: 'task-quick-actions-stub' }),
}));
// The bound-draft project follower reads the task store; these drafts are unbound.
vi.mock('@/contexts/TasksContext', () => ({ useStoreTask: () => null }));
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
    spy.barProps = null;
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
  async function mountPanel(
    onAiParse: (...args: unknown[]) => void = () => {},
    extra: Record<string, unknown> = {},
  ): Promise<void> {
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
        onAiParse,
        ...extra,
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

  // ── Parse kinds and the debounced clear (spec 6.2.0, 6.3; C51 C52) ──

  const clearCalls = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.filter((c) => c[2] === 'clear');

  it('(a) an empty composer that comes back inside the debounce never reports a clear', async () => {
    // Starting state: a sentence typed, both parses pending. This is the refused
    // Start round trip: dispatchSend empties the composer, then restores it.
    const onAiParse = vi.fn();
    await mountPanel(onAiParse);
    await type(SENTENCE);
    await advance(PARSE_DEBOUNCE_MS);
    await type('');
    await advance(50);
    await type(SENTENCE);
    await advance(PARSE_DEBOUNCE_MS * 4);
    expect(clearCalls(onAiParse)).toHaveLength(0);
  });

  it('(b) an empty composer that stays empty past the debounce reports exactly one clear', async () => {
    const onAiParse = vi.fn();
    await mountPanel(onAiParse);
    const eager = await type(SENTENCE);
    await type('');
    expect(eager[0].signal.aborted, 'emptying still aborts what is in flight').toBe(true);
    await advance(PARSE_DEBOUNCE_MS - 1);
    expect(clearCalls(onAiParse), 'not before the debounce').toHaveLength(0);
    await advance(2);
    await advance(PARSE_DEBOUNCE_MS * 4);
    expect(clearCalls(onAiParse)).toEqual([['draft:test-1', {}, 'clear']]);
  });

  it('(b2) a parse that lands after the clear is ignored (the seq bump comes first)', async () => {
    const onAiParse = vi.fn();
    await mountPanel(onAiParse);
    const eager = await type(SENTENCE);
    await type('');
    await advance(PARSE_DEBOUNCE_MS + 1);
    await act(async () => { eager[0].resolve({ title: 'x', pinTier: 'satellite' }); });
    expect(onAiParse.mock.calls.map((c) => c[2])).toEqual(['clear']);
  });

  it('(c) eager lands as eager; trailing as trailing while the text matches, else as eager', async () => {
    const onAiParse = vi.fn();
    await mountPanel(onAiParse);
    const [eager] = await type(SENTENCE);
    await act(async () => { eager.resolve({ title: 'x', pinTier: 'satellite' }); });
    expect(onAiParse.mock.calls.at(-1)).toEqual(['draft:test-1', { title: 'x', pinTier: 'satellite' }, 'eager']);

    const [trailing] = await advance(PARSE_DEBOUNCE_MS);
    await act(async () => { trailing.resolve({ title: 'x' }); });
    expect(onAiParse.mock.calls.at(-1)).toEqual(['draft:test-1', { title: 'x' }, 'trailing']);

    // A trailing parse the user has typed past describes a prefix: it still
    // lands (today's drop is gone) but may only add or change, like an eager one.
    await advance(PARSE_THROTTLE_MS);
    const later = `${SENTENCE} tomorrow`;
    await type(later);
    const [stale] = await advance(PARSE_DEBOUNCE_MS);
    expect(stale.text).toBe(later);
    await type(`${later} please`);
    await act(async () => { stale.resolve({ title: 'y', priority: 'important' }); });
    expect(onAiParse.mock.calls.at(-1)).toEqual(['draft:test-1', { title: 'y', priority: 'important' }, 'eager']);
    expect(clearCalls(onAiParse)).toHaveLength(0);
  });

  it('Mod+. inside the composer bumps the menu nonce on the launch bar', async () => {
    await mountPanel(() => {}, { onWalnutToggle: () => {}, onTaskFieldChange: () => {} });
    expect(spy.barProps?.openMenuNonce).toBe(0);
    expect(spy.barProps?.onTaskFieldChange).toBeTypeOf('function');
    const textarea = doc.querySelector('.chat-input-textarea')!;
    const mac = /Mac|iP/.test(globalThis.navigator?.platform ?? '');
    const ev = new (doc.defaultView as unknown as { Event: typeof Event }).Event('keydown', { bubbles: true, cancelable: true });
    Object.assign(ev, { key: '.', metaKey: mac, ctrlKey: !mac, shiftKey: false, altKey: false });
    await act(async () => { textarea.dispatchEvent(ev); });
    expect(spy.barProps?.openMenuNonce).toBe(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('a plain draft passes the task-field handlers; a fork draft does not', async () => {
    await mountPanel(() => {}, {
      onTaskFieldChange: () => {}, onReturnFieldToWalnut: () => {},
      draft: { id: 'draft:fork-1', cwd: '/tmp/acme', host: null, meta: {}, forkOf: { sessionId: 's1', title: 't' } },
    });
    expect(spy.barProps?.onTaskFieldChange).toBeUndefined();
    expect(spy.barProps?.onReturnFieldToWalnut).toBeUndefined();
  });
});
