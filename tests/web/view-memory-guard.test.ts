/**
 * Guard: a page's view choice (a tab, a filter, a sort, a section, a mode, a show-this toggle)
 * survives leaving the page, a reload and a restart, so none may live only in component state.
 *
 * 2026-11-01, the user: "every time I click out of the Org page and back, it resets. If I was in
 * Threads it puts me back in Task ... it should take into account all the tabs, not only this
 * page. Walnut needs to remember what was open last time, permanently, on every page." The Org
 * node's top view and Task tab were `useState('task')` and `useState('needs')`: every route but
 * Home unmounts on navigation, so they came back reset.
 *
 * 2026-11-02, the user, on a plugin page that lost its session panel's full screen and Files tab:
 * "can we make it default feature in walnut no matter where include plugin, remember the state,
 * like full store, file tab, tab location ... a generic walnut thing not only to this plugin".
 * The class grew to what is open or picked to see (`active*`, `selected*`, `open*`, `*Open`,
 * `*Expanded`, `*Hidden`, `*Shown`, `*Target`): the session panel's split view and file lived
 * there, listed as passing. They are kept per place now (components/sessions/panel-view.ts).
 *
 * The class: a `useState` whose name says it holds a view choice, started from a literal (read
 * from no storage, no URL, no prop). The matcher is packages/plugin-cli/src/view-state-scan.ts,
 * the one `walnut-plugin validate` runs on a plugin's web code. This test finds every member in
 * web/src (pages, components, hooks, built-in apps) and in the plugins this repository ships
 * (examples/plugins, plugin-store, the browser-test fixtures). Each one is kept with usePageView
 * (web/src/utils/view-memory.ts), `walnut.ui.useView` in a plugin, or is listed below with why it
 * is a passing thing (a dialog, a menu, a picker, one search's results). A menu, picker, popover
 * or dialog open now, a keyboard cursor and a drag are passing by kind (PASSING_KIND). A typed
 * search is passing by design and its names (query, search) are not in the class. A new member
 * fails here until someone decides which it is.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { syncable } from '../../web/src/utils/ui-prefs-sync';
import { VIEW_IDS_MAX, VIEW_PREFIX, storedText, storedView, viewKey } from '../../web/src/utils/view-memory';
import { LITERAL, PASSING_KIND, VIEW_NAME, draftsOffDevice, useStates, viewStatesInMemory } from '../../packages/plugin-cli/src/view-state-scan';
import { isPanelView } from '../../web/src/components/sessions/panel-view';

const ROOT = join(__dirname, '../..');
const WEB_SRC = join(ROOT, 'web/src');

/** View-named state that is a passing thing, by file#name, and why. */
const PASSING: Record<string, string> = {
  'pages/AgentsPage.tsx#showForm': 'the new-agent form, a dialog',
  'pages/CommandsPage.tsx#showForm': 'the new-command form, a dialog',
  'pages/DashboardPage.tsx#showForm': 'the new-task form, a dialog',
  'pages/MainPage.tsx#focusScope': 'where one focus request came from, reset after it is served',
  'components/sessions/PromptCards.tsx#activeQ': "which question of an open ask the number keys answer: a keyboard cursor, gone once it is answered",
  'components/sessions/PromptCards.tsx#keyPick': 'the choice a number key picked on an open prompt, waiting for Enter: a keyboard cursor, gone once it is answered',
  'components/chat/AskWalnutSlot.tsx#newMode': 'composing a new chat, one draft',
  'components/chat/ChatInput.tsx#drawingOpen': 'the drawing pad dialog, opened for one sketch in the composer',
  'components/chat/ComposerControlsBar.tsx#showDetail': 'the controls bar expanded for one compose',
  'components/chat/MentionPalette.tsx#pickedTab': 'the mention palette, a popover',
  'components/tasks/ProjectDetailPane.tsx#scriptsOpen': "the project's scripts dialog, open now",
  'components/workspaces/DraftWorkspaceRow.tsx#commandOpen': "a long setup command shown whole in one draft, gone once it starts",
  'components/sessions/SessionTerminal.tsx#scriptTarget': 'which open terminal the last project script was typed into, gone with the terminal view',
  'components/workspaces/SessionScriptsChip.tsx#showOutput': "the setup output dialog, open now",
  'components/sessions/BackgroundTasksPanel.tsx#chosenTab': 'a session\'s background jobs panel, a popover; it opens on the kind asked for',
  'components/sessions/SessionDiffView.tsx#narrowPane': 'a measurement of the pane width, not a choice',
  'components/sessions/EngineSettingsPopover.tsx#filter': 'a typed filter in a popover',
  'components/tasks/TaskDetailEdits.tsx#loopHidden': 'how many matches of one dependency search would make a loop, a count of that search',
  'components/sessions/SessionWebView.tsx#showAll': 'the session\'s full server list, an overlay opened for one look',
  'components/sessions/SessionChatHistory.tsx#activeTeamTab': 'which team of one conversation is read; it follows the conversation',
  'components/sessions/SessionPanel.tsx#prefillMode': 'how one prefill lands in the composer',
  'components/sessions/SessionPathSelector.tsx#hostFilter': 'the folder picker, a dialog',
  'components/sessions/SessionPathSelector.tsx#editMode': 'typing a path in the folder picker, a dialog',
  'components/sessions/SideQuestionDrawer.tsx#newThreadMode': 'one new side question being set up',
  'components/sessions/SideQuestionDrawer.tsx#newOutputMode': 'one new side question being set up',
  'components/sessions/WorkflowProgress.tsx#showScript': 'one workflow\'s script expanded',
  'components/routines/RoutinesView.tsx#showForm': 'the new-routine form, a dialog',
  'components/passwords/LockScreens.tsx#mode': 'the lock screen or its forgotten-password form; a reload opens on the lock screen, never on a half-typed recovery',
  'components/routines/TriggerPill.tsx#showPrompt': 'a trigger\'s prompt, a popover',
  'components/routines/TriggerPill.tsx#showHistory': 'a trigger\'s history, a popover',
  'components/routines/RoutineCard.tsx#historyOpen': 'one routine\'s run history unfolded in one look',
  'components/inbox/LetterReader.tsx#fileView': 'a file opened from one letter, an overlay',
  'components/common/FileContentView.tsx#showSource': 'source of the file open now; the next file opens rendered',
  'components/common/MicButton.tsx#showChevron': 'hover state',
  'components/common/NotificationPanel.tsx#section': 'the notification panel opens on the section that has news (it picks one per open)',
  'components/common/NotificationPanel.tsx#showArchived': 'archived letters looked up in one opening of the panel',
  'components/common/PageFind.tsx#scope': 'the find bar, a passing search',
  'components/common/PageFind.tsx#view': "the find bar's count and place, worked out again from the page",
  'components/chat/ChatInput.tsx#recallShown': 'a recalled message in the box, gone once it is edited or sent',
  'components/notes/MarkdownEditorPanel.tsx#rawMode': 'source editing of the note open now; its flush path assumes a note opens rendered',
  'components/settings/sections/ReposSection.tsx#showForm': 'the add-repository form, a dialog',
  'components/settings/sections/useSshHostEditor.ts#aliasShown': 'which new rows say their alias refusal under the field, from a Save or a left field; the row\'s state line says it at all times',
  'components/settings/sections/useSshHostEditor.ts#hostShown': 'which rows say their hostname refusal under the field, from Add and connect or a left field: a refusal of what is typed now, said again when the field is left',
  'components/settings/sections/SttModelRows.tsx#showAll': 'the list expanded past its first rows for one look',
  'components/settings/sections/TagsSection.tsx#filter': 'a typed search',
  'components/settings/sections/cloud/CompanionUpdatesRow.tsx#view': 'one update\'s notes, an overlay',
  'components/tasks/AdoptWorkerFlyout.tsx#filter': 'a typed search in a flyout',
  'components/tasks/ReleaseWorkerFlyout.tsx#filter': 'a typed search in a flyout',
  'components/tasks/TagEditor.tsx#showHidden': 'the tag editor, a popover',
  'components/tasks/TagEditor.tsx#showDropdown': 'the tag editor, a popover',
  'components/tasks/TaskKebabMenu.tsx#filter': 'a typed search in a menu',
  'components/tasks/TasksPageTable.tsx#filter': 'a typed search in a cell menu',
  'components/tasks/TodoPanel.tsx#searchSection': 'the results of one search',
  'components/tasks/TodoPanel.tsx#showDoneResults': 'the results of one search',
  'components/tasks/TodoPanel.tsx#showRelatedResults': 'the results of one search',
  'components/tasks/TodoPanel.tsx#showCompletedResults': 'the results of one search',
  'components/tasks/TodoPanel.tsx#showStaleDonePins': 'the stale pins expanded for one look',
  'components/tasks/TodoPanel.tsx#selectMode': 'selecting tasks for one bulk action',
  'components/tasks/TodoPanel.tsx#offView': 'the one-line note that a located task is not in the tab, for that one locate',
  'components/tasks/ViewDropdown.tsx#section': 'the view menu, a popover',
  'apps/mail/MailAccountFolders.tsx#filter': 'a typed search over one account\'s folders',
  'apps/mail/MailApp.tsx#showMailboxes': 'the mailbox drawer on a narrow window, an overlay',
  'components/board/kanban/useKanbanLayout.ts#mode': 'derived from the board\'s width',
  'components/sessions/UserMessagesSummary.tsx#collapsed': 'one summary folded',
  'apps/mail/MailCorrectPopover.tsx#expanded': 'rows expanded in a popover',
  'components/apps-page/PluginStoreGrid.tsx#addOpen': 'the add-a-plugin dialog',
  'components/board/kanban/KanbanCard.tsx#expanded': 'one card expanded for one look',
  'components/board/kanban/KanbanCard.tsx#promptOpen': 'a card\'s prompt, a popover',
  'components/board/kanban/KanbanFilters.tsx#changesOpen': 'the changes list of the filter bar, a popover',
  'components/board/kanban/KanbanToasts.tsx#expanded': 'a toast stack expanded',
  'components/calendar/CalendarSidePanel.tsx#openItem': 'an event opened from the side panel, an overlay',
  'components/calendar/CalendarsPopover.tsx#hiddenOpen': 'the hidden calendars list inside a popover',
  'components/chat/AskWalnutDrawer.tsx#agentsOpen': 'the agent list inside the drawer, a popover',
  'components/chat/AskWalnutSlot.tsx#drawerOpen': 'the asks drawer, an overlay',
  'popout/ExtFirstPage.tsx#relayOpen': 'the browser relay panel under its pill, a popover',
  'components/chat/ChatMessage.tsx#manualOpen': 'one message folded or unfolded by hand',
  'components/commands/CommandCard.tsx#expanded': 'one card expanded for one look',
  'components/common/DocCommentsLayer.tsx#listOpen': 'the comments list, a popover',
  'components/common/FileContentView.tsx#historyOpen': 'a file\'s history, a popover',
  'components/common/FileContentView.tsx#searchOpen': 'the find bar, a passing search',
  'components/common/FileContentView.tsx#barStep': 'how many tools the document bar folds into its menu, measured from the bar width and the file name each render, not a choice',
  'components/common/NotificationPanel.tsx#detailOpen': 'one letter\'s raw detail unfolded',
  'components/common/NotificationPanel.tsx#expanded': 'one letter unfolded',
  'components/common/NotificationPanel.tsx#openLetterId': 'a letter read inside the notification panel, a popover',
  'components/common/NotificationPanel.tsx#openSeen': 'bookkeeping of one opening of the panel',
  'components/common/OfficePreview.tsx#activeSheet': 'the sheet of the file open now; the next file opens on its first',
  'components/common/PermissionPromptControls.tsx#expanded': 'one prompt\'s detail unfolded',
  'components/dock/FocusDock.tsx#activeTaskId': 'set by the dock\'s own events, not a choice',
  'components/hosts/HostFailureText.tsx#expanded': 'one failure\'s detail unfolded',
  'components/inbox/EmailItem.tsx#expanded': 'one mail unfolded',
  'components/layout/AppShell.tsx#sidebarOpen': 'the sidebar over a phone screen, an overlay',
  'components/layout/Sidebar.tsx#notifOpen': 'the notification panel, a popover',
  'components/layout/Sidebar.tsx#statusOpen': 'the status panel, a popover',
  'components/layout/SidebarStatusItems.tsx#openKey': 'one status item\'s popover',
  'components/notes/BacklinksPanel.tsx#expanded': 'one backlink unfolded',
  'components/notes/NotesTreePanel.tsx#activeHitPath': 'the cursor in one search\'s hits',
  'components/sessions/ChatEarlierBlock.tsx#expanded': 'earlier rows unfolded in one look',
  'components/sessions/CronJobsCard.tsx#promptOpen': 'a job\'s prompt, a popover',
  'components/sessions/DraftSessionPanel.tsx#openMenuNonce': 'a request counter, not a choice',
  'components/sessions/DraftSessionPanel.tsx#fallbackView': 'the provider tab of the model picker, a popover, while the launch is on the fallback',
  'components/sessions/EngineSettingsPopover.tsx#aboutOpen': 'an about note inside a popover',
  'components/sessions/EngineSettingsPopoverBody.tsx#expanded': 'a row unfolded inside a popover',
  'components/sessions/ModelPicker.tsx#detailsOpen': 'details inside the model picker, a popover',
  'components/sessions/QuotePinSelectionBar.tsx#commentOpen': 'one comment being written',
  'components/sessions/QuotePinSelectionBar.tsx#askPick': 'the Ask here choice for one selection, gone with the pill',
  'components/sessions/SessionChatHistory.tsx#cardOpen': 'one card unfolded',
  'components/sessions/SessionChatHistory.tsx#firstCheckShown': 'held stream rows, not a choice',
  'components/sessions/SessionChatHistory.tsx#mapDoneOpen': 'finished map rows unfolded in one look',
  'components/sessions/SessionCommitRepo.tsx#othersOpen': 'the other repositories in one commit form',
  'components/sessions/SessionDiffView.tsx#expanded': 'hunks unfolded; the file shown is kept (loadDiffMemory)',
  'components/sessions/SessionDiffView.tsx#searchOpen': 'the find bar, a passing search',
  'components/sessions/SessionFileExplorer.tsx#openRoots': 'restored from the explorer\'s own memory on load (file-view-state.ts)',
  'components/sessions/SessionFileExplorer.tsx#selectedFile': 'restored from the explorer\'s own memory on load (file-view-state.ts)',
  'components/sessions/SessionPanel.tsx#cronDetailOpen': 'a job\'s detail, a dialog',
  'components/sessions/SessionPanel.tsx#messagesOpen': 'the user\'s messages list, a popover',
  'components/sessions/SessionPanel.tsx#notesOpen': 'the task notes, a dialog',
  'components/sessions/SessionPanel.tsx#rewindTarget': 'one rewind being confirmed, a dialog',
  'components/sessions/SessionPathSelector.tsx#historyExpanded': 'the folder picker, a dialog',
  'components/sessions/SessionTurnsView.tsx#restoreTarget': 'one restore being confirmed, a dialog',
  'components/sessions/SessionTurnsView.tsx#selected': 'one turn picked in a dialog',
  'components/sessions/SideQuestionDrawer.tsx#archivedOpen': 'a section inside the question drawer, an overlay',
  'components/sessions/SideQuestionDrawer.tsx#legacyOpen': 'a section inside the question drawer, an overlay',
  'components/sessions/SideQuestionDrawer.tsx#notesOpen': 'notes inside the question drawer, an overlay',
  'components/sessions/TaskQuickActions.tsx#memoryOpen': 'the task memory, a dialog',
  'components/sessions/TaskQuickActions.tsx#detailOpen': 'the task details popup opened from the menu where the host has no detail pane, a dialog',
  'components/sessions/ThreadCommentCard.tsx#expanded': 'one comment unfolded',
  'components/sessions/TriggerPickerPopover.tsx#listOpen': 'a list inside a popover',
  'components/sessions/WorkflowProgress.tsx#transcriptTarget': 'one agent\'s transcript, an overlay',
  'components/sessions/useThreadReviewPane.tsx#selected': 'one question picked in the review pane',
  'components/settings/PluginJobsControls.tsx#openLog': 'one job\'s log, an overlay',
  'components/settings/sections/CloudSection.tsx#selected': 'a provider picked in one setup',
  'components/settings/sections/MailRulesFileRow.tsx#openFailed': 'one failed open, not a choice',
  'components/settings/sections/ReposSection.tsx#selectedSlug': 'one repository being edited',
  'components/settings/sections/SuggestAccuracyPanel.tsx#recentShown': 'the list expanded past its first rows for one look',
  'components/settings/sections/HealthMonitorSection.tsx#openId': 'one alarm opened for a look, a disclosure; the list it sits in is the view',
  'components/settings/sections/cloud/RemoteAccessCard.tsx#openBusy': 'a request in flight, not a choice',
  'components/tasks/FilterBar.tsx#overflowOpen': 'the filter overflow, a menu',
  'components/tasks/LeaderPill.tsx#adoptOpen': 'the adopt flyout',
  'components/tasks/PhonePhaseSheet.tsx#listOpen': 'a list inside a sheet, an overlay',
  'components/tasks/TaskList.tsx#selectedIds': 'tasks picked for one bulk action',
  'components/tasks/TaskSyncMenuRows.tsx#expanded': 'rows unfolded inside a menu',
  'components/tasks/TeamMenuItems.tsx#expanded': 'rows unfolded inside a menu',
  'components/tasks/TaskKebabMenu.tsx#memoryOpen': 'the memory and instructions panel opened from the menu, a dialog',
  'components/tasks/TodoPanel.tsx#detailTarget': 'a task\'s full-screen detail, an overlay that never comes back on its own (layout-state-on-disk-guard)',
  'components/tasks/TodoPanel.tsx#newProjectOpen': 'the new-project form, a dialog',
  'components/tasks/TodoPanel.tsx#selectedIds': 'tasks picked for one bulk action',
  'components/tasks/TodoSearchBar.tsx#layerOpen': 'the search layer, an overlay',
  'hooks/useContextInspector.ts#isOpen': 'the context inspector, a dialog',
  'hooks/useClaudeLaunchMode.ts#mode': "the engine's own default mode read from the host, not a choice",
  'hooks/useSessionHistory.ts#olderHidden': 'a count of loaded rows, not a choice',
  'hooks/useTasks.ts#completedHidden': 'a count from the server, not a choice',
  'hooks/useSessionThreads.ts#openCardKey': 'the comment card open now, a popover',
  'hooks/useTeamStream.ts#activeAgent': 'the agent the stream is on, set by the stream',
  'pages/CalendarPage.tsx#activeTask': 'a task being dragged onto the calendar',
  'pages/CalendarPage.tsx#openItem': 'an event opened, an overlay',
  'pages/CalendarPage.tsx#phoneRailOpen': 'the side rail over a phone screen, an overlay',
  'pages/MainPage.tsx#selectedTask': 'the focused task is kept in the layout record (homeFocusedTask); this answers for a row the list does not carry yet',
  'pages/MainPage.tsx#sessionSearchOpen': 'the session finder, a dialog',
  'pages/SettingsPage.tsx#openSeq': 'a request counter, not a choice',
  'apps/mail/MailCorrectPopover.tsx#step': 'the step of one correction in a popover',
  'components/common/FileContentView.tsx#fullscreen': 'one preview blown up over its own pane, an overlay of the file open now; the panel around it keeps its full screen (fullscreen-owner.ts)',
  'components/notes/slash-commands/SlashCommandPortal.tsx#subPanel': 'a level of the slash menu',
  'components/org/OrgChartSheet.tsx#panel': 'a panel inside the org chart sheet, itself passing',
  'components/sessions/SessionRewindDialog.tsx#guardStep': 'a step of the rewind dialog',
  'components/sessions/SessionUsageDialog.tsx#panel': 'a panel of the usage dialog',
  'components/tasks/FilterMenu.tsx#page': 'a level of the filter menu',
  'hooks/useReviewSidebar.ts#fullscreen': 'the question review blown up over the chat, an overlay',
  'pages/OrgPage.tsx#chartOpen': 'the org chart, a sheet over the page with a close of its own, opened on one node',
  'pages/MainPage.tsx#triagePanelOpen': 'one triage opened for one task (triageTaskId), a passing panel',
  'hooks/useThreadStack.ts#drawerMode': 'the question drawer, an overlay (per tab by spec C69)',
  'hooks/useThreadStack.ts#drawerFilter': 'the question drawer, an overlay (per tab by spec C69)',
  'hooks/useThreadStack.ts#showHidden': 'hidden questions in the drawer, an overlay (per tab by spec C69)',
};

