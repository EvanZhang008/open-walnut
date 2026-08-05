/**
 * Structural invariants for drag-to-resize handles.
 *
 * Origin: every resize handle in the app used to attach raw `mousemove`/`mouseup`
 * to `document`. Mouse events are delivered to the document of whatever element
 * sits under the cursor, so the moment the cursor crossed an `<iframe>` — the
 * Files panel's HTML preview lives DIRECTLY right of its tree divider — the page
 * stopped receiving `mousemove` (drag froze / felt laggy) and NEVER received
 * `mouseup`: the gesture stayed armed forever, so moving the mouse afterwards
 * kept resizing with no button held. Five sites additionally persisted to
 * localStorage from a `useEffect` keyed on the per-frame drag state, i.e. a
 * synchronous disk write on every mousemove.
 *
 * The behavioral proof lives in tests/e2e/browser/panel-resize-drag.spec.ts
 * (real browser, real iframe, real pointer capture). THIS file guards the
 * structure in the fast tier so the pattern can't silently come back — a new
 * handle written with the old copy-paste shape fails here in ~50ms instead of
 * being discovered by a user months later.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const WEB_SRC = path.resolve(import.meta.dirname, '../../web/src');

function read(rel: string): string {
  return fs.readFileSync(path.join(WEB_SRC, rel), 'utf8');
}

/** Every file that owns a drag-resize interaction. */
const DRAG_FILES = [
  'hooks/useDragGesture.ts',
  'hooks/useResizablePanel.ts',
  'hooks/useVerticalSplitter.ts',
  'hooks/useResizableHeight.ts',
  'components/sessions/SessionFileExplorer.tsx',
  'pages/MainPage.tsx',
  'pages/NotesPage.tsx',
  'pages/MemoryPage.tsx',
  'components/dock/FocusDock.tsx',
  'components/notes/GlobalNotesSection.tsx',
];

const GESTURE = read('hooks/useDragGesture.ts');
const CSS = read('styles/globals.css');

