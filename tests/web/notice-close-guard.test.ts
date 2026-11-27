/**
 * Every card and notice in front of the user has a visible close: the one ×, NoticeClose
 * (2026-11-22, the user, of a quick bar card that stayed: "why there is no x so that i cna close";
 * 2026-11-23, of a question card over a session chat: "能不能有办法把它 collapse"; his standing rule:
 * every card or notice in front of him has a visible close button). standard.md "Cards" holds the rule.
 *
 * This fails when:
 *  - a NoticeCard, PanelNotice or AskCardFrame is drawn without its `onClose` (or a NoticeClose inside);
 *  - an element of its own markup whose root class names a notice (-banner, -notice, -toast, -alert,
 *    -callout, -receipt) has no close in it (tests/web/notice-close-scan.ts finds them all);
 *  - a notice the scan cannot recognise by its class (listed in NAMED, from the audit's inventory of
 *    2026-11-27) loses its close;
 *  - the × stops being the one NoticeClose, or the parts stop drawing it.
 * A member that is not a card or notice, or is closed by the card around it, is listed in NOT_A_CARD
 * with why; that list only shrinks.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, allMembers, sources } from './notice-close-scan';

/**
 * Live lines (role="alert" or "status") with no × of their own, per file: the words a form or a pane
 * says in place (a field's error, "Saving…", a check's result), which clear when their state does. They
 * are lines, not cards, so they were recorded as they were on 2026-11-27; the count per file only goes
 * down. A new one fails: give it NoticeClose, or, when it is a form's line, record it with
 * NOTICE_CLOSE_RECORD=1 and say why in the change.
 */
const BASELINE = path.join(ROOT, 'tests/web/notice-close-baseline.json');

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** `file:name` of a member that is no card or notice, or closes through the card it sits in, and why. */
const NOT_A_CARD: Record<string, string> = {
  'web/src/components/common/UnpairedNotice.tsx:unpaired-notice': 'the full-screen sign-in and pairing gate: a page, not a card',
  'web/src/components/apps-page/HomeTile.tsx:apps-home-alert': 'a red dot on an app\'s tile, a badge, not a card',
  'web/src/components/common/FileViewer.tsx:sfe-notice': 'the "Looking for it" placeholder and the whole body of the missing-file dialog, whose Close closes it',
  'web/src/components/common/SetupBanner.tsx:setup-banner': 'the local Claude Code notice\'s body: its × (NoticeClose, from useLocalClaudeNotice) sits beside it, and the first-use card around it has its own',
  'web/src/components/common/FirstUseSetup.tsx:setup-banner': 'the same body inside the first-use card, whose × (first-use-close) closes the card',
  'web/src/components/common/NotificationProblems.tsx:NoticeCard': 'the Claude Code card gets its × (NoticeClose) from useLocalClaudeNotice in its end; the remote hosts card passes onClose',
  'web/src/components/actions/AskCard.tsx:AskCardFrame': 'OneCardFrame\'s frame, given the caller\'s onClose through a spread',
  'web/src/components/org/OrgThreads.tsx:AskCardFrame': 'the letter and choice asks inside a thread card, whose × (org-thread-close) folds the whole card',
  'web/src/components/org/thread-card-answer.tsx:AskCardFrame': 'the needs-you answer inside a thread card, whose × (org-thread-close) folds the whole card',
  'web/src/components/notes/MarkdownEditorPanel.tsx:notes-reload-banner': 'its × is drawn once for every state by ReloadBanner\'s frame (notes-reload-banner-close)',
  'web/src/components/common/HostProblemRows.tsx:hpb-receipt': 'the receipt\'s words; its × (hpb-receipt-close) sits beside them so the words read exactly',
  'web/src/components/settings/sections/RemoteHostReadiness.tsx:rh-receipt': 'the receipt\'s words; its × (rh-receipt-close) sits beside them',
  'web/src/components/common/PictureStrip.tsx:picture-strip-notice': 'the notice\'s words; its × sits beside them',
  'web/src/components/chat/SuggestCard.tsx:sug-receipt': 'the "Suggestion dismissed" line a closed suggestion leaves in the chat: history, the card was already closed',
};

/**
 * Notices whose class the scan does not know by name, each by its own × (a testid or a class on its
 * NoticeClose, or the closeTestId a part draws): one × in the file no longer stands for the others.
 */
