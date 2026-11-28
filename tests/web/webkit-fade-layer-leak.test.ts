/**
 * Every opacity fade in the web app's CSS is known, and none sits where it leaks WebKit layers.
 *
 * 2026-11-26, measured in the Mac app's WebKit on a test Mac: a block whose opacity animation or
 * opacity transition ran to its end, inside a scroller that is not a stacking context, holding a
 * nested scroller whose content overflows, leaks about 6 layers and their graphics surfaces each
 * time the block is removed. They stay until the app quits, a blank page included (the app's
 * process memory, not the page's). The Settings pane's 120 ms fade did it on every pane change and
 * every leave: 90 visits left 543 layers, none without the fade. The same shape with no fade, with
 * the fade on the scroller itself, with the scroller made a stacking context, or with the inner
 * scroller not overflowing, did not leak.
 *
 * So a fade on a block that holds content which can scroll sideways (a SegmentedControl `.wn-seg`,
 * tabs `.wn-tabs`, a code block, a wide table) must not sit in a page scroller. This test lists
 * every finite opacity animation and every transition of opacity (or `all`) and fails on one it has
 * not seen, so each new fade is checked against that shape when it is added:
 *  - 'leaf': a control, chip, line or row that holds no scroller;
 *  - 'overlay': a fixed, portalled or positioned layer with its own stacking context, or a panel
 *    measured not to leak (graphics-leak harness), outside the page's scrollers.
 * A fade that fits neither is dropped (as the Settings pane's and its disclosure rows' were).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const WEB_SRC = path.join(__dirname, '../../web/src');

type Reason = 'leaf' | 'overlay';

/** `<file under web/src> <selector list> <animation|transition>` -> why it cannot leak. */
const KNOWN_FADES = new Map<string, Reason>([
  ["apps/mail/mail-groups.css .mail-row-leaving animation", 'leaf'],
  ["apps/mail/mail-reader.css .mail-attachment-viewer animation", 'overlay'],
  ["apps/mail/mail.css .mail-pane-splitter::after transition", 'leaf'],
  ["components/approvals/approvals.css .approval-card-arming .approval-actions transition", 'leaf'],
  ["components/chat/camera/camera-dock.css .camera-flash animation", 'overlay'],
  ["popout/ext-panel.css .ext-task-focus.is-row transition", 'leaf'],
  ["styles/attention-banner.css .hpb-row transition", 'leaf'],
  ["styles/dialog-resize.css .dialog-resize-edge::after transition", 'leaf'],
  ["styles/draft-v6.css .draft-v6-line transition", 'leaf'],
  ["styles/engine-settings-popover-rows.css .engine-setting-saving animation", 'leaf'],
  ["styles/filter-bar-row.css .fb-row transition", 'leaf'],
  ["styles/filter-bar-row.css .fb-chip animation", 'leaf'],
  ["styles/globals.css .sidebar-label transition", 'leaf'],
  ["styles/globals.css .notification-panel-backdrop::after animation", 'overlay'],
  ["styles/globals.css .notification-panel animation", 'overlay'],
  ["styles/globals.css .subtask-delete transition", 'leaf'],
  ["styles/globals.css .perm-option-confirm-name > :is(.notification-toast, .notification-feed-item)[data-settling] :is(button, [role='button']) transition", 'leaf'],
  ["styles/globals.css .session-msg .session-msg-actions, .session-msg-bare .session-msg-actions transition", 'leaf'],
  ["styles/globals.css .bash-tool-expand-btn transition", 'leaf'],
  ["styles/globals.css .chat-input-task-pill animation", 'leaf'],
  ["styles/globals.css .mic-silence-warning, .mic-start-hint animation", 'leaf'],
  ["styles/globals.css .voice-panel-hover-actions transition", 'leaf'],
  ["styles/globals.css .mic-chevron-badge animation", 'leaf'],
  ["styles/globals.css .mic-retry-dropdown animation", 'overlay'],
  ["styles/globals.css .stt-model-tab transition", 'leaf'],
  ["styles/globals.css .chat-image-remove transition", 'leaf'],
  ["styles/globals.css .lightbox-overlay animation", 'overlay'],
  ["styles/globals.css .todo-resize-handle::after, .session-resize-handle::after, .memory-resize-handle::after, .notes-resize-handle::after, .session-col-resize-handle::after, .cal-side-resize-handle::after transition", 'leaf'],
  ["styles/globals.css .open-walnut-fullscreen animation", 'overlay'],
  ["styles/globals.css .plan-card-expand-btn transition", 'leaf'],
  ["styles/globals.css .task-quick-star transition", 'leaf'],
  ["styles/globals.css .task-quick-attention transition", 'leaf'],
  ["styles/globals.css .vd-cat transition", 'leaf'],
  ["styles/globals.css .todo-section-tab-label transition", 'leaf'],
  ["styles/globals.css .todo-tier-resize-handle::after transition", 'leaf'],
  ["styles/globals.css .todo-pinned-unpin transition", 'leaf'],
  ["styles/globals.css .todo-pinned-drag-handle transition", 'leaf'],
  ["styles/globals.css .todo-tier-btn transition", 'leaf'],
  ["styles/globals.css .todo-panel-item-vanishing, .todo-card-vanishing animation", 'leaf'],
  ["styles/globals.css .task-group-chip-grip transition", 'leaf'],
  ["styles/globals.css .task-unread-dot transition", 'leaf'],
  ["styles/globals.css .todo-detail-splitter::after, .todo-pinned-splitter::after transition", 'leaf'],
  ["styles/globals.css .todo-detail-close transition", 'leaf'],
  ["styles/globals.css .todo-panel-tab transition", 'leaf'],
  ["styles/globals.css .todo-panel-toggle-completed transition", 'leaf'],
  ["styles/globals.css .todo-group-fav-btn transition", 'leaf'],
  ["styles/globals.css .todo-group-action-btn transition", 'leaf'],
  ["styles/globals.css .tier-separator-inert transition", 'leaf'],
  ["styles/globals.css .task-filter-override-fading animation", 'leaf'],
  ["styles/globals.css .task-delete-btn transition", 'leaf'],
  ["styles/globals.css .task-ungroup-btn transition", 'leaf'],
  ["styles/globals.css .task-kebab-btn transition", 'leaf'],
  ["styles/globals.css .context-inspector animation", 'overlay'],
  ["styles/globals.css .cron-filter-tab transition", 'leaf'],
  ["styles/globals.css .provider-rail-label, .provider-rail-why transition", 'leaf'],
  ["styles/globals.css .model-picker-refresh.model-picker-refresh-success, .model-picker-refresh.model-picker-refresh-success:hover animation", 'leaf'],
  ["styles/globals.css .usage-chart-bar transition", 'leaf'],
  ["styles/globals.css .dock-task-expand transition", 'leaf'],
  ["styles/globals.css .dock-task-unpin transition", 'leaf'],
  ["styles/globals.css .bedrock-cred-group transition", 'leaf'],
  ["styles/globals.css .qp-option transition", 'leaf'],
  ["styles/globals.css .draft-decision-chip animation", 'leaf'],
  ["styles/globals.css .notes-save-status transition", 'leaf'],
  ["styles/globals.css .edit-diff-view-file transition", 'leaf'],
  ["styles/globals.css .side-thread-chip-archive transition", 'leaf'],
  ["styles/globals.css .permission-copy-hint transition", 'leaf'],
  ["styles/globals.css .session-panel-chat-resize::after transition", 'leaf'],
  ["styles/globals.css .session-diff-body.is-switching .session-diff-tree transition", 'leaf'],
  ["styles/globals.css .compare-graph-rail transition", 'leaf'],
  ["styles/globals.css .session-diff-tree-resize transition", 'leaf'],
  ["styles/globals.css .session-diff-rendered-lineno transition", 'leaf'],
  ["styles/globals.css .cal-allday-resize-handle::after transition", 'leaf'],
  ["styles/globals.css .task-start-btn transition", 'leaf'],
  ["styles/globals.css .session-toc-rail transition", 'leaf'],
  ["styles/globals.css .session-toc-panel animation", 'overlay'],
  ["styles/globals.css .session-toc-unpin transition", 'leaf'],
  ["styles/globals.css .stale-build-pill animation", 'overlay'],
  ["styles/home-navigation.css .side-bar-pane-resize::after transition", 'leaf'],
  ["styles/human-inbox.css .hib-card-expand transition", 'leaf'],
  ["styles/keyboard-shortcuts.css .session-jump-badge animation", 'leaf'],
  ["styles/keyboard-shortcuts.css .shortcut-hint animation", 'leaf'],
  ["styles/notice-card.css .wn-notice animation", 'leaf'],
  ["styles/org-threads.css .org-thread-split transition", 'leaf'],
  ["styles/org-threads.css .org-thread-move-note animation", 'leaf'],
  ["styles/overlay-family.css html .wn-overlay transition", 'overlay'],
  ["styles/overlay-family.css html .wn-dialog transition", 'overlay'],
  ["styles/overlay-family.css html .wn-scrim transition", 'overlay'],
  ["styles/overlay-family.css html .wn-tip transition", 'overlay'],
  ["styles/passwords.css .pw-f-actions transition", 'leaf'],
  ["styles/phone-layout.css html body .notification-toaster .notification-toast animation", 'overlay'],
  ["styles/phone-session.css .app-shell-navigation .session-delivery-meta transition", 'leaf'],
  ["styles/quickbar.css .qb-scrim animation", 'overlay'],
  ["styles/quickbar.css .qb-center animation", 'overlay'],
  ["styles/scroll-jump.css .scroll-to-bottom-btn transition", 'leaf'],
  ["styles/session-browser-card.css .session-browser-replay-frame transition", 'leaf'],
  ["styles/session-browser-card.css .session-browser-replay-tick::before transition", 'leaf'],
  ["styles/session-header-fit.css .btn.session-header-tool transition", 'leaf'],
  ["styles/session-servers.css .session-web-body-stopping .session-web-iframe transition", 'leaf'],
  ["styles/settings-shell.css .settings-pane-stickybar-inner > * transition", 'leaf'],
  ["styles/settings-shell.css .settings-saved-indicator animation", 'leaf'],
  ["styles/settings-shell.css .settings-saved-indicator transition", 'leaf'],
  ["styles/sheet-width.css .sheet-width-edge::after transition", 'leaf'],
  ["styles/sidebar-peek.css .rail-item-pill[data-grow] .sidebar-label animation", 'leaf'],
  ["styles/step-rows.css :root .session-history .chat-tool-block .chat-tool-block-arrow transition", 'leaf'],
  ["styles/step-rows.css :root .session-history .provenance-card .op-card-more-chevron transition", 'leaf'],
  ["styles/tasks-page.css .tp-group-plus-wrap .todo-group-action-btn transition", 'leaf'],
  ["styles/thread-map.css .thread-map-overlay animation", 'overlay'],
  ["styles/thread-review.css .thread-review-bar-chevron transition", 'leaf'],
  ["styles/thread-stack-chrome.css .thread-drawer animation", 'overlay'],
  ["styles/thread-stack-chrome.css .thread-drawer[data-state='closing'] animation", 'overlay'],
  ["styles/thread-stack.css .thread-toast.wn-notice animation", 'overlay'],
  ["styles/topics.css .topic-member-remove transition", 'leaf'],
  ["styles/unpaired-notice.css .unpaired-notice-submit transition", 'leaf'],
  ["styles/usage-breakdown.css .usage-bd-chart[aria-busy] transition", 'leaf'],
  ["styles/voice-conversation.css .voice-key transition", 'leaf'],
]);

