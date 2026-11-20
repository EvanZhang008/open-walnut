/**
 * Every composer with a mic sends through useSendAfterDictation.
 *
 * 2026-11-01, the user: "currently send doesn't wait the voice button I think
 * it should wait, and send afterward". A send pressed while the mic was still
 * recording sent the text as it stood and threw the rest of the words away.
 * Now Send stops the recording, waits for the final words and sends once
 * (web/src/hooks/useSendAfterDictation.ts). This test lists every file that
 * draws a mic and fails when one of them has a mic its send does not wait on,
 * so a new composer cannot skip the rule.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { micInputsOf, declaredFunctions, submitNames, directSubmits, pressHandlers, gateNames } from './mic-input-scan';

const ROOT = join(__dirname, '../../web/src');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}
const files = sources(ROOT).map((p) => ({ rel: relative(ROOT, p), text: readFileSync(p, 'utf8') }));

/** The mic components themselves: they hand their owner the handle the gate waits on. */
const MIC_COMPONENTS = new Set([
  'components/common/MicButton.tsx',
  'components/common/BoxMic.tsx',
  'components/common/EditorMic.tsx',
  'components/common/AnswerBox.tsx',
  'plugins/views.tsx',
]);

/**
 * Files with a mic whose words are never sent by a press: each says why, how many mics it has (a new
 * mic in the file is a new box to judge, so the count fails it), and markers in the file that show
 * where the words are saved instead. A file with a send of its own does not belong here.
 */
const NO_SEND: Record<string, { mics: number; markers: string[]; why: string }> = {
  'components/sessions/SessionNotes.tsx': {
    mics: 1,
    markers: ['onTranscribe={(text) => handleChange(', 'debounceRef.current = setTimeout(() => saveNote(value), 1000)'],
    why: 'the session note autosaves a second after every change; the mic appends to it and nothing submits the words',
  },
  'components/notes/NotesEditor.tsx': {
    mics: 1,
    markers: ['<EditorMic editor={editor} />', 'onDirty(editor);'],
    why: 'the editor autosaves through onDirty on every change; none of its hosts has a submit action for dictated words',
  },
};

/** A direct use of a gated function that is meant to skip the wait, each with why. */
const DIRECT_OK: Record<string, { near: string; why: string }> = {
  commitNote: {
    near: 'onBlur={commitNote}',
    why: 'leaving the host note box saves what it holds (an autosave); the final words are saved by the next blur or Enter',
  },
};

const MIC_TAG = /<(MicButton|BoxMic|MicField|EditorMic|AnswerBox|MicInput)\b/g;

/** The JSX element starting at `start` (`<Tag ... >` or `/>`), braces respected. */
function elementAt(text: string, start: number): string {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

/** The ref a mic element hands its handle to, or null when it hands none. */
function micRefOf(el: string): string | null {
  // A dynamic routine field joins the one dictation group the form's Save waits on.
  if (/\bmicRef=\{fieldMicOf\(f\.name\)\}/.test(el)) return 'fieldMic';
  const m = el.match(/\b(?:controlRef|handleRef|micRef)=\{\s*([A-Za-z_$][\w$.]*)\s*\}/);
  return m ? m[1] : null;
}

/** Every ref named inside a `useSendAfterDictation([...]` array in the file. */
function gatedRefs(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/useSendAfterDictation\(\s*\[([^\]]*)\]/g)) {
    for (const name of m[1].split(',').map((s) => s.trim()).filter(Boolean)) out.add(name);
  }
  return out;
}

