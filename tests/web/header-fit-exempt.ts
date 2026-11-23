/**
 * Header rows that stay off the shared header rule (components/common/HeaderFit.tsx), each with
 * why it can never let its buttons crush its title at any width. Keyed `<file under web/src>
 * <class the scan names the row by>` (header-fit-scan.ts rowKey). header-fit-ratchet.test.ts
 * fails on an entry whose row is gone or now on the rule, and on one with no real reason.
 */
export const HEADER_FIT_EXEMPT: Record<string, string> = {
  // Rows whose buttons sit on another line than the title, by design.
  'apps/mail/MailGroupedHeader.tsx mail-grouped-head': 'The mail list section wraps on purpose: its name never gets narrower than its longest word (min-width auto, break-word) and the controls move to the next line.',
  'apps/mail/MailGroupedList.tsx mail-not-important-head': 'The same wrapping mail list section as mail-grouped-head: the controls move to the next line, the name keeps its longest word.',
  'apps/mail/MailReaderHead.tsx mail-reader-head': 'A vertical block: the subject line has a 240 px basis and wraps, and the toolbar moves under it when there is no room beside it.',
  'components/apps-page/BuiltinAppsGrid.tsx apps-detail-head': 'The app detail head with its big icon puts its buttons on their own line under the title, never beside it.',
  'components/apps-page/PluginDetail.tsx apps-detail-head': 'The plugin detail head, the same layout as the built-in one: buttons on their own line under the title.',
  'components/board/BoardStatusView.tsx bs-head': 'A plain block: its children stack vertically, so the buttons never share a line with the h2.',
  'components/tasks/TaskDetailPane.tsx tdp-head': 'A column on purpose: the h2 has its own full-width wrapping line under the project, watch and close row.',
  'components/tasks/SearchAskLine.tsx search-ask-head': 'The text is the agent\'s question, which wraps in full and, below a 400 px container, moves to its own full-width line under the Show button.',
  'components/sessions/SessionPanel.tsx session-panel-header': 'A two-line shell: the buttons are on line one, folded by useSessionHeaderFit; the title has line two to itself (useTitleRowTight below 440 px).',
  'components/sessions/DraftSessionPanel.tsx session-panel-header': 'The same two-line shell as the session panel: an empty tool row, then the title row, where the "for:" text gives way first.',
  'components/sessions/ThreadStackHeader.tsx thread-stack-header': 'A block shell of a row plus a subtitle; the inner row keeps its title block at least min(34%, 200px) wide beside the back button.',
  'components/sessions/SessionUsageDialog.tsx session-usage-heading': 'A dialog title beside one fixed 32 px close button; the title and the session name wrap (overflow-wrap), top-aligned on purpose.',
  // Rows whose "title" is inside the one button, or that have no title to crush.
  'components/settings/SettingsFoldGroup.tsx settings-fold-group-heading': 'The only button is the full-width fold toggle that holds the title itself; nothing ever sits beside the title.',
  'components/routines/RoutinesView.tsx routine-group-heading': 'The whole h2 is one expand button holding the group name and count; no button sits beside it, and the name has its own truncation.',
  'components/sessions/BashToolCall.tsx chat-tool-block-header': 'A tool call row that is one button: "Bash" is a fixed four-letter label that never shrinks, and the command summary cuts with its own cue.',
  'components/org/OrgChartVp.tsx oc-vp-head': 'The row holds one child, the card\'s clickable body (oc-card-btn, a div the scan reads as a button); the name wraps inside it and the actions are below.',
  'components/sessions/ThreadPathBar.tsx tree-path-bar': 'A breadcrumb: every part is a button, there is no title for them to crush.',
  'components/common/MonthGrid.tsx dp-month-head': 'The month name sits between two arrow buttons in a box at least 210 px wide, which holds the longest name ("September 2026") whole.',
};
