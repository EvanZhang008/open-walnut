import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { act, createElement, Fragment } from '../../web/node_modules/react/index.js';
import { createRoot, type Root } from '../../web/node_modules/react-dom/client.js';
import { useFullscreen } from '../../web/src/hooks/useFullscreen';
import { claimFullscreen, detachFullscreen, fullscreenPlace, newFullscreenId, resetFullscreenOwner } from '../../web/src/hooks/fullscreen-owner';

import { MemoryRouter } from '../../web/node_modules/react-router-dom/dist/index.mjs';
vi.mock('../../web/src/utils/interaction-timer', () => ({ traceInteraction: () => {} }));
vi.mock('../../web/src/hooks/useHidesHighlights', () => ({ useHidesHighlights: () => {} }));
vi.mock('../../web/src/hooks/usePanelKeyRouter', () => ({ keyTargetClaimsEscape: () => false }));
vi.mock('../../web/src/utils/escape-beep-guard', () => ({ escapeWasConsumedByOthers: () => false }));

let root: Root | undefined;
let host: HTMLElement;
let phone = false;
let current: ReturnType<typeof useFullscreen>;
const listeners = new Set<() => void>();
const PLACE = 'home-column|phone-fit-session';

async function mount(phoneLayer = true, remembered = false): Promise<void> {
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: phone, addEventListener: (_: string, f: () => void) => listeners.add(f), removeEventListener: (_: string, f: () => void) => listeners.delete(f) }));
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) });
  resetFullscreenOwner();
  if (remembered) {
    const previous = newFullscreenId();
    claimFullscreen(previous, PLACE);
    detachFullscreen(previous);
  }
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  function Sheet() {
    current = useFullscreen({ keepAcrossRoutes: true, place: PLACE, phoneLayer });
    return createElement(Fragment, null,
      current.FullscreenBackdrop,
      createElement('section', { className: current.fullscreenClass, 'data-held': String(current.isFullscreen) }, 'Kept file and draft'),
    );
  }
  await act(async () => root!.render(createElement(MemoryRouter, { initialEntries: ['/'] }, createElement(Sheet))));
}

async function resize(narrow: boolean): Promise<void> {
  await act(async () => { phone = narrow; for (const f of [...listeners]) f(); });
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  resetFullscreenOwner();
  listeners.clear();
  phone = false;
  vi.unstubAllGlobals();
});

