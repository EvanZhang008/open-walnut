/**
 * TaskActionMenuItems' draft-only props (the draft menu, DraftTaskMenuPopover):
 * a lit tier or priority ACCEPTS on click, a trailing "Don't pin", icon + label
 * priority buttons, the caller's date format, a tier heading and "Use Walnut's
 * pick" rows. Without those props every row behaves as on the board kebab.
 *
 * Mounted with React under linkedom. Every import of TaskKebabMenu.tsx that
 * reaches the network, the task store or the markdown renderer is stubbed:
 * DOMPurify registers hooks at module load and linkedom has no window for it.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { createElement, act } from '../../web/node_modules/react/index.js';
import { createRoot } from '../../web/node_modules/react-dom/client.js';

vi.mock('@/contexts/FocusBarContext', () => ({ useFocusBarContextSafe: () => null }));
vi.mock('@/hooks/useProjectRegistry', () => ({ useProjectRegistry: () => ({ projects: [] }) }));
vi.mock('@/hooks/useShowPriority', () => ({ useShowPriority: () => true, useShowPriorityState: () => true }));
vi.mock('@/hooks/useIntegrations', () => ({ getIntegrationMeta: () => undefined, useIntegrations: () => [] }));
vi.mock('@/utils/session-status', () => ({ resolveTaskSessionId: () => undefined }));
vi.mock('@/components/tasks/PluginFieldPicker', () => ({ PluginFieldsSection: () => null }));
vi.mock('@/components/tasks/QuoteInSessionItem', () => ({ QuoteInSessionItem: () => null }));
vi.mock('@/api/sessions', () => ({ peekWorkingDirs: () => null }));

const { TaskActionMenuItems } = await import('../../web/src/components/tasks/TaskKebabMenu');
const { draftMoreTitle } = await import('../../web/src/components/sessions/DraftDecisionRow');
const { formatDateDisplay } = await import('../../web/src/components/common/DatePicker');

let doc: Document;
let win: Window & typeof globalThis;
let root: { render: (n: unknown) => void; unmount: () => void } | null = null;

beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>');
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.document;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.requestAnimationFrame ??= (cb: (t: number) => void) => setTimeout(() => cb(0), 0);
  g.cancelAnimationFrame ??= (id: number) => clearTimeout(id);
  doc = dom.document as unknown as Document;
  win = dom.window as unknown as Window & typeof globalThis;
});

afterEach(async () => {
  if (root) { await act(async () => { root!.unmount(); }); root = null; }
  doc.body.innerHTML = '';
});

type Props = Record<string, unknown>;
function spies() {
  return {
    onPinWithTier: vi.fn(), onUnpinTask: vi.fn(), onSetTier: vi.fn(), onSetPriority: vi.fn(),
    onSetDate: vi.fn(), onSetStartDate: vi.fn(), afterAction: vi.fn(),
  };
}

async function mount(props: Props): Promise<HTMLElement> {
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(createElement(TaskActionMenuItems as never, props)); });
  return host;
}

async function click(el: Element | null | undefined): Promise<void> {
  expect(el).toBeTruthy();
  await act(async () => { el!.dispatchEvent(new win.Event('click', { bubbles: true })); });
}

const tierBtn = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll('.task-kebab-tier-btn')].find((b) => b.textContent?.trim() === label);
const priorityBtns = (host: HTMLElement) => [...host.querySelectorAll('.task-kebab-priority-options button')];

const TASK = { priority: 'immediate', start_date: undefined, due_date: '2026-09-26' };

describe('TaskActionMenuItems without the draft props (board kebab)', () => {
  it('the lit tier unpins, there is no "Don\'t pin", priority is the icon alone', async () => {
    const s = spies();
    const host = await mount({ task: TASK, isPinned: true, pinnedTier: 'satellite', isDone: false, ...s });
    expect(host.querySelector('.task-kebab-tier-label')!.textContent).toBe('Pinned');
    const lit = tierBtn(host, 'Satellite')!;
    expect(lit.getAttribute('title')).toBe('Unpin from Satellite');
    await click(lit);
    expect(s.onUnpinTask).toHaveBeenCalledTimes(1);
    expect(s.onSetTier).not.toHaveBeenCalled();
    expect(tierBtn(host, "Don't pin")).toBeUndefined();
    expect(host.querySelector('.task-kebab-walnut-pick')).toBeNull();
    expect(priorityBtns(host).map((b) => b.textContent)).toEqual(['!!', '!', '~', '--']);
    // The lit priority is a no-op on the board.
    await click(priorityBtns(host)[0]);
    expect(s.onSetPriority).not.toHaveBeenCalled();
  });

  it('the Due row keeps the board format when no formatDate is given', async () => {
    const host = await mount({ task: TASK, isPinned: true, pinnedTier: 'focus', isDone: false, ...spies() });
    const labels = [...host.querySelectorAll('.task-kebab-date-label')].map((e) => e.textContent);
    expect(labels).toEqual(['Start', `Due: ${formatDateDisplay('2026-09-26')}`]);
  });
});

describe('TaskActionMenuItems with the draft props', () => {
  const draftProps = { showPriorityLabels: true, litClickAccepts: true };

  it('clicking the lit tier accepts it (same value), never unpins (C56)', async () => {
    const s = spies();
    const host = await mount({ task: TASK, isPinned: true, pinnedTier: 'satellite', isDone: false, ...s, ...draftProps });
    const lit = tierBtn(host, 'Satellite')!;
    expect(lit.getAttribute('title')).toBe('Keep Satellite');
    await click(lit);
    expect(s.onSetTier).toHaveBeenCalledWith('satellite');
    expect(s.onUnpinTask).not.toHaveBeenCalled();
    expect(s.afterAction).toHaveBeenCalledTimes(1);
  });

  it('"Don\'t pin" trails the tier row, unpins, and is lit for an explicit null tier', async () => {
    const s = spies();
    const host = await mount({ task: TASK, isPinned: false, pinnedTier: null, isDone: false, ...s, ...draftProps });
    const labels = [...host.querySelectorAll('.task-kebab-tier-btn')].map((b) => b.textContent?.trim());
    expect(labels[labels.length - 1]).toBe("Don't pin");
    const unpin = tierBtn(host, "Don't pin")!;
    expect(unpin.classList.contains('active')).toBe(true);
    await click(unpin);
    expect(s.onUnpinTask).toHaveBeenCalledTimes(1);
    // An undecided tier (undefined) lights nothing, not even "Don't pin".
    await act(async () => { root!.unmount(); });
    root = null;
    const host2 = await mount({ task: TASK, isPinned: false, isDone: false, ...spies(), ...draftProps });
    expect(host2.querySelectorAll('.task-kebab-tier-btn.active').length).toBe(0);
  });

  it('priority buttons read icon + label, and the lit one accepts', async () => {
    const s = spies();
    const host = await mount({ task: TASK, isPinned: true, pinnedTier: 'focus', isDone: false, ...s, ...draftProps });
    expect(priorityBtns(host).map((b) => b.textContent)).toEqual(['!! Immediate', '! Important', '~ Backlog', '-- None']);
    await click(priorityBtns(host)[0]);
    expect(s.onSetPriority).toHaveBeenCalledWith('immediate');
  });

  it('dates use the caller format, called with the field kind', async () => {
    const formatDate = vi.fn((iso: string, kind: string) => `${kind}:${iso}`);
    const host = await mount({
      task: { priority: 'none', start_date: '2026-09-25', due_date: '2026-09-26' },
      isPinned: true, pinnedTier: 'focus', isDone: false, ...spies(), ...draftProps, formatDate,
    });
    const labels = [...host.querySelectorAll('.task-kebab-date-label')].map((e) => e.textContent);
    expect(labels).toEqual(['Start: start:2026-09-25', 'Due: due:2026-09-26']);
    expect(formatDate).toHaveBeenCalledWith('2026-09-26', 'due');
  });

  it('a tier heading replaces "Pin to" and nothing is lit (C65)', async () => {
    const host = await mount({
      task: TASK, isPinned: false, isDone: false, ...spies(), ...draftProps, tierHeading: 'Pin to (default Focus)',
    });
    expect(host.querySelector('.task-kebab-tier-label')!.textContent).toBe('Pin to (default Focus)');
    expect(host.querySelectorAll('.task-kebab-tier-btn.active').length).toBe(0);
  });

  it('"Use Walnut\'s pick" rows sit in their block and hand the field back (C61)', async () => {
    const s = spies();
    const onTier = vi.fn();
    const onDue = vi.fn();
    const host = await mount({
      task: TASK, isPinned: true, pinnedTier: 'focus', isDone: false, ...s, ...draftProps,
      walnutPick: { pinTier: { label: 'Satellite', onPick: onTier }, dueDate: { label: 'Fri', onPick: onDue } },
    });
    const rows = [...host.querySelectorAll('.task-kebab-walnut-pick')];
    expect(rows.map((r) => r.textContent)).toEqual(["✦Use Walnut's pick: Satellite", "✦Use Walnut's pick: Fri"]);
    await click(rows[0]);
    expect(onTier).toHaveBeenCalledTimes(1);
    expect(s.afterAction).toHaveBeenCalledTimes(1);
    expect(onDue).not.toHaveBeenCalled();
  });
});

describe('the More title (spec 5.3)', () => {
  it('names the shortcut and drops "priority" while it is hidden', () => {
    expect(draftMoreTitle(true, '⌘.')).toBe('Pin tier, dates, priority, start unread (⌘.)');
    expect(draftMoreTitle(false, 'Ctrl+.')).toBe('Pin tier, dates, start unread (Ctrl+.)');
    expect(draftMoreTitle('unknown', '⌘.')).toBe('Pin tier, dates, start unread (⌘.)');
  });
});

// ── The shared menu controller: chips + More + the one popover ──────────────
// A harness wires them exactly as DraftLaunchBar does. linkedom has no layout,
// so every element gets a fixed on-screen box and the window a viewport.
const { useRef } = await import('../../web/node_modules/react/index.js');
const { DraftDecisionChips, DraftMoreButton, useDraftDecisionMenu } = await import('../../web/src/components/sessions/DraftDecisionRow');
const { DraftTaskMenuPopover } = await import('../../web/src/components/sessions/DraftTaskMenu');
const { draftDecisionChips } = await import('../../web/src/components/sessions/draft-decisions');
const { DEFAULT_META } = await import('../../web/src/components/sessions/task-meta-constants');
type Chip = import('../../web/src/components/sessions/draft-decisions').DraftDecisionChip;

function layoutStubs(): void {
  const proto = (win as unknown as { HTMLElement: { prototype: object } }).HTMLElement.prototype;
  Object.defineProperty(proto, 'getBoundingClientRect', {
    configurable: true, value: () => ({ top: 500, bottom: 520, left: 20, right: 80, width: 60, height: 20 }),
  });
  for (const k of ['offsetWidth', 'offsetHeight']) Object.defineProperty(proto, k, { configurable: true, get: () => 20 });
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => 200 });
  const w = win as unknown as Record<string, unknown>;
  w.innerWidth = 1280;
  w.innerHeight = 800;
  (globalThis as unknown as Record<string, unknown>).getComputedStyle = () => ({ borderTopWidth: '0', borderBottomWidth: '0' });
}

function chipsFor(meta: Record<string, unknown>, ai: string[]): Chip[] {
  return draftDecisionChips(
    { id: 'draft:h', cwd: '', host: null, meta: { ...DEFAULT_META, ...meta }, aiFields: new Set(ai) } as never,
    { tierLabel: () => undefined, customTiersLoaded: true, priorityVisible: true, now: new Date() },
  );
}

interface HarnessProps { chips: Chip[]; text: string; composer: HTMLElement; onChange: (p: unknown) => void; nonce?: number; more?: boolean }
function Harness(p: HarnessProps) {
  const moreRef = useRef<HTMLButtonElement>(null);
  const menu = useDraftDecisionMenu({ getComposer: () => p.composer as never, composerText: p.text, openMenuNonce: p.nonce, moreRef });
  return createElement('div', { className: 'harness' },
    createElement(DraftDecisionChips, { chips: p.chips, menu }),
    p.more === false ? null : createElement(DraftMoreButton, { menu, moreRef, priorityVisible: true }),
    createElement(DraftTaskMenuPopover, {
      open: menu.open, anchorEl: menu.anchor, menuRef: menu.menuRef, meta: DEFAULT_META, tierDecided: true,
      priorityVisible: true, onChange: p.onChange, onClose: menu.close, onAnchorLost: menu.onAnchorLost,
      focusNonce: menu.mode === 'keyboard' ? menu.focusNonce : 0,
    }));
}

function fire(el: Element | Document, type: string, init: Record<string, unknown> = {}): Event {
  const ev = new win.Event(type, { bubbles: true, cancelable: true });
  for (const [k, v] of Object.entries(init)) Object.defineProperty(ev, k, { value: v });
  el.dispatchEvent(ev);
  return ev;
}

describe('draft decision menu controller', () => {
  let composer: HTMLElement & { focus: ReturnType<typeof vi.fn>; setSelectionRange: ReturnType<typeof vi.fn> };
  let props: HarnessProps;
  const menuEl = () => doc.body.querySelector('[data-testid="draft-task-menu"]');
  const more = () => doc.body.querySelector('.draft-more-btn') as HTMLElement;
  const chipEl = (f: string) => doc.body.querySelector(`.draft-decision-chip[data-field="${f}"]`) as HTMLElement;
  async function render(over: Partial<HarnessProps> = {}): Promise<void> {
    props = { ...props, ...over };
    if (!root) {
      const host = doc.createElement('div');
      doc.body.appendChild(host);
      root = createRoot(host);
    }
    await act(async () => { root!.render(createElement(Harness, props)); });
  }
  async function press(el: Element, detail: number): Promise<void> {
    await act(async () => { fire(el, 'click', { detail }); });
  }

  beforeAll(() => { layoutStubs(); });
  beforeEach(() => {
    composer = Object.assign(doc.createElement('div'), { focus: vi.fn(), setSelectionRange: vi.fn(), selectionStart: 3, selectionEnd: 5 }) as never;
    props = {
      chips: chipsFor({ pinTier: 'satellite', dueDate: '2026-09-26' }, ['pinTier', 'dueDate']),
      text: 'fix the login test', composer, onChange: vi.fn(),
    };
  });

  it('More and chips are dialog triggers that keep the composer caret on mousedown (C2, C55, C62)', async () => {
    await render();
    const m = more();
    expect(m.textContent).toBe('More');
    expect(m.getAttribute('aria-label')).toBe('Task settings');
    expect(m.getAttribute('aria-haspopup')).toBe('dialog');
    expect(m.getAttribute('aria-expanded')).toBe('false');
    expect(chipEl('pinTier').getAttribute('aria-haspopup')).toBe('dialog');
    expect(chipEl('pinTier').querySelector('.draft-ai-badge')).toBeTruthy();
    expect(fire(m, 'mousedown').defaultPrevented).toBe(true);
    expect(fire(chipEl('dueDate'), 'mousedown').defaultPrevented).toBe(true);
  });

  it('More opens ONE portalled dialog; another chip re-anchors it without remounting (C5, C41)', async () => {
    await render();
    await press(more(), 1);
    const menu = menuEl()!;
    expect(menu.getAttribute('role')).toBe('dialog');
    expect(menu.getAttribute('aria-label')).toBe('Task settings');
    expect(menu.parentElement).toBe(doc.body);
    expect(more().classList.contains('draft-more-btn-active')).toBe(true);
    expect(more().getAttribute('aria-expanded')).toBe('true');
    await press(chipEl('pinTier'), 1);
    expect(menuEl()).toBe(menu);
    expect(chipEl('pinTier').classList.contains('draft-decision-chip-active')).toBe(true);
    expect(more().classList.contains('draft-more-btn-active')).toBe(false);
    // The current anchor toggles it shut.
    await press(chipEl('pinTier'), 1);
    expect(menuEl()).toBeNull();
  });

  it('a mouse open never takes focus; closing puts the caret back in the composer (C26, C55)', async () => {
    await render();
    await press(chipEl('pinTier'), 1);
    expect(composer.focus).not.toHaveBeenCalled();
    await act(async () => { fire(doc, 'keydown', { key: 'Escape' }); });
    expect(menuEl()).toBeNull();
    expect(composer.focus).toHaveBeenCalledTimes(1);
    expect(composer.setSelectionRange).toHaveBeenCalledWith(3, 5);
  });

  it('a keyboard open focuses the lit tier row and Escape returns focus to the anchor (C26, C40)', async () => {
    await render();
    const anchor = chipEl('dueDate');
    const proto = (win as unknown as { HTMLElement: { prototype: { focus: () => void } } }).HTMLElement.prototype;
    const focus = vi.spyOn(proto, 'focus');
    await press(anchor, 0);
    const focused = () => focus.mock.contexts as unknown as HTMLElement[];
    const tier = focused().find((el) => el.classList?.contains('task-kebab-tier-btn'));
    expect(tier).toBeTruthy();
    expect(focused()).not.toContain(composer);
    await act(async () => { fire(doc, 'keydown', { key: 'Escape' }); });
    expect(menuEl()).toBeNull();
    expect(focused()[focused().length - 1]).toBe(anchor);
    expect(composer.focus).not.toHaveBeenCalled();
    focus.mockRestore();
  });

  it('the Mod+. nonce opens from More in keyboard mode', async () => {
    await render({ nonce: 0 });
    await render({ nonce: 1 });
    expect(menuEl()).toBeTruthy();
    expect(more().classList.contains('draft-more-btn-active')).toBe(true);
  });

  it('"Start unread" toggles and keeps the menu open (C42)', async () => {
    await render();
    await press(more(), 1);
    const row = menuEl()!.querySelector('.draft-task-menu-unread')!;
    expect(row.textContent).toContain('Start unread');
    await press(row, 1);
    expect(props.onChange).toHaveBeenCalledWith({ unread: true });
    expect(menuEl()).toBeTruthy();
  });

  it('opening a date row keeps the menu top where it was and caps it to the viewport (C25b)', async () => {
    await render();
    await press(more(), 1);
    const menu = menuEl() as HTMLElement;
    // Placed upward over the stubbed anchor: bottom edge on the anchor.
    const placedTop = menu.style.top;
    expect(placedTop).toBe('298px');
    // Left edge on the anchor's left edge (stub: left 20, width 20 in a 1280 viewport).
    expect(menu.style.right).toBe('1240px');
    const due = [...menu.querySelectorAll('.task-kebab-date-toggle')].find((b) => /Due/.test(b.textContent ?? ''))!;
    await press(due, 1);
    expect(menu.querySelector('.task-kebab-date.open')).toBeTruthy();
    // The stubbed rect reads top 500: the frozen top is the MEASURED one, and the
    // cap is the room left under it (800 - 500 - 8 margin).
    expect(menu.style.top).toBe('500px');
    expect(menu.style.maxHeight).toBe('292px');
    // A new anchor starts over from the placement.
    await press(chipEl('pinTier'), 1);
    expect(menuEl()).toBe(menu);
    expect(menu.style.top).toBe(placedTop);
  });

  it('typing in the composer closes the menu (C46)', async () => {
    await render();
    await press(more(), 1);
    await render({ text: 'fix the login test x' });
    expect(menuEl()).toBeNull();
  });

  it('outside mousedown closes; the menu, a trigger and the project flyout are exempt', async () => {
    await render();
    await press(more(), 1);
    await act(async () => { fire(menuEl()!, 'mousedown'); });
    await act(async () => { fire(chipEl('pinTier'), 'mousedown'); });
    const flyout = doc.createElement('div');
    flyout.className = 'task-kebab-project-flyout';
    doc.body.appendChild(flyout);
    await act(async () => { fire(flyout, 'mousedown'); });
    expect(menuEl()).toBeTruthy();
    await act(async () => { fire(doc.body, 'mousedown'); });
    expect(menuEl()).toBeNull();
  });

  it('a chip removed under the menu hands it to More; More gone too closes it', async () => {
    await render();
    await press(chipEl('dueDate'), 1);
    await render({ chips: chipsFor({ pinTier: 'satellite' }, ['pinTier']) });
    expect(menuEl()).toBeTruthy();
    expect(more().classList.contains('draft-more-btn-active')).toBe(true);
    await render({ more: false });
    expect(menuEl()).toBeNull();
  });

  it('a value change keeps the chip node; chips landing together get staggered indexes (C66)', async () => {
    await render({ chips: chipsFor({ pinTier: 'satellite' }, ['pinTier']) });
    const tier = chipEl('pinTier');
    expect(tier.getAttribute('style')).toMatch(/--i:\s?0/);
    await render({ chips: chipsFor({ pinTier: 'backlog', priority: 'immediate', dueDate: '2026-09-26' }, ['pinTier', 'priority', 'dueDate']) });
    expect(chipEl('pinTier')).toBe(tier);
    expect(tier.textContent).toContain('Backlog');
    expect(tier.getAttribute('style')).toMatch(/--i:\s?0/);
    expect(chipEl('priority').getAttribute('style')).toMatch(/--i:\s?0/);
    expect(chipEl('dueDate').getAttribute('style')).toMatch(/--i:\s?1/);
    expect(chipEl('priority').textContent).toBe('!! Immediate✦');
    await render({ chips: [] });
    expect(doc.body.querySelector('.draft-decision-row')).toBeNull();
  });
});