const NAMED: Record<string, { what: string; closes: string[] }> = {
  'web/src/components/layout/AwayLine.tsx': { what: '"Your Mac is away" lines (shell and composer)', closes: ['away-line-close', 'mac-away-composer-close'] },
  'web/src/components/layout/ConnectionLine.tsx': { what: '"Not connected" line', closes: ['connection-line-close'] },
  'web/src/components/layout/PhoneStatusRow.tsx': { what: 'the phone\'s status rows', closes: ['phone-status-close'] },
  'web/src/components/sessions/QueuedRowNotes.tsx': { what: 'held, waiting and left-the-queue notes under a message', closes: ['queue-note-close'] },
  'web/src/components/sessions/AgentWaitNote.tsx': { what: 'the agent-wait note under a message', closes: ['agent-wait-close'] },
  'web/src/components/sessions/EngineSignInNote.tsx': { what: 'the engine sign-in note under a message', closes: ['engine-sign-in-close'] },
  'web/src/components/sessions/PromptCards.tsx': { what: 'the permission and question cards in the chat (both fold)', closes: ['permission-request-close'] },
  'web/src/components/sessions/SessionSupervisionBar.tsx': { what: 'the cron recovery bar', closes: ['session-supervision-close'] },
  'web/src/components/sessions/TerminalModeNotices.tsx': { what: 'the terminal\'s notices', closes: ['terminal-plain-close', 'terminal-end-unconfirmed-close'] },
  'web/src/components/quickbar/QuickBarFoot.tsx': { what: 'the quick bar\'s foot notes', closes: ['qb-foot-note-close', 'qb-foot-trouble-close'] },
  'web/src/components/common/RegionErrorBoundary.tsx': { what: 'a region\'s crash card', closes: ['region-error-close'] },
  'web/src/components/chat/SuggestCard.tsx': { what: 'an AI suggestion card', closes: ['sug-card-close'] },
  'web/src/components/chat/ChatRowLines.tsx': { what: 'the send-failed and turn-interrupted lines', closes: ['chat-send-failed-close', 'chat-interrupt-close'] },
  'web/src/components/tasks/TodoFilterEmpty.tsx': { what: 'the filter override line and pill, the off-view note', closes: ['task-filter-override-close', 'todo-offview-dismiss'] },
  'web/src/components/tasks/StartQueueLine.tsx': { what: 'the start-queue line', closes: ['task-detail-start-queue-close'] },
  'web/src/components/tasks/AnsweredForLine.tsx': { what: 'the answered-for line', closes: ['task-detail-answered-for-close'] },
  'web/src/components/tasks/HomeBoardSheet.tsx': { what: 'the home board sheet\'s error and done lines', closes: ['home-board-error-close', 'home-board-done-close'] },
  'web/src/components/org/OrgThreadsByState.tsx': { what: 'the "Moved to" note', closes: ['org-thread-move-close'] },
  'web/src/components/org/TopThread.tsx': { what: 'the top thread above a chat', closes: ['top-thread-hide'] },
  'web/src/components/org/OrgTaskRail.tsx': { what: 'the Needs you rail\'s cards', closes: ['org-alert-close'] },
  'web/src/components/org/OrgThreads.tsx': { what: 'a thread card', closes: ['org-thread-close'] },
  'web/src/components/org/PoppedThreadCard.tsx': { what: 'a task below\'s thread card', closes: ['org-thread-close'] },
  'web/src/components/actions/ActionNeeded.tsx': { what: 'a task\'s ask, in its row and above its chat', closes: ['action-item-close', 'action-strip-hide'] },
  'web/src/components/board/kanban/KanbanCard.tsx': { what: 'a board card\'s live prompt', closes: ['kanban-card-ask-close'] },
  'web/src/components/board/kanban/KanbanCardDetail.tsx': { what: 'a board card\'s prompt in its detail', closes: ['kanban-card-ask-close'] },
  'web/src/components/board/kanban/KanbanLeaderRow.tsx': { what: 'a board leader row\'s prompt', closes: ['kanban-card-ask-close'] },
  'web/src/components/board/kanban/KanbanToasts.tsx': { what: 'board move toasts and their "+N more"', closes: ['kanban-toast-dismiss', 'kanban-toasts-more-close'] },
  'web/src/components/hosts/HostConnectCard.tsx': { what: 'the host first-connect card and pill', closes: ['host-connect-close'] },
  'web/src/components/approvals/ApprovalPrompts.tsx': { what: 'approval cards, pill, settled receipt and the stopped-asking note', closes: ['approval-close', 'approval-settled-close', 'approval-stopped-close'] },
  'web/src/components/common/NotificationToaster.tsx': { what: 'every pushed toast, an ask toast, the asks-waiting line and the "N more" card', closes: ['notification-toast-close', 'nfc-more-asks-close', 'notification-toaster-more-close'] },
  'web/src/components/sessions/ThreadPanelToast.tsx': { what: 'the thread action toast', closes: ['thread-toast-close'] },
  'web/src/components/calendar/CalendarAlert.tsx': { what: 'the calendar\'s load alert', closes: ['cal-alert-close'] },
  'web/src/focus-spaces/FocusBanner.tsx': { what: 'the focus banner', closes: ['focus-banner-close'] },
  'web/src/components/common/FirstUseSetup.tsx': { what: 'the first-use setup card', closes: ['first-use-close'] },
  'web/src/apps/mail/MailListStatus.tsx': { what: 'the mail list\'s status strip', closes: ['mail-list-status-close'] },
  'web/src/apps/mail/MailMessageList.tsx': { what: 'the mail row-action strip', closes: ['mail-row-note-close'] },
  'web/src/apps/mail/MailAccountsPane.tsx': { what: 'the mail folder pane strip', closes: ['mail-pane-strip-close'] },
  'web/src/components/chat/IslandResultCard.tsx': { what: 'an AI result card in a rich block', closes: ['island-result'] },
  'web/src/components/sessions/EngineFallbackBanner.tsx': { what: 'the engine fallback banner', closes: ['engine-fallback-dismiss'] },
  'web/src/components/common/StaleBuildPill.tsx': { what: 'the update notice', closes: ['stale-build-pill-later'] },
  'web/src/components/routines/RoutineRow.tsx': { what: 'a routine\'s action error', closes: ['routine'] },
};