describe('a phone layer keeps the desktop fullscreen place without drawing over it', () => {
  it('wide, narrow, wide keeps one owner, removes the desktop backdrop and restores it', async () => {
    await mount();
    await act(async () => current.enterFullscreen());
    expect(document.querySelectorAll('.open-walnut-fullscreen-backdrop')).toHaveLength(1);
    expect(host.querySelector('section')?.className).toContain('open-walnut-fullscreen');
    expect(document.body.style.overflow).toBe('hidden');
    for (let round = 0; round < 3; round++) {
      await resize(true);
      expect(current.isFullscreen).toBe(true);
      expect(current.shownFullscreen).toBe(false);
      expect(fullscreenPlace()).toBe(PLACE);
      expect(host.querySelector('section')?.className).toBe('');
      expect(document.querySelector('.open-walnut-fullscreen-backdrop')).toBeNull();
      expect(document.body.style.overflow).toBe('');
      expect(host.textContent).toBe('Kept file and draft');
      await resize(false);
      expect(current.isFullscreen).toBe(true);
      expect(current.shownFullscreen).toBe(true);
      expect(fullscreenPlace()).toBe(PLACE);
      expect(document.querySelectorAll('.open-walnut-fullscreen-backdrop')).toHaveLength(1);
      expect(host.querySelector('section')?.className).toContain('open-walnut-fullscreen');
      expect(document.body.style.overflow).toBe('hidden');
    }
  });

  it('a narrow remount of a remembered desktop place draws no covering backdrop', async () => {
    phone = true;
    await mount(true, true);
    expect(current.isFullscreen).toBe(true);
    expect(current.shownFullscreen).toBe(false);
    expect(fullscreenPlace()).toBe(PLACE);
    expect(document.querySelector('.open-walnut-fullscreen-backdrop')).toBeNull();
    expect(host.querySelector('section')?.className).toBe('');
    await resize(false);
    expect(document.querySelectorAll('.open-walnut-fullscreen-backdrop')).toHaveLength(1);
  });

  it('a sheet with no phone layer still draws its fullscreen sheet at phone width', async () => {
    phone = true;
    await mount(false);
    await act(async () => current.enterFullscreen());
    expect(current.shownFullscreen).toBe(true);
    expect(document.querySelectorAll('.open-walnut-fullscreen-backdrop')).toHaveLength(1);
    expect(host.querySelector('section')?.className).toContain('open-walnut-fullscreen');
  });

  it('an explicit exit at phone width clears the remembered place', async () => {
    await mount();
    await act(async () => current.enterFullscreen());
    await resize(true);
    await act(async () => current.exitFullscreen());
    expect(fullscreenPlace()).toBeNull();
    await resize(false);
    expect(current.isFullscreen).toBe(false);
    expect(document.querySelector('.open-walnut-fullscreen-backdrop')).toBeNull();
  });

  it('phone Escape does not release the desktop place, but opening another column does', async () => {
    await mount();
    await act(async () => current.enterFullscreen());
    await resize(true);
    const escape = new window.Event('keydown', { bubbles: true });
    Object.defineProperty(escape, 'key', { value: 'Escape' });
    await act(async () => document.dispatchEvent(escape));
    expect(fullscreenPlace()).toBe(PLACE);
    await act(async () => window.dispatchEvent(new window.Event('fullscreen:yield')));
    expect(fullscreenPlace()).toBeNull();
    await resize(false);
    expect(document.querySelector('.open-walnut-fullscreen-backdrop')).toBeNull();
  });

  it('the session panel names both its own and its hosted phone layer', () => {
    const source = readFileSync(new URL('../../web/src/components/sessions/SessionPanel.tsx', import.meta.url), 'utf8');
    expect(source).toMatch(/useFullscreen\(\{[^\n]+phoneLayer:\s*!!\(phoneLayer\s*\|\|\s*phoneHostSlot\)/);
  });

  it('desktop-only panel behavior reads the drawn sheet, never its remembered owner', () => {
    const source = readFileSync(new URL('../../web/src/components/sessions/SessionPanel.tsx', import.meta.url), 'utf8');
    expect(source).toContain('enabled: !inset && shownFullscreen');
    expect(source).toContain('const chatTaskClick = !inset && shownFullscreen && session?.taskId ? openPeekFromChat : onTaskClick;');
    expect(source).toContain('onTaskCompleted && !shownFullscreen');
    expect(source).toContain('onOpenTask={shownFullscreen ? peek.open : (onTaskClick ?? onLocateTask)}');
    expect(source).not.toMatch(/on(?:OpenTask|TaskClick)=\{(?:peek\.open|openPeekFromChat)\}/);
    const ownerReads = source.split('\n').map((line) => line.trim()).filter((line) => /\bisFullscreen\b/.test(line));
    expect(ownerReads).toEqual([
      'const { isFullscreen, shownFullscreen, enterFullscreen, exitFullscreen, fullscreenClass, FullscreenBackdrop } = useFullscreen({ keepAcrossRoutes: true, place: sheetAt, phoneLayer: !!(phoneLayer || phoneHostSlot) });',
      'if (isFullscreen || !splitOpen || isPhoneLayout() || fullscreenPlace() === sheetAt) return;',
      '}, [isFullscreen, splitOpen, sheetAt, setActiveView, setFileViewTarget]);',
      'if (!phoneWidth && !isFullscreen) {',
      '}, [phoneWidth, activeView, applyOpenCollapse, isFullscreen, enterFullscreen]);',
    ]);
  });
});
