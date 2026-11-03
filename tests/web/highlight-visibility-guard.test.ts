/**
 * WebKit paints a Highlight whose words sit under `visibility: hidden` onto the
 * next words it renders (2026-11-03: a Home chat's question marks showed as a
 * green fill and underline on page and plugin titles; utils/highlight-visibility.ts).
 * This file pins the registry filter, and lists every `visibility: hidden` in the
 * app and the plugins this repository ships, each with whether it can hide words a
 * painter marked: one that can must re-check the registry when it turns
 * (useHidesHighlights), so a new hiding surface fails here until it is placed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { keepHighlightRepaints } from '../../web/src/utils/highlight-repaint';
import { refreshHighlightVisibility, visibleHighlight } from '../../web/src/utils/highlight-visibility';

// ── Fakes: an element whose visibility a test turns, a range in it, a setlike Highlight ──
class El {
  nodeType = 1;
  isConnected = true;
  hidden = false;
  parentElement: El | null = null;
  checkVisibility(opts?: { visibilityProperty?: boolean }) { return !(opts?.visibilityProperty && this.hidden); }
}
const rangeIn = (el: El, label: string) => ({ startContainer: el, endContainer: el, label });
type R = ReturnType<typeof rangeIn>;
class FakeHighlight {
  private s: R[];
  priority = 0;
  constructor(...ranges: R[]) { this.s = [...ranges]; }
  get size() { return this.s.length; }
  forEach(cb: (r: R) => void) { this.s.forEach(cb); }
  add(r: R) { this.s.push(r); }
  clear() { this.s = []; }
  labels() { return this.s.map((r) => r.label); }
}
class VisRegistry {
  m = new Map<string, unknown>();
  get(name: string) { return this.m.get(name); }
  set(name: string, value: unknown) { this.m.set(name, value); return this; }
  delete(name: string) { return this.m.delete(name); }
  clear() { this.m.clear(); }
  keys() { return this.m.keys(); }
}
const reg = new VisRegistry();
keepHighlightRepaints(reg);
const held = (name: string) => reg.m.get(name) as FakeHighlight | undefined;

describe('the registry paints no words hidden by visibility', () => {
  afterEach(() => reg.clear());

  it('registers a copy without the hidden ranges, and get answers what the painter set', () => {
    const shown = new El();
    const home = new El();
    home.hidden = true;
    const h = new FakeHighlight(rangeIn(shown, 'page'), rangeIn(home, 'home'));
    h.priority = 4;
    reg.set('thread-mark-neutral', h);
    expect(held('thread-mark-neutral')!.labels()).toEqual(['page']);
    expect(held('thread-mark-neutral')!.priority).toBe(4);
    // Painters compare by identity (page-find, dom-text-search): the painter's own.
    expect(reg.get('thread-mark-neutral')).toBe(h);
    expect(h.labels()).toEqual(['page', 'home']);
    reg.delete('thread-mark-neutral');
    expect(reg.m.has('thread-mark-neutral')).toBe(false);
  });

  it('a surface hidden after the paint is withdrawn on refresh, and painted again when shown', () => {
    const home = new El();
    const h = new FakeHighlight(rangeIn(home, 'asked heading'));
    reg.set('thread-mark-neutral', h);
    expect(held('thread-mark-neutral')).toBe(h);

    home.hidden = true; // Home leaves its route
    refreshHighlightVisibility();
    expect(held('thread-mark-neutral')!.size).toBe(0);
    // The painter's Highlight keeps its ranges for the way back.
    expect(h.labels()).toEqual(['asked heading']);

    home.hidden = false;
    refreshHighlightVisibility();
    expect(held('thread-mark-neutral')!.labels()).toEqual(['asked heading']);
  });

  it('nothing hidden: the painter\'s own Highlight is registered as it is', () => {
    const h = new FakeHighlight(rangeIn(new El(), 'a'));
    expect(visibleHighlight(h)).toBe(h);
    reg.set('walnut-find', h);
    expect(held('walnut-find')).toBe(h);
    refreshHighlightVisibility();
    expect(held('walnut-find')).toBe(h);
  });
});

// ── Every `visibility: hidden` in the app and the shipped plugins ──
const ROOT = path.resolve(__dirname, '../..');
const DIRS = ['web/src', 'examples/plugins', 'plugin-store'];
const sources = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', 'tests'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(css|tsx?|mjs)$/.test(e.name) && !/\.(test|d)\.tsx?$/.test(e.name)) out.push(p);
    }
  };
  for (const d of DIRS) walk(path.join(ROOT, d));
  return out;
};

/** `file :: selector` for a stylesheet rule, `file :: inline (n)` for a component's. */
function hidingSites(): string[] {
  const keys: string[] = [];
  for (const file of sources()) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const css = file.endsWith('.css');
    let src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
    if (!css) src = src.replace(/^\s*(\/\/|\*).*$/gm, '');
    let inline = 0;
    for (const m of src.matchAll(/visibility\s*:\s*['"]?hidden/g)) {
      if (!css) { inline++; continue; }
      const before = src.slice(0, m.index);
      const open = before.lastIndexOf('{');
      const from = Math.max(before.lastIndexOf('}', open), before.lastIndexOf(';', open)) + 1;
      keys.push(`${rel} :: ${before.slice(from, open).trim().replace(/\s+/g, ' ')}`);
    }
    if (inline) keys.push(`${rel} :: inline (${inline})`);
  }
  return keys.sort();
}

/** A surface that hides words a painter marks, and the file that re-checks the registry when it turns. */
const REFRESHES: Record<string, string> = {
  'web/src/styles/globals.css :: .main-page-wrapper-hidden': 'web/src/App.tsx',
  'web/src/styles/task-board.css :: .session-panel-chat-col.is-board-peek > :not(.board-task-peek):not(.peek-tab-bar)': 'web/src/components/sessions/SessionPanel.tsx',
  'web/src/styles/fullscreen-tab.css :: html .open-walnut-fullscreen-away, html .open-walnut-fullscreen-away *': 'web/src/hooks/useFullscreen.tsx',
};

const CONTROL = 'a control, pill or count, never words a painter marks';
const PLACING = 'a popover or card hidden only until it is placed: no painter reaches it';
const SLOT = 'an empty slot or measuring box: it holds no painted words';
const HEADER = 'a header or bar: no painter marks its words';
/** Hides nothing a painter marks (thread marks, pins, comments, find), with why. */
const NO_PAINTED_WORDS: Record<string, string> = {
  'web/src/utils/scrollbar-metrics.ts :: inline (1)': SLOT,
  'web/src/styles/plugin-updates.css :: .plugin-update-label::after': SLOT,
  'web/src/styles/plugin-updates.css :: .plugin-update-slot': SLOT,
  'web/src/styles/board-kanban-controls.css :: .kanban-lane-strip-measure': SLOT,
  'web/src/styles/tasks-page.css :: .tp-group-kebab-wrap': CONTROL,
  'web/src/styles/human-inbox-items.css :: .hii-inert-slot': SLOT,
  "web/src/styles/composer-controls.css :: .composer-control[data-add-menu='true'] > .mode-toggle-pill, .composer-control[data-add-menu='true'] > .session-notes-pill, .composer-control[data-add-menu='true'] > .side-question-root > .side-question-pill": CONTROL,
  'web/src/styles/board-kanban.css :: .board-kanban .kanban-card-actions': CONTROL,
  'web/src/styles/board-kanban.css :: .board-kanban .kanban-card:hover .kanban-card-foot-right, .board-kanban .kanban-card:focus-within .kanban-card-foot-right': CONTROL,
  'web/src/styles/board-kanban.css :: .board-kanban .kanban-lanes.is-dragging .kanban-card .kanban-card-actions': CONTROL,
  'web/src/styles/doc-comments.css :: .doc-comment-slot': PLACING,
  'web/src/styles/filter-bar.css :: .fb-only': CONTROL,
  'web/src/styles/filter-bar.css :: .fb-opt:hover .fb-opt-body .tp-count, .fb-opt:focus-within .fb-opt-body .tp-count, .fb-opt:has(.fb-only):hover .fb-opt-default, .fb-opt:has(.fb-only):focus-within .fb-opt-default': CONTROL,
  'web/src/styles/filter-bar.css :: .fb-opt-body .tp-count, .fb-opt:has(.fb-only) .fb-opt-default': CONTROL,
  'web/src/styles/phone-fixes-r4.css :: .app-shell-navigation .session-history .phone-prompt-pill.is-seen': CONTROL,
  'web/src/styles/phone-session.css :: .app-shell-navigation .session-panel.is-phone-layer > .session-panel-header': HEADER,
  'web/src/styles/session-header-fit.css :: .session-meta-row-2 [data-header-spacer="true"]': SLOT,
  'web/src/styles/phone-layout.css :: .app-shell-navigation .phone-topbar-sync': CONTROL,
  'web/src/styles/settings-shell.css :: .settings-pane-stickybar-inner': HEADER,
  'web/src/styles/thread-review.css :: .thread-review-card[data-enlarged="true"]': 'a review card under its open full card: its words are a summary, never a marked passage',
  'web/src/styles/attention-banner.css :: .hpb-below-slot': SLOT,
  'web/src/styles/host-status.css :: .hpb-btn-stack::before': SLOT,
  'web/src/styles/host-status.css :: .hpb-btn-stack::after': SLOT,
  'web/src/styles/phone-settings.css :: .app-shell-navigation .settings-layout[data-phone-settings="list"] > .settings-pane': 'a settings pane on the phone: no painter marks settings',
  'web/src/styles/phone-settings.css :: .app-shell-navigation .settings-layout[data-phone-settings="pane"] > .settings-nav': 'the settings list on the phone: no painter marks it',
  'web/src/styles/globals.css :: .tier-project-label-inert .tier-project-label-actions': CONTROL,
  'web/src/styles/globals.css :: .tier-separator-inert .tier-separator-delete': CONTROL,
  'web/src/styles/globals.css :: .tier-separator-inert .tier-separator-edit': CONTROL,
  'web/src/styles/globals.css :: @media (max-width: 768px), (pointer: coarse) and (max-height: 500px) { .sidebar': 'the sidebar on a narrow screen: no painter marks it',
  'web/src/styles/globals.css :: .session-panel.has-host-header > .session-panel-header': HEADER,
  'web/src/styles/thread-map.css :: .thread-map-item:is(:hover, :focus-within) .thread-map-status': CONTROL,
  'web/src/styles/settings-controls.css :: .settings-button-stack::before': SLOT,
  'web/src/styles/settings-controls.css :: .settings-button-stack::after': SLOT,
  'web/src/components/tasks/LinkHoverCard.tsx :: inline (1)': PLACING,
  'web/src/components/passwords/ItemEditor.tsx :: inline (1)': PLACING,
  'web/src/components/passwords/VaultBrowser.tsx :: inline (2)': PLACING,
  'web/src/components/content/CeoComposer.tsx :: inline (1)': PLACING,
  'web/src/components/common/SelectionAskPill.tsx :: inline (1)': PLACING,
  'web/src/components/sessions/ThreadStackFrame.tsx :: inline (1)': PLACING,
  'web/src/components/sessions/ThreadConfirm.tsx :: inline (1)': PLACING,
  'web/src/components/sessions/SessionCodeView.tsx :: inline (1)': 'the code editor frame while it starts: a frame of its own, nothing painted yet',
  'web/src/pages/PluginAppPage.tsx :: inline (1)': 'a plugin page while it loads: nothing painted yet',
  'examples/plugins/walnut-time/src/web/styles-task.ts :: inline (1)': CONTROL,
};

describe('every visibility: hidden is placed', () => {
  const sites = hidingSites();
  it('lists each one: a surface that re-checks the registry, or one with no painted words', () => {
    const listed = [...Object.keys(REFRESHES), ...Object.keys(NO_PAINTED_WORDS)].sort();
    expect(sites, 'a new visibility: hidden: if it can hide marked words, call useHidesHighlights where it turns and list it in REFRESHES; else say why in NO_PAINTED_WORDS').toEqual(listed);
  });
  it('a surface in REFRESHES re-checks the registry when it turns', () => {
    for (const [site, file] of Object.entries(REFRESHES)) {
      expect(fs.readFileSync(path.join(ROOT, file), 'utf8'), `${site} turns in ${file}`).toMatch(/useHidesHighlights\(/);
    }
  });
});