describe('every card and notice can be closed', () => {
  const members = allMembers();

  it('finds the cards and notices it guards', () => {
    const names = new Set(members.map((m) => `${m.file}:${m.name}`));
    for (const known of [
      'web/src/components/quickbar/QuickBarReceipts.tsx:NoticeCard',
      'web/src/components/sessions/SessionPanel.tsx:PanelNotice',
      'web/src/components/actions/ActionNeeded.tsx:AskCardFrame',
      'web/src/components/sessions/UsageLimitBanner.tsx:session-error-banner',
      'web/src/components/common/FileContentView.tsx:fv-offline-banner',
      'web/src/components/org/OrgReorgReminder.tsx:role=note.org-reorg-note',
    ]) expect(names, known).toContain(known);
    expect(members.length).toBeGreaterThan(60);
  });

  it('a live line without its × is one already recorded (the count per file only goes down)', () => {
    const now: Record<string, number> = {};
    for (const m of members) if (!m.closes && m.name.startsWith('role=')) now[m.file] = (now[m.file] ?? 0) + 1;
    if (process.env.NOTICE_CLOSE_RECORD === '1') {
      fs.writeFileSync(BASELINE, JSON.stringify(Object.fromEntries(Object.entries(now).sort()), null, 2) + '\n');
      return;
    }
    const was = JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as Record<string, number>;
    const grew = Object.entries(now).filter(([f, n]) => n > (was[f] ?? 0)).map(([f, n]) => `${f}: ${n} (recorded ${was[f] ?? 0})`);
    expect(grew, 'A new alert or status line with no ×: a notice gets NoticeClose; a form\'s own line is recorded with NOTICE_CLOSE_RECORD=1').toEqual([]);
    const fell = Object.entries(was).filter(([f, n]) => (now[f] ?? 0) < n).map(([f, n]) => `${f}: ${now[f] ?? 0} (recorded ${n})`);
    expect(fell, 'Fewer than recorded: good. Lower the record with NOTICE_CLOSE_RECORD=1').toEqual([]);
  });

  it('each one has its × (or is listed as no card, with why)', () => {
    const bad = members
      .filter((m) => !m.name.startsWith('role='))
      .filter((m) => !m.closes && !(`${m.file}:${m.name}` in NOT_A_CARD))
      .map((m) => `${m.file}:${m.line} ${m.name}: ${m.text.slice(0, 100).replace(/\s+/g, ' ')}`);
    expect(bad, 'Give it its ×: a part\'s onClose, or <NoticeClose> at the end of its first line (standard.md "Cards")').toEqual([]);
  });

  it('the no-card list holds only members that are still there', () => {
    const names = new Set(members.map((m) => `${m.file}:${m.name}`));
    const stale = Object.keys(NOT_A_CARD).filter((k) => !names.has(k));
    expect(stale, 'listed members that are gone: remove them').toEqual([]);
  });

  it('each notice the scan cannot name still draws its own ×', () => {
    const all = new Set(sources());
    const bad: string[] = [];
    for (const [f, { what, closes }] of Object.entries(NAMED)) {
      if (!all.has(f)) { bad.push(`${f} (${what}): file is gone`); continue; }
      // Every NoticeClose (or a part's close) of the file, with its testid and class.
      const src = read(f);
      const marks = [
        ...[...src.matchAll(/<NoticeClose\b[\s\S]*?\/>/g)].map((m) => m[0]),
        ...[...src.matchAll(/closeTestId[=:]\s*\{?\s*["'`][^"'`]+/g)].map((m) => m[0]),
      ].join('\n');
      for (const id of closes) if (!marks.includes(id)) bad.push(`${f} (${what}): no NoticeClose for ${id}`);
    }
    expect(bad).toEqual([]);
  });

  it('the × is the one NoticeClose, and the parts draw it', () => {
    const close = read('web/src/components/common/NoticeClose.tsx');
    // The family's quiet icon square (buttons.css) with the one close icon, never text of its own.
    expect(close).toMatch(/className=\{`btn btn-ghost btn-icon btn-sm wn-notice-close/);
    expect(close).toMatch(/\{ICON_CLOSE\}/);
    for (const part of ['web/src/components/common/NoticeCard.tsx', 'web/src/components/sessions/PanelNotice.tsx', 'web/src/components/actions/AskCard.tsx']) {
      expect(read(part), part).toMatch(/onClose\?: \(\) => void;/);
      expect(read(part), part).toMatch(/<NoticeClose\b/);
    }
  });

  it('no other close button is drawn for a notice', () => {
    // The old hand-drawn ×s (a text glyph in a button of its own) are gone; a new one fails here.
    const bad = sources().filter((f) => /\bwn-notice-x\b/.test(read(f)));
    expect(bad).toEqual([]);
  });
});
