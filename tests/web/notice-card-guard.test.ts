/**
 * ONE notification system: one way in (pushToast / notify for a message, or <CornerSlot> for a
 * notice with live state of its own), one card (NoticeCard, web/src/components/common/NoticeCard.tsx)
 * and one place (the corner stack at the bottom left, corner-stack.tsx). 2026-11-20, the user: "我们
 * 能不能有一个 generic 的 notification system？每次加一个新 notification，所有人都要去自己去加一个。比如
 * 说这你又加到右上方了，为什么呀？... 整个 system 就那么一个 notification system".
 *
 * This fails when:
 *  - a file puts something into the corner stack without drawing it as a NoticeCard;
 *  - a new toast, toaster, snackbar, notice, banner or receipt component appears that is not
 *    listed below with what it is (a new popup goes through the system instead);
 *  - a notice card's frame is drawn by a notice's own CSS again (a background, border or radius of
 *    its own on a card in the stack), or a card in the stack gets a bar down one side.
 * tests/web/corner-stack-guard.test.ts keeps the place; this file keeps the card.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const listed = (globs: string[]) =>
  execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', ...globs], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean).filter((f) => fs.existsSync(path.join(ROOT, f)));

const SOURCES = listed([':(glob)web/src/**/*.ts', ':(glob)web/src/**/*.tsx', ':(glob)plugin-store/**/*.ts', ':(glob)plugin-store/**/*.tsx'])
  .filter((f) => !/\.test\.tsx?$/.test(f));

/** What each notice-named file is: a popup drawn by the system, or not a popup at all. */
const KNOWN: Record<string, string> = {
  'web/src/components/common/NoticeCard.tsx': 'the card itself: every notice is drawn as it',
  'web/src/contexts/notifications/notice-face.ts': 'model: who a pushed toast is from, its status and where a click goes',
  'web/src/components/common/NotificationToaster.tsx': 'corner: every pushed toast, as NoticeCards',
  'web/src/components/board/kanban/KanbanToasts.tsx': 'corner: a board move\'s toast, as NoticeCards',
  'web/src/components/board/kanban/kanban-toasts.ts': 'model: the board toasts\' queue rules, no UI',
  'web/src/components/common/FileAskNotice.tsx': 'corner: why an Ask here opened no card, a NoticeCard',
  'web/src/components/quickbar/QuickBarReceipts.tsx': 'corner: the quick bar\'s receipts, as NoticeCards',
  'web/src/components/quickbar/useQuickReceipts.ts': 'model: the receipts\' states, no UI',
  'web/src/components/common/HostProblemNotices.tsx': 'source: pushes a host problem as a toast (pushToast), draws nothing',
  'web/src/components/common/NoticeText.tsx': 'part: the words inside a card (Details, Copy command)',
  'web/src/components/common/SetupBanner.tsx': 'inline: a row of the page asking to finish setup, part of its layout',
  'web/src/focus-spaces/FocusBanner.tsx': 'inline: the one line on top of Home\'s task list while in a focus, part of its layout',
  'web/src/components/common/UnpairedNotice.tsx': 'page: the full-screen sign-in page',
  'web/src/components/common/update-notice-dock.ts': 'model: where the update notice docks (the sidebar), no UI',
  'web/src/components/common/update-notice-snooze.ts': 'model: the update notice\'s snooze, no UI',
  'web/src/components/inbox/item-receipt-model.ts': 'model: an inbox letter\'s read receipt, no UI',
  'web/src/components/sessions/ContextFullBanner.tsx': 'inline: a row inside a session\'s chat',
  'web/src/components/sessions/DraftFallbackNotice.tsx': 'inline: a row inside a draft session',
  'web/src/components/sessions/EngineFallbackBanner.tsx': 'inline: a row inside a session\'s chat',
  'web/src/components/sessions/FolderGoneBanner.tsx': 'inline: a row inside a session\'s chat',
  'web/src/components/sessions/InjectedBannerRow.tsx': 'inline: a row of a session\'s timeline',
  'web/src/components/sessions/PanelNotice.tsx': 'inline: a row inside a session panel',
  'web/src/components/sessions/TerminalModeNotices.tsx': 'inline: rows inside a terminal session',
  'web/src/components/sessions/ThreadPanelToast.tsx': 'panel: the answer to a thread action, drawn as a NoticeCard over that panel\'s composer (its Undo stays by the rows it changed)',
  'web/src/components/sessions/UsageLimitBanner.tsx': 'inline: a row inside a session\'s chat',
  'web/src/components/sessions/history-notice-text.ts': 'model: words, no UI',
  'web/src/components/sessions/stale-banner-text.ts': 'model: words, no UI',
  'web/src/components/workspaces/cleanup-notices.ts': 'model: words, no UI',
  'web/src/components/workspaces/useCleanupNotices.ts': 'source: pushes workspace cleanups as toasts',
  'web/src/contexts/notifications/system-notice.ts': 'source: the one exit to the OS notification',
  'web/src/contexts/notifications/toast-once.ts': 'source: pushes a toast once',
  'web/src/utils/attention-banner-model.ts': 'model: no UI',
  'web/src/utils/host-banner-dismiss.ts': 'model: no UI',
  'web/src/utils/host-problem-toasts.ts': 'source: which host problems become toasts',
  'web/src/utils/local-claude-banner.ts': 'model: no UI',
  'web/src/utils/thread-toast-place.ts': 'model: where the thread toast sits in its panel',
  'plugin-store/walnut-rhythm/src/server/notices.ts': 'server: a plugin\'s notices, sent through walnut.notifications',
};