/** The argument list of the call whose `(` is at `open`. */
function callArgs(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/**
 * Functions a gate runs that the file also calls or binds outside a gate: a
 * submit path that skips the wait. (`useCallback` and the gate's own call are
 * not uses; a name that is only defined and handed to the gate is fine.)
 */
function bypasses(text: string): string[] {
  const out: string[] = [];
  const gateSpans: Array<[number, number]> = [];
  const names = new Set<string>();
  for (const m of text.matchAll(/useSendAfterDictation\(/g)) {
    const open = m.index! + m[0].length - 1;
    const args = callArgs(text, open);
    gateSpans.push([open, open + args.length + 1]);
    const sendArg = args.slice(args.indexOf(']') + 1).replace(/^\s*,/, '').replace(/,\s*[\w$.]+\s*$/, '').trim();
    // The send is a function name, or an arrow that only calls one: `() => void submit()`.
    const named = sendArg.match(/^([A-Za-z_$][\w$]*)$/)
      ?? sendArg.match(/^\(\)\s*=>\s*\{?\s*(?:void\s+)?([A-Za-z_$][\w$]*)\([^()]*\)\s*;?\s*\}?$/);
    if (named) names.add(named[1]);
  }
  const inGate = (i: number) => gateSpans.some(([a, b]) => i >= a && i <= b);
  for (const name of names) {
    const esc = name.replace(/\$/g, '\\$');
    const use = new RegExp(`(?:=\\{\\s*${esc}\\s*\\}|(?<![\\w$.])${esc}\\s*\\()`, 'g');
    for (const u of text.matchAll(use)) {
      const at = u.index!;
      if (inGate(at)) continue;
      if (DIRECT_OK[`${name}`] && text.slice(Math.max(0, at - 40), at + 40).includes(DIRECT_OK[name].near)) continue;
      const before = text.slice(Math.max(0, at - 16), at);
      if (/(function|const|let)\s+$/.test(before) || /function\s*$/.test(before)) continue;
      out.push(`${name} at offset ${at}: ${text.slice(at, at + 40).replace(/\s+/g, ' ')}`);
    }
  }
  return out;
}

const owners = files.filter((f) => !MIC_COMPONENTS.has(f.rel) && /<(MicButton|BoxMic|MicField|EditorMic|AnswerBox|MicInput)\b/.test(f.text));

describe('send waits for the dictation in every composer with a mic', () => {
  it('finds the composers (the scan is alive)', () => {
    expect(owners.length).toBeGreaterThan(20);
    expect(owners.map((f) => f.rel)).toContain('components/chat/ChatInput.tsx');
  });

  it('AnswerBox and the plugin mic route their own send through the gate', () => {
    const answer = files.find((f) => f.rel === 'components/common/AnswerBox.tsx')!.text;
    expect(answer).toMatch(/useSendAfterDictation\(\s*\[\s*mic\s*\]/);
    const api = readFileSync(join(__dirname, '../../packages/plugin-api/src/web.ts'), 'utf8');
    expect(api).toMatch(/finish\?\(\): Promise<\{ error: string \| null \}>/);
  });

  for (const f of owners) {
    it(`${f.rel}: every mic is waited on by its send`, () => {
      const quiet = NO_SEND[f.rel];
      if (quiet) {
        expect(f.text, `${f.rel} is listed as having no send but routes one through the gate`).not.toMatch(/useSendAfterDictation\(/);
        expect([...f.text.matchAll(MIC_TAG)].length, `${f.rel}: a new mic in a NO_SEND file is a new box: judge it`).toBe(quiet.mics);
        for (const m of quiet.markers) expect(f.text, `${f.rel}: marker ${m}`).toContain(m);
        return;
      }
      const gated = gatedRefs(f.text);
      const problems: string[] = [];
      for (const m of f.text.matchAll(MIC_TAG)) {
        const el = elementAt(f.text, m.index!);
        const ref = micRefOf(el);
        // An AnswerBox that owns the send (onSubmit: its button and Enter) waits on its own mic.
        if (m[1] === 'AnswerBox' && /\bonSubmit=/.test(el)) continue;
        // A MicInput that keeps its mic (no micRef) is judged one by one, by its role, in
        // 'every MicInput without micRef has a role' below; one that hands its owner the mic must
        // be in that owner's gate, as every other mic here.
        if (m[1] === 'MicInput' && !/\bmicRef=/.test(el)) continue;
        if (!ref) { problems.push(`<${m[1]}> hands its owner no handle (controlRef/handleRef/micRef)`); continue; }
        if (!gated.has(ref)) problems.push(`<${m[1]}> ${ref} is in no useSendAfterDictation([...]) of this file`);
      }
      expect(problems, `${f.rel}: a send here must wait for its mic (or list the file in NO_SEND with why)`).toEqual([]);
      expect(bypasses(f.text), `${f.rel}: a function a gate runs is also called directly, so that path does not wait`).toEqual([]);
    });
  }
});

/**
 * A MicInput that keeps its own mic (no micRef) submits its words only through its own Enter, its
 * own blur, or not at all. Each one is named here by its key (tests/web/mic-input-scan.ts) with that
 * role, so a new one fails until it is judged, and a button or form that submits its words directly
 * (an external Save, Add, Create) fails: that box must hand its mic to the button's gate (micRef).
 */
type Role = { role: 'filter' | 'enter' | 'leave'; why: string; submits?: string[] };
const FILTER: Role = { role: 'filter', why: 'a live filter or picker: the words narrow a list as they come and Enter at most picks a shown row; nothing sends them' };
const OWN_ENTER: Role = { role: 'enter', why: 'its only submit is its own Enter (onEnter), which waits for words still being dictated' };
const LEAVE: Role = { role: 'leave', why: 'saves or closes when the box is left (and on its Enter): the MicInput blur and Enter lifecycle (components/common/BoxMic.tsx) owns the wait' };

const SELF_GATED: Record<string, Role> = {
  // The quick bar's people list: the words narrow it; Enter picks the row the list highlights.
  'components/quickbar/QuickBarPicker.tsx|MicInput data-testid="qb-picker-search"': FILTER,
  'apps/mail/MailMessageList.tsx|MicInput data-testid="mail-search-input"': {
    ...FILTER,
    submits: ['onSubmit={(event) => { event.preventDefault(); void runMailSearch(draft); }}'],
    why: 'a mail search: the form has no submit button, so only the box\'s Enter runs it, and the MicInput holds an Enter while its words are coming',
  },
  'components/board/kanban/KanbanFilters.tsx|MicInput data-testid="kanban-search"': FILTER,
  'components/board/kanban/KanbanLaneHead.tsx|MicInput data-testid="kanban-lane-rename-input"': LEAVE,
  'components/calendar/CalendarTaskList.tsx|MicInput placeholder="Filter…"': FILTER,
  'components/chat/AskWalnutDrawer.tsx|MicInput data-testid="ask-walnut-search"': FILTER,
  // A drawing's name (the title, a list row): Enter or leaving the box renames it, Escape keeps the old name.
  'components/drawing/DrawingWorkspace.tsx|MicInput aria-label=label': LEAVE,
  // The library catalog's search narrows the list of libraries as the words come; nothing sends them.
  'components/drawing/LibraryBrowser.tsx|MicInput aria-label="Search libraries"': FILTER,
  'components/inbox/ItemTaskSelector.tsx|MicInput id=searchId': FILTER,
  'components/notes/CommandPalette.tsx|MicInput placeholder="Jump to a note, or type to search…"': FILTER,
  'components/notes/NotesTreePanel.tsx|MicInput className="notes-tree-inline-input"': LEAVE,
  'components/notes/NotesTreePanel.tsx|MicInput className="notes-tree-inline-input"#2': LEAVE,
  'components/notes/NotesTreePanel.tsx|MicInput placeholder="folder name"': LEAVE,
  'components/notes/NotesTreePanel.tsx|MicInput aria-label="Search notes"': FILTER,
  'components/notes/slash-commands/NoteLinkPanel.tsx|MicInput placeholder="Link to note..."': FILTER,
  'components/notes/slash-commands/TaskSearchPanel.tsx|MicInput placeholder="Search tasks..."': FILTER,
  'components/org/OrgChannelList.tsx|MicInput data-testid="org-search"': FILTER,
  'components/org/OrgEditableName.tsx|MicInput data-testid=`${testId}-input`': OWN_ENTER,
  // A New Director's title: only its own Enter makes the task; leaving it empty closes it, sending nothing.
  'components/org/OrgNewDirector.tsx|MicInput data-testid="org-new-director-input"': OWN_ENTER,
  'components/org/OrgRouterSettings.tsx|MicInput data-testid="org-router-link-filter"': FILTER,
  'components/org/OrgRouterSetup.tsx|MicInput data-testid="router-setup-vp-filter"': FILTER,
  'components/org/RouterFolderPicker.tsx|MicInput data-testid=`${testId}-filter`': FILTER,
  'components/routines/RoutineTaskField.tsx|MicInput id=id': FILTER,
  'components/sessions/EditableSessionTitle.tsx|MicInput className="session-panel-title-input"': LEAVE,
  'components/sessions/SessionSearchPanel.tsx|MicInput aria-label="Search sessions"': FILTER,
  'components/sessions/ThreadInlineRename.tsx|MicInput aria-label=ariaLabel': OWN_ENTER,
  'components/sessions/ThreadTreeDrawer.tsx|MicInput aria-label="Search questions and pins"': FILTER,
  'components/settings/SettingsNav.tsx|MicInput data-testid="settings-filter"': FILTER,
  'components/settings/sections/FocusTiersSection.tsx|MicInput aria-label=`Rename ${t.label}`': LEAVE,
  'components/settings/sections/GeneralSection.tsx|MicInput id="settings-name"': LEAVE,
  'components/settings/sections/SessionsSection.tsx|MicInput data-testid="session-reply-language"': LEAVE,
  'components/settings/sections/TasksSection.tsx|MicInput id="settings-project"': LEAVE,
  'components/settings/sections/TriageRoutingRules.tsx|MicInput data-testid="triage-rule-task-search"': FILTER,
  'components/tasks/AdoptWorkerFlyout.tsx|MicInput aria-label="Filter tasks"': FILTER,
  'components/tasks/FilterChipMenu.tsx|MicInput aria-label=`Search ${searchWord(dim)}`': FILTER,
  'components/tasks/FilterMenu.tsx|MicInput aria-label="Search filters"': FILTER,
  'components/tasks/HomeBoardSheet.tsx|MicInput aria-label="Search board tasks"': FILTER,
  'components/tasks/PhoneSearchLayer.tsx|MicInput aria-label="Search tasks, sessions and notes"': FILTER,
  'components/tasks/ReleaseWorkerFlyout.tsx|MicInput aria-label="Filter workers"': FILTER,
  'components/tasks/TaskDetailEdits.tsx|MicInput placeholder="Search tasks to depend on..."': FILTER,
  'components/tasks/TaskKebabMenu.tsx|MicInput placeholder="Filter projects…"': FILTER,
  'components/tasks/TaskViewSurface.tsx|MicInput aria-label="Filter Plugin tasks"': FILTER,
  'components/tasks/TasksPageRail.tsx|MicInput placeholder="Project name…"': OWN_ENTER,
  'components/tasks/TasksPageTable.tsx|MicInput placeholder="Filter projects…"': FILTER,
  'components/tasks/TierSeparatorRow.tsx|MicInput placeholder="Heading…"': {
    ...LEAVE,
    submits: ['onSubmit={commit}'],
    why: 'a heading rename that saves when left; its form has no submit button, so only the box\'s Enter submits it, and the MicInput holds an Enter while its words are coming',
  },
  'components/tasks/TodoPanel.tsx|MicInput aria-label="New project name"': OWN_ENTER,
  "components/tasks/TodoSearchBar.tsx|MicInput placeholder=phone ? 'Search' : 'Search tasks... \\u2318K'": FILTER,
  'components/tasks/ViewDropdown.tsx|MicInput aria-label="Search filters"': FILTER,
  'pages/AppsPage.tsx|MicInput data-testid="apps-search"': FILTER,
  'pages/DashboardPage.tsx|MicInput placeholder="Search tasks…"': FILTER,
};

/** What submits a MicInput's words from outside the box: buttons and forms that run its submit or read its value. */
function externalSubmits(text: string, attrs: Map<string, string>): string[] {
  const declared = declaredFunctions(text);
  const out = new Set<string>();
  for (const name of ['onEnter', 'onBlur'].flatMap((a) => submitNames(attrs.get(a) ?? '', declared))) {
    for (const d of directSubmits(text, name)) out.add(d);
  }
  const value = attrs.get('value');
  if (value && /^[\w$.]+$/.test(value)) {
    const read = new RegExp(`(?<![\\w$.])${value.replace(/[.$]/g, '\\$&')}(?![\\w$])`);
    for (const h of pressHandlers(text)) if (read.test(h.value)) out.add(`${h.attr}={${h.value}}`);
  }
  return [...out];
}

/** Problems with one MicInput, given its file's text and its listed role (undefined: not listed). */
function micInputProblems(text: string, use: { key: string; attrs: Map<string, string>; spreads: string[] }, listed: Role | undefined): string[] {
  const { attrs } = use;
  const gates = gateNames(text);
  const handlers = ['onEnter', 'onKeyDown', 'onBlur'].map((a) => attrs.get(a) ?? '').join(' ');
  const feedsGate = [...gates].filter((g) => new RegExp(`(?<![\\w$])${g}\\.send\\b`).test(handlers));
  if (attrs.has('micRef')) return [];
  const out: string[] = [];
  if (feedsGate.length) out.push(`its keys run ${feedsGate.join(', ')}.send, a gate that does not hold this box's mic: hand it the mic (micRef)`);
  if (!listed) {
    out.push('a MicInput without micRef that is not judged: hand its mic to the gate of what submits it (micRef), or list its role in SELF_GATED');
    return out;
  }
  const hookProps = use.spreads.some((s) => s.endsWith('.micInputProps'));
  if (listed.role === 'filter' && (attrs.has('onEnter') || hookProps)) out.push('listed as a filter but it submits its words (onEnter)');
  if (listed.role === 'enter' && !attrs.has('onEnter')) out.push('listed as submitting on its own Enter but has no onEnter');
  if (listed.role === 'leave' && !attrs.has('onBlur') && !hookProps) out.push('listed as saving when left but has no onBlur');
  const ext = externalSubmits(text, attrs).filter((e) => !(listed.submits ?? []).includes(e));
  for (const e of ext) out.push(`submitted from outside the box by ${e}: hand its mic to that press's gate (micRef)`);
  return out;
}

describe('every MicInput without micRef has a role, and nothing outside it submits its words', () => {
  const uses = files.filter((f) => f.rel.endsWith('.tsx')).flatMap((f) => micInputsOf(f.rel, f.text).map((u) => ({ ...u, text: f.text })));

  it('finds the MicInputs (the scan is alive)', () => {
    expect(uses.length).toBeGreaterThan(50);
    expect(uses.filter((u) => u.attrs.has('micRef')).length).toBeGreaterThan(10);
  });

  it('judges each one', () => {
    const problems = uses.flatMap((u) => micInputProblems(u.text, u, SELF_GATED[u.key]).map((p) => `${u.key} (line ${u.line}): ${p}`));
    expect(problems).toEqual([]);
  });

  it('keeps every entry current: it names a MicInput that exists and still keeps its mic', () => {
    const byKey = new Map(uses.map((u) => [u.key, u]));
    const stale = Object.keys(SELF_GATED).filter((k) => !byKey.has(k) || byKey.get(k)!.attrs.has('micRef'));
    expect(stale).toEqual([]);
  });

  it('fails a box whose words an outside Save, a caller gate or an unjudged new box submits', () => {
    const src = `
      function Form() {
        const gate = useSendAfterDictation([noteMic], () => void saveNow());
        const saveNow = async () => { await save(name); };
        const addNow = () => { add(title); };
        return <>
          <MicInput data-testid="name" value={name} setText={setName} onEnter={gate.send} />
          <MicInput data-testid="title" value={title} setText={setTitle} onEnter={addNow} />
          <button onClick={addNow}>Add</button>
          <MicInput data-testid="filter" value={query} setText={setQuery} />
          <button onClick={() => void search(query)}>Search</button>
          <MicInput data-testid="wired" value={x} setText={setX} micRef={xMic} />
        </>;
      }`;
    const found = micInputsOf('New.tsx', src);
    const judge = (testid: string, role?: Role) => micInputProblems(src, found.find((u) => u.key.includes(`"${testid}"`))!, role);
    expect(judge('name', OWN_ENTER).join('\n')).toMatch(/gate\.send, a gate that does not hold this box's mic/);
    expect(judge('title', OWN_ENTER).join('\n')).toMatch(/onClick=\{addNow\}/);
    expect(judge('filter', FILTER).join('\n')).toMatch(/onClick=\{\(\) => void search\(query\)\}/);
    expect(judge('filter').join('\n')).toMatch(/not judged/);
    expect(judge('wired')).toEqual([]);
  });
});
