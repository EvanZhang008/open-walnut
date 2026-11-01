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
 * The class: a `useState` whose name says it holds a view choice, started from a literal (read
 * from no storage, no URL, no prop). This test finds every member in web/src (pages, components,
 * hooks, built-in apps). Each one is kept with usePageView (web/src/utils/view-memory.ts) or is
 * listed below with why it is a passing thing (a dialog, a menu, a picker, one search's
 * results). A typed search is passing by design and its names (query, search) are not in the
 * class. A new member fails here until someone decides which it is.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { syncable } from '../../web/src/utils/ui-prefs-sync';
import { VIEW_IDS_MAX, VIEW_PREFIX, storedText, storedView, viewKey } from '../../web/src/utils/view-memory';

const WEB_SRC = join(__dirname, '../../web/src');

/** Names that hold a view choice. */
const VIEW_NAME = /^(?:\w*(?:Tab|Filter|View|Sort|Section|Scope|Mode|Group|Pick|Collapsed)|tab|filter|view|sort|section|scope|mode|group|collapsed|show[A-Z]\w*)$/;
/** A start that comes from nowhere: a literal, a constant, an empty collection (or a function returning one). */
const LITERAL = /^(?:\(\)\s*=>\s*)?(?:'[^']*'|"[^"]*"|-?\d+|true|false|null|undefined|\[\]|\{\}|new (?:Set|Map)(?:<[^>]*>)?\(\)|[A-Z][A-Z0-9_]+)?$/;
const DECL = /const\s*\[\s*(\w+)\s*,\s*\w+\s*,?\s*\]\s*=\s*useState\b\s*/g;