/** The view choices the user named, and where each is kept now. */
const KEPT: ReadonlyArray<{ file: string; state: string; key: RegExp; what: string }> = [
  { file: 'components/org/OrgNodeDetail.tsx', state: 'topPick', key: /usePageViewOf<OrgTopView>\('org', 'node\.view', row\.key,/, what: 'an Org node\'s Threads / Task / Brief view, per node' },
  { file: 'components/org/OrgNodeDetail.tsx', state: 'keptTab', key: /usePageViewOf<KeptRailTab>\('org', 'node\.taskTab', row\.key,/, what: 'the Task view\'s tab, per node' },
  // 2026-11-06, the user: "and can expand for more detail"; what was opened stays opened.
  { file: 'components/org/OrgChartVp.tsx', state: 'open', key: /usePageViewOf\('org', 'chart\.open', key, false, isBoolean\)/, what: 'an org chart card or project row opened, per card and per row' },
  { file: 'components/org/OrgThreads.tsx', state: 'showClosed', key: /usePageView\('org', 'threads\.showClosed'/, what: 'the week\'s closed threads shown' },
  { file: 'pages/AppsPage.tsx', state: 'kept', key: /usePageView<AppsFilter>\('apps', 'filter'/, what: 'the Apps category chip' },
  // Kept as KeptStatusFilter: a To read chip an older build kept opens as Needs you (statusFilterShown).
  { file: 'components/board/BoardStatusView.tsx', state: 'kept', key: /usePageViewOf<KeptStatusFilter>\('board', 'statusFilter', ownerId,/, what: 'a board\'s status filter, per board' },
  { file: 'components/sessions/SessionFileExplorer.tsx', state: 'showHidden', key: /usePageView\('files', 'showHidden'/, what: 'hidden files shown in the explorer' },
  { file: 'components/sessions/SessionDiffView.tsx', state: 'treeCollapsed', key: /usePageView\('diff', 'treeCollapsed'/, what: 'the diff\'s file tree hidden' },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.(?:test|d)\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(WEB_SRC)
  .map((p) => ({ rel: relative(WEB_SRC, p), src: readFileSync(p, 'utf8') }));
const src = (rel: string): string => files.find((f) => f.rel === rel)?.src ?? '';

/** Every view choice held only in component state: file#name. */
function heldOnlyInState(): string[] {
  const out: string[] = [];
  for (const f of files) for (const d of viewStatesInMemory(f.src)) out.push(`${f.rel}#${d.name}`);
  return out.sort();
}

/** The plugins this repository ships: their web code is held to the same rule. */
const PLUGIN_DIRS = ['examples/plugins', 'plugin-store', 'tests/e2e/browser/fixtures'];
function pluginSources(): Array<{ rel: string; src: string }> {
  const out: Array<{ rel: string; src: string }> = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name === 'tests') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) visit(p);
      else if (/\.(?:tsx?|mjs|jsx?)$/.test(name) && !/\.(?:test|d)\.tsx?$/.test(name)) out.push({ rel: relative(ROOT, p), src: readFileSync(p, 'utf8') });
    }
  };
  for (const d of PLUGIN_DIRS) visit(join(ROOT, d));
  return out;
}

/** A shipped plugin's view state that is a passing thing, by file#name, and why. */
const PLUGIN_PASSING: Record<string, string> = {
  'examples/plugins/walnut-time/src/web/apps.tsx#expanded': 'one row unfolded for one look',
  'examples/plugins/walnut-time/src/web/chapters.tsx#openKey': 'one chapter unfolded for one look',
  'examples/plugins/walnut-time/src/web/lanes.tsx#appsOpen': 'the rest of the apps unfolded for one look',
  'examples/plugins/walnut-time/src/web/lanes.tsx#tasksOpen': 'the rest of the tasks unfolded for one look',
  'examples/plugins/walnut-time/src/web/screentime.tsx#expanded': 'one row unfolded for one look',
  'examples/plugins/walnut-time/src/web/tape.tsx#expanded': 'one row unfolded for one look',
};

describe('every page keeps its view choices (utils/view-memory.ts)', () => {
  it('a view choice held only in component state is listed as a passing thing, with why', () => {
    const held = heldOnlyInState();
    expect(held.length, 'the scan found nothing: the matcher broke').toBeGreaterThan(20);
    const unlisted = held.filter((k) => !(k in PASSING));
    expect(unlisted, 'a page holds a view choice only in component state: keep it with usePageView (utils/view-memory.ts), or list it in PASSING with why it is a passing thing').toEqual([]);
  });

  it('every listed passing thing still exists (remove the line when it goes)', () => {
    const held = new Set(heldOnlyInState());
    expect(Object.keys(PASSING).filter((k) => !held.has(k))).toEqual([]);
  });

  it('the view choices the user named are kept with usePageView', () => {
    for (const k of KEPT) {
      const decl = new RegExp(`const \\[${k.state}, set\\w+\\] = (\\w+)`).exec(src(k.file));
      expect(decl?.[1], `${k.file}: ${k.what}`).toMatch(/^usePageView(?:Of)?$/);
      expect(src(k.file), `${k.file}: ${k.what} under its key`).toMatch(k.key);
    }
  });

  it('a plugin this repository ships keeps its view choices with walnut.ui.useView, or lists them as passing', () => {
    const plugins = pluginSources();
    expect(plugins.some((f) => f.rel.endsWith('walnut-time/src/web/app.tsx')), 'the plugin scan sees nothing: its folders moved').toBe(true);
    const held = plugins.flatMap((f) => viewStatesInMemory(f.src).map((d) => `${f.rel}#${d.name}`)).sort();
    expect(held.filter((k) => !(k in PLUGIN_PASSING)), 'a plugin keeps a view choice only in useState: keep it with walnut.ui.useView, or list it in PLUGIN_PASSING with why').toEqual([]);
    expect(Object.keys(PLUGIN_PASSING).filter((k) => !held.includes(k)), 'remove the line when it goes').toEqual([]);
    // The example the plugin guide points at: the day or week picked is kept.
    expect(plugins.find((f) => f.rel.endsWith('walnut-time/src/web/app.tsx'))!.src).toMatch(/const \[scopeMode, setScopeMode\] = useView<ScopeMode>\('scopeMode', 'day'\)/);
  });

  it('a plugin this repository ships keeps a typed draft with walnut.ui.useDraft', () => {
    // A draft-named field that is no typed draft, by file#name, and why.
    const notDrafts: Record<string, string> = {
      'examples/plugins/walnut-demo/src/web/views-section.tsx#sessionDraft': 'a session id typed into a one-line field before Open: a form, not text being written',
      'examples/plugins/walnut-demo/src/web/server-section.tsx#probeUrl': 'a URL to try one request with, prefilled: a form field, not text being written',
      'plugin-store/walnut-rhythm/src/web/music-card.tsx#link': 'a playlist link pasted and added at once: a form field, not text being written',
    };
    const off = pluginSources().flatMap((f) => draftsOffDevice(f.src).map((d) => `${f.rel}#${d.name}`));
    expect(off.filter((k) => !(k in notDrafts)), 'keep a draft with walnut.ui.useDraft(name, { id }), or list it in notDrafts with why').toEqual([]);
    expect(Object.keys(notDrafts).filter((k) => !off.includes(k)), 'remove the line when it goes').toEqual([]);
  });

  it('each tab shows its own kept view: the snapshot is the tab\'s text, never storage read at render (view-state-tabs)', () => {
    const memory = src('utils/view-memory.ts');
    expect(memory).toMatch(/useSyncExternalStore\(useCallback\(\(fn\) => showKey\(key, id, fn\), \[key, id\]\), \(\) => snapshotOf\(key, id\)/);
    expect(memory.match(/useSyncExternalStore\(/g)?.length).toBe(1);
    // A plugin's draft lives in the draft store, which another window never changes under a box on screen.
    expect(src('plugins/use-draft.ts')).toMatch(/useDraft\(key, \{ followElsewhere: false \}\)/);
    expect(src('plugins/use-draft.ts')).toMatch(/draftKey\('plugin', pluginId, name/);
  });

  it('a session panel keeps what it shows per place, with no host doing anything (panel-view.ts)', () => {
    const panel = src('components/sessions/SessionPanel.tsx');
    // The split view, its file, the service and the letter come from the record, never useState.
    expect(panel).toMatch(/const panelView = usePanelView\(sheetAt\);/);
    for (const name of ['activeView', 'fileViewTarget', 'webRequest', 'inboxLetterId']) {
      expect(panel, `${name} is kept with the panel's view`).not.toMatch(new RegExp(`const \\[${name}, set\\w+\\] = useState`));
    }
    expect(panel).toMatch(/const \[chatCollapsed, setChatCollapsed\] = useState\(\(\) => panelView\.chatHidden\)/);
    // Full screen is kept as the same place.
    expect(panel).toMatch(/useFullscreen\(\{ keepAcrossRoutes: true, place: sheetAt \}\)/);
    // Every host names its place: the prop is required, and a plugin's SessionView passes its plugin.
    expect(panel).toMatch(/\n  viewPlace: string;\n/);
    expect(src('plugins/views.tsx')).toMatch(/viewPlace=\{`plugin:\$\{pluginId\}`\}/);
    // A stored record of another build reads as nothing kept.
    expect(isPanelView({ view: 'files', file: { path: '/r/a.ts', nonce: 2, line: 4 }, chatHidden: true })).toBe(true);
    expect(isPanelView({ view: null })).toBe(true);
    expect(isPanelView({ view: 'gone' })).toBe(false);
    expect(isPanelView({ view: 'web', web: { url: 1, nonce: 1 } })).toBe(false);
    expect(isPanelView('files')).toBe(false);
  });

  it('the matcher catches the shape that caused the bug, and the ways it may be written', () => {
    const caught = (code: string) => useStates(code).filter((d) => VIEW_NAME.test(d.name) && LITERAL.test(d.start)).map((d) => d.name);
    expect(caught("const [topPick, setTopPick] = useState<OrgTopView>('task');\nconst [taskTab, setTaskTab] = useState<OrgRailTab>('needs');\nconst [showClosed, setShowClosed] = useState(false);"))
      .toEqual(['topPick', 'taskTab', 'showClosed']);
    expect(caught("const [sortMode, setSortMode] = useState<Record<string, Set<string>>>({});")).toEqual(['sortMode']);
    expect(caught("const [tab, setTab] = useState<Tab>(() => 'needs');")).toEqual(['tab']);
    expect(caught("const [\n  tab,\n  setTab,\n] = useState<Tab>(\n  'needs',\n);")).toEqual(['tab']);
    expect(caught("const [view, setView] = useState('list' as View);")).toEqual(['view']);
    expect(caught("const [mode, setMode] = useState<(x: number) => void>(null);")).toEqual(['mode']);
    // Read from somewhere: not in the class. A typed search: not in the class.
    expect(caught("const [filter, setFilter] = useState(readFilter);\nconst [tab, setTab] = useState(() => readTab(id));\nconst [query, setQuery] = useState('');")).toEqual([]);
    // What is open or picked to see (2026-11-02: the session panel's split view and its file).
    const held = (code: string) => viewStatesInMemory(code).map((d) => d.name);
    expect(held("const [activeView, setActiveView] = useState<SessionSplitView | null>(null);\nconst [fileViewTarget, setFileViewTarget] = useState<Target | null>(null);\nconst [showPartner, setShowPartner] = React.useState(true);\nconst [lastTab, setLastTab] = useState<Tab>('topics');\nconst [sideOpen, setSideOpen] = useState(true);\nconst [selectedFile, setSelectedFile] = useState(null);"))
      .toEqual(['activeView', 'fileViewTarget', 'showPartner', 'lastTab', 'sideOpen', 'selectedFile']);
    // A menu, picker or dialog open now, a keyboard cursor, a drag: passing by kind.
    expect(held("const [menuOpen, setMenuOpen] = useState(false);\nconst [pickerOpen, setPickerOpen] = useState(false);\nconst [selectedIdx, setSelectedIdx] = useState(0);\nconst [activeDragId, setActiveDragId] = useState(null);\nconst [confirmOpen, setConfirmOpen] = useState(false);")).toEqual([]);
    expect(PASSING_KIND.test('roundMenuOpen')).toBe(true);
    expect(PASSING_KIND.test('partnerOpen')).toBe(false);
  });

  it('a view kept per node holds each node\'s own, the last written last, at most VIEW_IDS_MAX', () => {
    const isTab = (v: unknown): v is string => typeof v === 'string';
    let raw: string | null = null;
    raw = storedText(raw, 'main', 'threads');
    raw = storedText(raw, 'project:a', 'brief');
    raw = storedText(raw, '12', 'task');
    expect(storedView(raw, 'main', isTab)).toBe('threads');
    expect(storedView(raw, 'project:a', isTab)).toBe('brief');
    expect(storedView(raw, 'project:b', isTab)).toBeUndefined();
    raw = storedText(raw, 'main', 'task');
    expect(JSON.parse(raw).map((p: [string, unknown]) => p[0])).toEqual(['project:a', '12', 'main']);
    for (let i = 0; i < VIEW_IDS_MAX + 5; i++) raw = storedText(raw, `n${i}`, 'brief');
    expect(JSON.parse(raw)).toHaveLength(VIEW_IDS_MAX);
    expect(storedView(raw, 'main', isTab)).toBeUndefined();
    expect(storedView(raw, `n${VIEW_IDS_MAX + 4}`, isTab)).toBe('brief');
    // A shape from another build reads as nothing kept, never a crash.
    expect(storedView('{"main":"threads"}', 'main', isTab)).toBeUndefined();
    expect(storedView('not json', 'main', isTab)).toBeUndefined();
    expect(storedView('"gone-tab"', null, (v): v is 'task' => v === 'task')).toBeUndefined();
  });

  it('a kept view goes to disk with the other preferences (it survives a restart and cleared browser data)', () => {
    expect(viewKey('org', 'node.view')).toBe(`${VIEW_PREFIX}org.node.view`);
    expect(syncable(viewKey('org', 'node.view'))).toBe(true);
    expect(syncable(viewKey('board', 'statusFilter'))).toBe(true);
  });
});