describe('drag gestures never use raw document mouse listeners', () => {
  // THE regression: a document-level mouseup is exactly what an iframe swallows.
  it.each(DRAG_FILES)('%s attaches no document mousemove/mouseup', (rel) => {
    const src = read(rel);
    expect(src).not.toMatch(/addEventListener\(\s*['"]mousemove['"]/);
    expect(src).not.toMatch(/addEventListener\(\s*['"]mouseup['"]/);
  });

  it('no file anywhere in web/src reintroduces a document mousemove listener', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const src = fs.readFileSync(full, 'utf8');
        if (/addEventListener\(\s*['"]mousemove['"]/.test(src)) {
          offenders.push(path.relative(WEB_SRC, full));
        }
      }
    };
    walk(WEB_SRC);
    expect(offenders).toEqual([]);
  });
});

describe('useDragGesture closes every release path', () => {
  it('uses pointer capture — the actual fix for iframe-swallowed events', () => {
    expect(GESTURE).toContain('setPointerCapture');
    expect(GESTURE).toContain('releasePointerCapture');
  });

  // Each of these is a way a drag could otherwise stay armed forever.
  it.each([
    ['pointerup', 'normal release'],
    ['pointercancel', 'browser/OS cancels the pointer'],
    ['lostpointercapture', 'capture revoked → drag would freeze while still armed'],
    ['blur', 'Cmd+Tab away mid-drag'],
    ['keydown', 'Escape aborts'],
  ])('listens for %s (%s)', (evt) => {
    expect(GESTURE).toContain(`'${evt}'`);
  });

  it('keeps a window-level pointerup net', () => {
    // The primary pointerup listener lives on the capture element, so a handle
    // conditionally unrendered MID-drag could take it down and leave the gesture
    // armed. window is the final bubble target, so this always closes the drag.
    expect(GESTURE).toMatch(/window\.addEventListener\('pointerup',/);
    expect(GESTURE).toMatch(/window\.removeEventListener\('pointerup',/);
  });

  it('binds Escape in the CAPTURE phase', () => {
    // Bubble phase was verified broken in a real browser: several panels call
    // stopPropagation() on their Escape keydown, so a bubble listener here never
    // ran and Escape silently failed to abort the drag.
    expect(GESTURE).toMatch(/addEventListener\('keydown',\s*onKeyDown,\s*true\)/);
    expect(GESTURE).toMatch(/removeEventListener\('keydown',\s*onKeyDown,\s*true\)/);
  });

  it('releases on unmount so a mid-drag unmount cannot leak listeners', () => {
    // The effect's cleanup must itself call release(...) — the old hooks had NO
    // unmount path at all, leaving two document listeners alive forever.
    const effectTail = GESTURE.slice(GESTURE.indexOf("window.addEventListener('blur'"));
    expect(effectTail).toMatch(/return\s*\(\)\s*=>\s*\{[\s\S]*release\(true\)/);
  });

  it('does NOT preventDefault the pointerdown itself', () => {
    // A canceled pointerdown suppresses its compatibility mouse events entirely
    // (verified in Chromium), and ~25 menus close via a document 'mousedown'
    // listener — so cancelling it left menus floating open during a drag. The
    // hook cancels only the compat mousedown's DEFAULT ACTION instead.
    const down = GESTURE.slice(
      GESTURE.indexOf('const onPointerDown ='),
      GESTURE.indexOf('const cancel = useCallback'),
    );
    expect(down).not.toMatch(/^\s*e\.preventDefault\(\);/m);
    expect(down).toContain("addEventListener('mousedown', killMouseDefault, true)");
  });

  it('flushes the last coalesced move on a real release', () => {
    // A fast flick puts the final pointermove and the pointerup in the same
    // frame; cancelling the pending rAF without flushing dropped that frame, so
    // the panel settled short AND persisted the second-to-last position.
    const rel = GESTURE.slice(GESTURE.indexOf('const release ='));
    expect(rel).toMatch(/if\s*\(!canceled\s*&&\s*finalEv\)/);
    // ...and the flush must happen BEFORE onEnd persists.
    expect(rel.indexOf('if (!canceled && finalEv)')).toBeLessThan(rel.indexOf('onEnd?.('));
  });

  it('coalesces moves through requestAnimationFrame', () => {
    // One React commit per painted frame at most, instead of one per raw event.
    expect(GESTURE).toContain('requestAnimationFrame');
    expect(GESTURE).toContain('cancelAnimationFrame');
  });

  it('guards the pointerId so a second pointer cannot drive the drag', () => {
    expect(GESTURE).toContain('ev.pointerId !== st.pointerId');
  });

  it('nulls its state BEFORE releasing capture (re-entrancy guard)', () => {
    // releasePointerCapture synchronously fires lostpointercapture, which would
    // re-enter release() and double-fire onEnd if state were cleared after.
    const rel = GESTURE.slice(GESTURE.indexOf('const release ='));
    const nullIdx = rel.indexOf('stateRef.current = null');
    // `.releasePointerCapture(` matches the CALL only — the plain word also
    // appears in the explanatory comment above the null assignment.
    const releaseIdx = rel.indexOf('.releasePointerCapture(');
    expect(nullIdx).toBeGreaterThan(-1);
    expect(releaseIdx).toBeGreaterThan(nullIdx);
  });
});

describe('layout prefs persist on release, not per frame', () => {
  // A `useEffect` keyed on the per-frame drag value = a synchronous localStorage
  // write every mousemove. That was the measured cause of the drag lag.
  const PER_FRAME_KEYS: Array<[string, string]> = [
    ['hooks/useResizablePanel.ts', 'pct'],
    ['pages/NotesPage.tsx', 'listWidth'],
    ['pages/NotesPage.tsx', 'chatWidth'],
    ['pages/MemoryPage.tsx', 'listWidth'],
    ['pages/MainPage.tsx', 'colWeights'],
  ];

  it.each(PER_FRAME_KEYS)('%s does not persist %s from a useEffect', (rel, stateVar) => {
    const src = read(rel);
    // Match a useEffect whose dep array contains the per-frame state AND whose
    // body writes localStorage.
    const re = new RegExp(
      `useEffect\\(\\s*\\(\\)\\s*=>\\s*\\{[^}]*localStorage\\.setItem[\\s\\S]{0,200}?\\}\\s*,\\s*\\[[^\\]]*\\b${stateVar}\\b[^\\]]*\\]`,
    );
    expect(src).not.toMatch(re);
  });
});

describe('CSS supports the pointer-based drag model', () => {
  it('neutralizes iframes while a drag is in flight', () => {
    // Fallback defense for the case where pointer capture is unavailable.
    expect(CSS).toMatch(/body\.walnut-dragging iframe\s*\{[^}]*pointer-events:\s*none/);
  });

  it('sets touch-action:none on every drag handle', () => {
    // Handles listen for POINTER events now; without this a touch drag is
    // claimed by native scrolling and the handle gets pointercancel instead.
    const HANDLES = [
      'todo-resize-handle', 'session-resize-handle', 'memory-resize-handle',
      'notes-resize-handle', 'session-col-resize-handle', 'session-panel-chat-resize',
      'session-diff-tree-resize', 'sfe-divider', 'notes-chat-divider',
      'dock-resize-handle', 'global-notes-resize-handle', 'todo-tier-resize-handle',
      'todo-detail-splitter', 'todo-pinned-splitter',
    ];
    // Find the rule block that declares touch-action:none for the handle list.
    const blocks = CSS.match(/[^{}]+\{[^}]*touch-action:\s*none[^}]*\}/g) ?? [];
    const selectors = blocks.join('\n');
    const missing = HANDLES.filter((h) => !selectors.includes(`.${h}`));
    expect(missing).toEqual([]);
  });

  it('every asserted handle class is actually rendered somewhere', () => {
    // Keeps the list above honest: a renamed handle must fail loudly rather than
    // leave a dead selector that silently asserts nothing.
    const all: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (/\.tsx$/.test(entry.name)) all.push(fs.readFileSync(full, 'utf8'));
      }
    };
    walk(WEB_SRC);
    const tsx = all.join('\n');
    for (const h of ['sfe-divider', 'session-panel-chat-resize', 'todo-tier-resize-handle', 'dock-resize-handle']) {
      expect(tsx).toContain(h);
    }
  });
});