/** Selectors that are page scrollers holding sideways scrollers: no fade may target them. */
const NO_FADE_INSIDE = /\.settings-pane(?:-inner)?(?![\w-])|\.settings-disclosure-content(?![\w-])/;

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...cssFiles(full));
    else if (entry.name.endsWith('.css')) out.push(full);
  }
  return out.sort();
}

const KEYFRAMES = /@keyframes\s+([\w-]+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g;

/** Every fade in the app's CSS, as KNOWN_FADES keys. */
function fades(): string[] {
  const files = cssFiles(WEB_SRC).map((f) => ({
    rel: path.relative(WEB_SRC, f).split(path.sep).join('/'),
    css: fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''),
  }));
  const opacityKeyframes = new Set<string>();
  for (const { css } of files) {
    for (const m of css.matchAll(KEYFRAMES)) if (/opacity/.test(m[2])) opacityKeyframes.add(m[1]);
  }
  const names = [...opacityKeyframes];
  const named = (value: string) =>
    names.some((n) => new RegExp(`(?<![\\w-])${n.replace(/[-]/g, '\\-')}(?![\\w-])`).test(value));
  const out: string[] = [];
  for (const { rel, css } of files) {
    const body = css.replace(KEYFRAMES, '');
    for (const m of body.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
      const selector = m[1].split(/\s+/).filter(Boolean).join(' ').replace(/"/g, "'");
      const decls = m[2];
      const kinds = new Set<string>();
      for (const a of decls.matchAll(/(?<![\w-])animation(?:-name)?\s*:\s*([^;]+)/g)) {
        if (!/infinite/.test(a[1]) && named(a[1])) kinds.add('animation');
      }
      for (const a of decls.matchAll(/(?<![\w-])transition(?:-property)?\s*:\s*([^;]+)/g)) {
        if (/(?<![\w-])(opacity|all)(?![\w-])/.test(a[1])) kinds.add('transition');
      }
      for (const k of [...kinds].sort()) out.push(`${rel} ${selector} ${k}`);
    }
  }
  return out;
}

describe('opacity fades and WebKit layer leaks', () => {
  const found = fades();

  it('finds the fades (the scan itself works)', () => {
    expect(found.length).toBeGreaterThan(50);
    expect(found).toContain('styles/overlay-family.css html .wn-dialog transition');
  });

  it('no fade targets the Settings pane or the rows a disclosure shows', () => {
    expect(found.filter((k) => NO_FADE_INSIDE.test(k.replace(/\S+\s/, '')))).toEqual([]);
  });

  it('every fade is known: a new one is checked against the leaking shape first', () => {
    const unknown = found.filter((k) => !KNOWN_FADES.has(k));
    expect(unknown, 'New opacity fade(s). Read this file\'s header: add each to KNOWN_FADES with its reason, or drop the fade.').toEqual([]);
  });

  it('lists no fade that is gone', () => {
    const present = new Set(found);
    expect([...KNOWN_FADES.keys()].filter((k) => !present.has(k))).toEqual([]);
  });
});