const NOTICE_FILE = /(toast|toaster|snackbar|notice|banner|receipt)[^/]*$/i;

describe('one notification system', () => {
  it('every notice-named file is a known one (a new popup goes through pushToast or <CornerSlot> + NoticeCard)', () => {
    const named = SOURCES.filter((f) => NOTICE_FILE.test(path.basename(f)));
    const unknown = named.filter((f) => !(f in KNOWN));
    expect(unknown, 'A new notice: push it with pushToast/notify, or render a NoticeCard inside <CornerSlot>; then list the file here with what it is').toEqual([]);
    expect(Object.keys(KNOWN).filter((f) => !named.includes(f)), 'a KNOWN entry no file has: drop it').toEqual([]);
  });

  it('whatever goes into the corner stack is drawn as a NoticeCard', () => {
    const users = SOURCES.filter((f) => !f.endsWith('components/common/corner-stack.tsx'))
      .filter((f) => /<CornerSlot\b|appendToCornerStack\(/.test(read(f)));
    expect(users.length).toBeGreaterThanOrEqual(7);
    const bad = users.filter((f) => !/\bNoticeCard\b|\bnoticeCardElement\(/.test(read(f)));
    expect(bad, 'Draw the notice as a <NoticeCard> (common/NoticeCard.tsx)').toEqual([]);
  });

  it('the panel\'s thread toast is a NoticeCard too', () => {
    expect(read('web/src/components/sessions/ThreadPanelToast.tsx')).toMatch(/<NoticeCard\b/);
  });

  it('no notice draws its own card frame or a bar down one side in the stack', () => {
    const css = listed([':(glob)web/src/**/*.css']).filter((f) => !f.endsWith('notice-card.css'));
    const bad: string[] = [];
    for (const f of css) {
      const src = read(f).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
      for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = m[1]!.trim().replace(/\s+/g, ' ');
        const body = m[2]!;
        if (!/\.corner-stack\b/.test(selector) && !/\.(?:notification-toast|kanban-toast|qb-receipt|hcc-card|fv-ask-notice|corner-more)\b(?![-\w])/.test(selector)) continue;
        if (/\.corner-stack\s*$/.test(selector) || /\.corner-stack(?:\.[\w-]+)*\s*$/.test(selector)) continue;
        if (/border-(?:left|right|inline-start|inline-end)(?:-color|-width)?\s*:/.test(body)) bad.push(`${f}: ${selector} (a side of its own)`);
        if (/(^|[;\s])background(?:-color)?\s*:\s*(?![\s]|transparent|none)/.test(body) && /\.(?:notification-toast|kanban-toast|qb-receipt|hcc-card|fv-ask-notice|corner-more)(?:\s|$|,|\.|:)/.test(selector)
          && !/(-btn|-action|-close|-more|-kbd|-detail|-timer|-cmd)/.test(selector.split(' ').at(-1) ?? '')) {
          bad.push(`${f}: ${selector} (a background of its own)`);
        }
      }
    }
    expect(bad, 'The frame is the NoticeCard\'s (notice-card.css); colour that means something goes in its status dot').toEqual([]);
  });

  // 2026-11-21 audit of the notification center on real data: its rows were a third card of their
  // own (unread ones a blue fill with a strong border, the Claude Code notice a yellow block with an
  // orange border), so the center did not look like one family with the toasts.
  it('every row the notification center draws is a NoticeCard: feed rows, asks, Claude Code, problem hosts', () => {
    const cards = read('web/src/components/common/NotificationFeedCards.tsx');
    // FeedItem and PermissionCard each return a NoticeCard, and nothing else there wears a row's class.
    for (const name of ['FeedItem', 'PermissionCard']) {
      const body = cards.slice(cards.indexOf(`function ${name}(`));
      expect(body.slice(0, body.indexOf('\n});')), name).toMatch(/<NoticeCard\b[\s\S]*className=\{`notification-feed-item/);
    }
    const rowClasses = [...cards.matchAll(/className=\{?[`'"]([^`'"]*notification-feed-item(?![-\w])[^`'"]*)/g)];
    expect(rowClasses.length).toBe(2);
    // The panel itself draws no row: it lays out the lists and hands each item to FeedGroups.
    const panel = read('web/src/components/common/NotificationPanel.tsx');
    expect(panel).not.toMatch(/className=\{?[`'"][^`'"]*notification-feed-item(?![-\w])/);
    expect(panel).not.toMatch(/notification-card(?![-\w])/);
    const problems = read('web/src/components/common/NotificationProblems.tsx');
    expect(problems.match(/<NoticeCard\b/g)?.length).toBe(2);
    expect(problems).not.toMatch(/className="notification-card(?![-\w])/);
  });

  it('no stylesheet paints a notification-center row: unread is its status dot and word, never a fill or a strong frame', () => {
    const css = listed([':(glob)web/src/**/*.css']).filter((f) => !f.endsWith('notice-card.css'));
    const ROW = /\.(?:notification-feed-item|nfc-perm-card|nfc-local-claude|nfc-problem-hosts)(?![-\w])/;
    const bad: string[] = [];
    for (const f of css) {
      const src = read(f).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
      for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        for (const sel of m[1]!.split(',').map((x) => x.trim().replace(/\s+/g, ' '))) {
          // Only a rule on the row itself (its last compound), not on something inside it.
          const last = sel.split(/\s*[>+~]\s*|\s+/).at(-1) ?? '';
          if (!ROW.test(last)) continue;
          const body = m[2]!;
          if (/(^|[;\s])background(?:-color)?\s*:\s*(?!transparent|none)/.test(body)) bad.push(`${f}: ${sel} (a fill)`);
          if (/border(?:-(?:left|right|top|bottom))?(?:-width)?\s*:/.test(body)) bad.push(`${f}: ${sel} (a frame of its own)`);
          if (/\.unread\b/.test(sel) && /border-color|box-shadow|color\s*:/.test(body)) bad.push(`${f}: ${sel} (unread drawn as colour)`);
        }
      }
    }
    expect(bad, 'A row\'s frame is the NoticeCard\'s (notice-card.css); its state is its status dot and word').toEqual([]);
    // The System pane's blocks share the card's frame too: no warning-tinted block.
    const globals = read('web/src/styles/globals.css');
    expect(globals).not.toMatch(/\.notification-card\.warn\s*\{[^}]*background/);
  });

  it('the card keeps the frame: frosted glass, the same hairline on all four sides, a 14px radius', () => {
    const card = read('web/src/components/common/NoticeCard.tsx');
    expect(card).toContain("'wn-notice wn-glass-frost'");
    const css = read('web/src/styles/notice-card.css');
    expect(css).toMatch(/html \.wn-notice\.wn-notice \{[^}]*border: 1px solid var\(--glass-frost-border/);
    expect(css).toMatch(/html \.wn-notice\.wn-notice \{[^}]*border-radius: 14px/);
    expect(css).not.toMatch(/border-(?:left|right)\s*:/);
  });
});