/** Every `const [name, setName] = useState<T>(start)` in a source: its name and start, generics and line breaks skipped. */
function useStates(src: string): Array<{ name: string; start: string }> {
  const out: Array<{ name: string; start: string }> = [];
  for (const m of src.matchAll(DECL)) {
    let i = m.index! + m[0].length;
    if (src[i] === '<') {
      // A generic, nested ones too (Record<string, Set<string>>); `=>` inside it is not a close.
      for (let depth = 0; i < src.length; i++) {
        if (src[i] === '<') depth++;
        else if (src[i] === '>' && src[i - 1] !== '=' && --depth === 0) { i++; break; }
      }
    }
    while (/\s/.test(src[i] ?? '')) i++;
    if (src[i] !== '(') continue;
    let j = i;
    for (let depth = 0; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')' && --depth === 0) break;
    }
    const start = src.slice(i + 1, j).trim().replace(/,$/, '').trim().replace(/\s+as\s+[\w.<>[\]| '"]+$/, '').trim();
    out.push({ name: m[1], start });
  }
  return out;
}

/** View-named state that is a passing thing, by file#name, and why. */
const PASSING: Record<string, string> = {
  'pages/AgentsPage.tsx#showForm': 'the new-agent form, a dialog',
  'pages/CommandsPage.tsx#showForm': 'the new-command form, a dialog',
  'pages/DashboardPage.tsx#showForm': 'the new-task form, a dialog',
  'pages/MainPage.tsx#focusScope': 'where one focus request came from, reset after it is served',
  'pages/TaskDetailPage.tsx#showDepPicker': 'the dependency picker, a popover',
  'components/chat/AskWalnutSlot.tsx#newMode': 'composing a new chat, one draft',
  'components/chat/ComposerControlsBar.tsx#showDetail': 'the controls bar expanded for one compose',
  'components/chat/MentionPalette.tsx#pickedTab': 'the mention palette, a popover',
  'components/sessions/BackgroundTasksPanel.tsx#chosenTab': 'a session\'s background jobs panel, a popover; it opens on the kind asked for',
  'components/sessions/EngineSettingsPopover.tsx#filter': 'a typed filter in a popover',
  'components/sessions/SessionChatHistory.tsx#activeTeamTab': 'which team of one conversation is read; it follows the conversation',
  'components/sessions/SessionChatHistory.tsx#showScrollArrow': 'derived from the scroll position',
  'components/sessions/SessionPanel.tsx#activeView': 'the Changed / Files / Terminal split, a full-screen overlay that never comes back on its own',
  'components/sessions/SessionPanel.tsx#prefillMode': 'how one prefill lands in the composer',
  'components/sessions/SessionPathSelector.tsx#hostFilter': 'the folder picker, a dialog',
  'components/sessions/SessionPathSelector.tsx#editMode': 'typing a path in the folder picker, a dialog',
  'components/sessions/SideQuestionDrawer.tsx#newThreadMode': 'one new side question being set up',
  'components/sessions/SideQuestionDrawer.tsx#newOutputMode': 'one new side question being set up',
  'components/sessions/WorkflowProgress.tsx#showScript': 'one workflow\'s script expanded',
  'components/routines/RoutinesView.tsx#showForm': 'the new-routine form, a dialog',
  'components/routines/TriggerPill.tsx#showPrompt': 'a trigger\'s prompt, a popover',
  'components/routines/TriggerPill.tsx#showHistory': 'a trigger\'s history, a popover',
  'components/inbox/LetterReader.tsx#fileView': 'a file opened from one letter, an overlay',
  'components/common/FileContentView.tsx#showSource': 'source of the file open now; the next file opens rendered',
  'components/common/MicButton.tsx#showChevron': 'hover state',
  'components/common/NotificationPanel.tsx#section': 'the notification panel opens on the section that has news (it picks one per open)',
  'components/common/NotificationPanel.tsx#showArchived': 'archived letters looked up in one opening of the panel',
  'components/common/PageFind.tsx#scope': 'the find bar, a passing search',
  'components/notes/MarkdownEditorPanel.tsx#rawMode': 'source editing of the note open now; its flush path assumes a note opens rendered',
  'components/settings/PluginJobsControls.tsx#view': 'one job\'s log, an overlay',
  'components/settings/sections/ReposSection.tsx#showForm': 'the add-repository form, a dialog',
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
  'components/tasks/ViewDropdown.tsx#section': 'the view menu, a popover',
  'apps/mail/MailAccountFolders.tsx#filter': 'a typed search over one account\'s folders',
  'apps/mail/MailApp.tsx#showMailboxes': 'the mailbox drawer on a narrow window, an overlay',
  'components/board/kanban/useKanbanLayout.ts#mode': 'derived from the board\'s width',
  'components/sessions/SessionMessage.tsx#collapsed': 'one message folded',
  'components/sessions/UserMessagesSummary.tsx#collapsed': 'one summary folded',
  'components/sessions/SessionPanel.tsx#chatCollapsed': 'the chat folded inside the Changed / Files split, an overlay',
  'hooks/useEngineSettings.ts#view': 'the settings the engine sent, not a choice',
  'hooks/useThreadStack.ts#drawerMode': 'the question drawer, an overlay (per tab by spec C69)',
  'hooks/useThreadStack.ts#drawerFilter': 'the question drawer, an overlay (per tab by spec C69)',
  'hooks/useThreadStack.ts#showHidden': 'hidden questions in the drawer, an overlay (per tab by spec C69)',
};

/** The view choices the user named, and where each is kept now. */
const KEPT: ReadonlyArray<{ file: string; state: string; key: RegExp; what: string }> = [
  { file: 'components/org/OrgNodeDetail.tsx', state: 'topPick', key: /usePageViewOf<OrgTopView>\('org', 'node\.top', row\.key,/, what: 'an Org node\'s Task / Brief / Threads view, per node' },
  { file: 'components/org/OrgNodeDetail.tsx', state: 'taskTab', key: /usePageViewOf<OrgRailTab>\('org', 'node\.taskTab', row\.key,/, what: 'the Task view\'s tab, per node' },
  { file: 'components/org/OrgThreads.tsx', state: 'showClosed', key: /usePageView\('org', 'threads\.showClosed'/, what: 'the week\'s closed threads shown' },
  { file: 'pages/AppsPage.tsx', state: 'kept', key: /usePageView<AppsFilter>\('apps', 'filter'/, what: 'the Apps category chip' },
  { file: 'components/board/BoardStatusView.tsx', state: 'filter', key: /usePageViewOf<StatusFilter>\('board', 'statusFilter', ownerId,/, what: 'a board\'s status filter, per board' },
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
  for (const f of files) {
    for (const d of useStates(f.src)) if (VIEW_NAME.test(d.name) && LITERAL.test(d.start)) out.push(`${f.rel}#${d.name}`);
  }
  return out.sort();
}

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
    expect(viewKey('org', 'node.top')).toBe(`${VIEW_PREFIX}org.node.top`);
    expect(syncable(viewKey('org', 'node.top'))).toBe(true);
    expect(syncable(viewKey('board', 'statusFilter'))).toBe(true);
  });
});
