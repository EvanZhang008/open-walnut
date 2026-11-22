/**
 * Guard: a task's status is drawn by ONE component, TaskStateIcon (web/src/components/common/
 * TaskStateIcon.tsx), whose colours and dots live in ONE stylesheet (web/src/styles/task-state.css),
 * and whose state comes from ONE helper (web/src/utils/task-icon-state.ts).
 *
 * 2026-11-21, the user, on a task header that showed an empty ring: "I can't tell if it is working
 * or not started or what. If it is working it should blink." The ring was one of many: a phase
 * glyph helper (binaryPhaseIcon, sectionRowIcon, phaseIcon) drew the same open ring for Working,
 * Needs you and Not started; the board circle classes (task-circle-*) coloured it by whether a
 * session was attached; and a dozen local colour tables (TAB_DOT, TASK_DOT, PHASE_DOT, COLUMN_DOT,
 * the pill, Brief, taskbar, Org and Board dots) disagreed: Working green or blue, Needs you red or
 * orange, Done blue or green, and only some pulsed, without reduced motion.
 *
 * The class, found from the source of every file under web/src:
 *   1. a retired helper or class (the phase glyph helpers, the circle classes, the attention ring);
 *   2. a colour or class table of task states or phases (two or more of needs / read / working /
 *      waiting / done / notstarted, or NEED_ACTION / IN_PROGRESS / ..., bare or quoted keys, mapped to
 *      a colour or a class name) in a .ts or .tsx file, or an inline style whose colour is chosen by
 *      a task state;
 *   3. a CSS rule that styles a status mark from a task state (a `data-user-state` selector, or a
 *      state-named selector, running / in-progress / need-action included, whose rule draws a dot or
 *      animates) outside task-state.css;
 *   4. the old phase glyphs (ICON_PHASE_*, ICON_ATTENTION), phase symbol tables by name, or a table
 *      from states or phases to circle and check characters by content, in a file that is not an
 *      action or a filter listed below.
 *   5. a dot form of the icon: the `dot` prop or the `task-state-dot` class.
 * Each detector is also run on a sample of what it must catch, so a regex that quietly stops
 * matching fails too.
 *
 * 2026-11-22, a review on a copy of the user's data: the Org rail drew a watched Waiting task as a
 * thin grey ring and a Needs you one as a bare red dot, the VP header's chips a green dot and a hollow
 * ring, while the Tasks panel drew the same tasks with a clock and the "!" disc. They passed: they
 * were TaskStateIcon's own 8px `dot` form, which this guard recommended, and whose CSS (a disc, a
 * 1.5px ring, a dashed ring) sat in task-state.css, the one sheet detector 3 skipped. A second,
 * smaller vocabulary inside the blessed component. Detector 3 also missed a state written as a
 * class of its own (`.ext-task-dot.state-needs`, `.mention-dot.waiting`) and a state before the
 * mark's name (`.todo-minibar-running-dot`). Now: the dot form is gone (5); the shared sheet too may
 * draw no state mark as a CSS circle or ring (6): its pill and Brief marks are the icon's shapes as
 * masks (components/common/task-state-shapes.ts); and detector 3 reads those spellings.
 * A new member fails here: draw it with TaskStateIcon (`size={12}` beside small text), or list it
 * below with why it is not a task's status.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '../..');
const WEB_SRC = join(ROOT, 'web/src');
const SHARED_CSS = 'styles/task-state.css';
const COMPONENT = 'components/common/TaskStateIcon.tsx';

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : files(p);
    return /\.(tsx?|css)$/.test(e.name) ? [p] : [];
  });
}

const SOURCES = files(WEB_SRC).map((p) => ({ file: relative(WEB_SRC, p), text: readFileSync(p, 'utf8') }));
const code = SOURCES.filter((s) => /\.tsx?$/.test(s.file));
const css = SOURCES.filter((s) => s.file.endsWith('.css'));

/** Code that maps states to colours for something that is not a task, by file, and why. */
const NOT_TASK_TABLES: Record<string, string> = {
  'components/org/thread-badge.ts': "a Threads card's group dot: a thread, not a task (the Threads team's card)",
  'hooks/useThreadMarks.ts': "a thread mark's state to its class name: a thread, not a task",
};

/** Stylesheet marks that look like a task status but are not one, by the class that names them. */
const NOT_TASK_MARKS: Record<string, string> = {
  'team-tab-dot': "a Claude Code team's tool call (TeamCard), not a Walnut task",
  'wf-task-dot': "a workflow graph's step, not a Walnut task",
  'task-session-pill': "a session's process state (SessionPill), not its task's status",
  'task-session-dot': "a session's process state (SessionPill), not its task's status",
  'stale-build-pill': 'the stale build notice',
  'chat-image-preview': "a picture's upload",
  'top-thread-dot': "the top thread's dot: a thread, not a task",
  'thread-review-card': "a thread review card's state: a thread, not a task",
  'hib-dot': "an inbox letter's read state, not a task",
  'mail-mailbox-fetch': "a mail folder's fetch request in flight, not a task",
  'side-thread-dot': "a side question's session process state (SideQuestionDrawer), not a task",
  'session-search-dot': "a session search row's process state (SessionSearchPanel), not its task's status",
  'rh-needs-dot': 'a remote host that needs a look (HostNeedsLook), not a task',
  'routine-dot': "a routine's health (RoutineRow), not a task",
  'cron-status-dot': "a routine's health (RoutineRow's cron card class), not a task",
  'mail-router-dot': "a mail router's state, not a task",
  'mail-reader-unsub': "an unsubscribe request's state in the mail reader, not a task",
};

/** Files that may use the old phase glyphs: an action or a filter, never a task's own status. */
const GLYPH_ALLOWED: Record<string, string> = {
  'components/common/Icons.tsx': 'defines them',
  'components/tasks/TaskBatchMenu.tsx': "the selection's Complete and Reopen actions",
  'pages/DashboardPage.tsx': "the dashboard's Open and Complete filter chips",
  'components/approvals/ApprovalRow.tsx': 'an approval waiting on the user: a permission request, not a task status',
};

const STATE = '(?:needs|read|working|waiting|snoozed|done|todo|notstarted|not-started)';
/** The phases, as a colour table keyed by phase would name them. */
const PHASE = '(?:NEED_ACTION|IN_PROGRESS|WAITING|COMPLETE|TODO)';
/** The state names a stylesheet may spell, the phases' and the old circle classes' words too. */
const CSS_STATE = '(?:needs|read|working|waiting|snoozed|done|todo|notstarted|not-started|running|in-progress|in_progress|need-action|need_action)';

/** A state or phase as an object key, bare or quoted. */
const KEY = `(?:^|[\\s{,(\\[])['"]?(?:${STATE}|${PHASE})['"]?\\s*:\\s*`;
const COLOUR_VALUE = `['"\`](?:var\\(--|#[0-9a-fA-F]{3,8}\\b|rgba?\\(|hsla?\\(|color-mix\\()`;
/** A class name: lower-case words joined by hyphens (a label has spaces or capitals). */
const CLASS_VALUE = `['"\`][a-z][a-z0-9]*(?:-[a-z0-9]+)+['"\`]`;
/** Circle, half-circle, bullseye, check and hourglass characters, raw or as a \u escape. */
const GLYPH_CHARS = '[\\u25C9-\\u25D5\\u25EF\\u25F4-\\u25F7\\u2299\\u29BF\\u2B24\\u2610\\u2611\\u2713\\u2714\\u231B\\u23F3]';
const GLYPH_ESCAPES = '\\\\u(?:25[CDcd][0-9A-Fa-f]|25[Ee][Ff]|25[Ff][4-7]|2299|29[Bb][Ff]|2[Bb]24|261[01]|271[34]|231[Bb]|23[Ff]3)';
const GLYPH_VALUE = `['"\`][^'"\`\\n]{0,3}(?:${GLYPH_CHARS}|${GLYPH_ESCAPES})`;

const count = (re: string, text: string) => (text.match(new RegExp(re, 'gm')) ?? []).length;

/** Detector 2: a colour or class table of task states (two or more entries in one file). */
function colourTable(text: string): boolean {
  return count(KEY + COLOUR_VALUE, text) >= 2 || count(KEY + CLASS_VALUE, text) >= 2;
}

/** Detector 2b: an inline style whose colour a task state or phase picks, by comparing it to a
 *  state name or by indexing a table with it. */
function stateStyle(text: string): string | null {
  const re = new RegExp(
    `style=\\{\\{[^}]*\\b(?:background|backgroundColor|color|borderColor|fill|stroke)\\s*:\\s*[^,}]*`
    + `(?:===?\\s*['"](?:${STATE}|${PHASE})['"]|\\[\\s*[\\w.]*(?:state|phase|State|Phase|tab|st)\\s*\\])`,
  );
  return text.match(re)?.[0] ?? null;
}

/** Detector 4b: a table from states or phases to circle or check characters (two or more), or a
 *  switch that returns one per state. */
function glyphTable(text: string): boolean {
  const entries = count(KEY + GLYPH_VALUE, text)
    + count(`case\\s+['"](?:${STATE}|${PHASE})['"]\\s*:\\s*return\\s+${GLYPH_VALUE}`, text);
  return entries >= 2;
}

/** A selector keyed by a task state: an attribute, a modifier (`.is-needs`, `.state-needs`, a bare
 *  `.waiting`), a mark's name with the state after it (`-dot-running`) or before it (`-running-dot`). */
const STATE_SEL = new RegExp(
  `\\[data-user-state|\\[data-brief-section|\\[data-(?:state|tab|column|row-mark|phase|status|tone)=['"]?${CSS_STATE}\\b`
  + `|\\.(?:is-|state-|status-)?${CSS_STATE}(?![\\w-])`
  + `|-(?:state|dot|tab|chip|pill|phase|status|circle|ring|led)-${CSS_STATE}\\b`
  + `|-${CSS_STATE}-(?:dot|led|ring|circle)\\b`,
);
const rules = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map((r) => {
  const [sel = '', body = ''] = r.split('{');
  return { sel: sel.trim().replace(/\s+/g, ' '), body };
});
const notTaskMark = (sel: string) => [...sel.matchAll(/\.([a-z][\w-]*)/g)].map((m) => m[1]!)
  .some((n) => Object.keys(NOT_TASK_MARKS).some((k) => n === k || n.startsWith(`${k}-`)));

/** Detector 3: the CSS rules that draw a status mark from a task state, outside the shared sheet. */
function stateMarkRules(text: string): string[] {
  const marks = /border-radius:\s*50%|animation\s*:/;
  const hits: string[] = [];
  for (const { sel, body } of rules(text)) {
    if (!STATE_SEL.test(sel) || notTaskMark(sel)) continue;
    const dotSel = /(dot|led|ring|circle|state-icon)\b/.test(sel);
    if (marks.test(body) || (dotSel && /\b(background|color|border-color)\s*:/.test(body))) hits.push(sel.slice(0, 90));
  }
  return hits;
}

/** Detector 6, every sheet the shared one included: a status mark drawn as a CSS shape (a disc or a
 *  ring) from a task state, instead of the icon's own shape. */
function cssShapeMarks(text: string): string[] {
  const shape = /border-radius:\s*50%|\bborder(?:-top)?:\s*[\d.]+px\s+(?:solid|dashed|dotted)/;
  return rules(text).filter(({ sel, body }) => STATE_SEL.test(sel) && !notTaskMark(sel) && shape.test(body)).map(({ sel }) => sel.slice(0, 90));
}

/** Detector 5: the icon's retired dot form, in code. */
function dotForm(text: string): string | null {
  return text.match(/<TaskStateIcon\b[^>]*?\sdot(?=[\s/>=])|\btask-state-dot\b/)?.[0] ?? null;
}

describe('the detectors catch each kind of member (samples of invented code)', () => {
  it('colour and class tables, bare or quoted keys', () => {
    expect(colourTable("const DOT = { needs: 'var(--error)', done: '#22c55e' };")).toBe(true);
    expect(colourTable("const DOT = { 'needs': '#f00', 'working': '#0f0' };")).toBe(true);
    expect(colourTable('const DOT: Record<string, string> = { "NEED_ACTION": "rgb(1,2,3)", "COMPLETE": "hsl(1 2% 3%)" };')).toBe(true);
    expect(colourTable("const CLS = { needs: 'row-mark-red', working: 'row-mark-green' };")).toBe(true);
    expect(colourTable("const CLS = { 'IN_PROGRESS': 'phase-amber', 'TODO': 'phase-grey' };")).toBe(true);
    // Words and labels are no table of marks.
    expect(colourTable("const WORDS = { needs: 'Needs you', working: 'Working', done: 'Completed' };")).toBe(false);
    expect(colourTable("const ONE = { needs: '#f00' };")).toBe(false);
  });

  it('an inline style chosen by a state', () => {
    expect(stateStyle("<i style={{ background: state === 'needs' ? 'red' : 'grey' }} />")).not.toBeNull();
    expect(stateStyle('<i style={{ color: DOT[task.phase] }} />')).not.toBeNull();
    expect(stateStyle('<i style={{ background: TAB_DOT[st] }} />')).not.toBeNull();
    expect(stateStyle('<i style={{ width: size, color: accent }} />')).toBeNull();
  });

  // The glyphs are written as \u escapes (test data): U+25CB white circle, U+25D0 half circle,
  // U+2713 / U+2714 checks, U+25C9 fisheye, U+25B2 / U+25BC triangles (no status glyph).
  it('glyph tables by content', () => {
    expect(glyphTable("const MARK = { TODO: '\u25CB', IN_PROGRESS: '\u25D0', COMPLETE: '\u2713' };")).toBe(true);
    expect(glyphTable("const MARK = { 'needs': '\u25C9', 'done': '\u2714' };")).toBe(true);
    expect(glyphTable("const MARK = { needs: '\\u25CF', done: '\\u2713' };")).toBe(true);
    expect(glyphTable("switch (p) { case 'TODO': return '\u25CB'; case 'COMPLETE': return '\u2713'; }")).toBe(true);
    expect(glyphTable("const ARROW = { up: '\u25B2', down: '\u25BC' };")).toBe(false);
  });

  it('CSS state names, the phases\' and the old circle classes\' words included', () => {
    for (const sel of [
      '.row-dot-running', '.task-row.is-in-progress .row-dot', '.x-status-in_progress', '.foo-pill-need-action',
      ".row[data-state='needs'] .mark", '.task-phase-working',
    ]) expect(stateMarkRules(`${sel} { border-radius: 50%; background: red; }`), sel).toHaveLength(1);
    expect(stateMarkRules('.row-dot-running { animation: spin 1s; }')).toHaveLength(1);
    expect(stateMarkRules('.row.is-running { padding: 2px; }')).toEqual([]);
    expect(stateMarkRules('.task-session-pill-running { border-radius: 50%; }')).toEqual([]);
  });

  // 2026-11-22: the spellings detector 3 missed, each from a real member it let through.
  it('a state written as a class of its own, or before the mark\'s name', () => {
    for (const sel of [
      '.ext-task-dot.state-needs', '.mention-dot.waiting', '.todo-minibar-running-dot', '.org-row-dot.working',
      '.chip-led.status-needs',
    ]) expect(stateMarkRules(`${sel} { background: var(--error); }`), sel).toHaveLength(1);
    // A word that only starts like a state, and a label's colour, are no mark.
    expect(stateMarkRules('.dot.read-only { background: red; }')).toEqual([]);
    expect(stateMarkRules('.bs-pill-needs { color: var(--error); }')).toEqual([]);
  });

  // The Org rail's and header's marks were exactly these rules, in the shared sheet itself.
  it('a status mark drawn as a CSS disc or ring, in any sheet', () => {
    for (const rule of [
      ".task-state-dot:is([data-state='waiting'], [data-state='snoozed']) { background: transparent; border: 1.5px solid var(--task-state-quiet); }",
      ".task-state-dot[data-state='todo'] { background: transparent; border: 1px dashed var(--task-state-quiet); }",
      'a.task-link[data-user-state]::before { width: 8px; height: 8px; border-radius: 50%; }',
      ".org-brief-body [data-brief-section='waiting']::before { border: 1.5px solid grey; }",
      '.org-watched-item[data-state="needs"] .mark { border-radius: 50%; background: red; }',
    ]) expect(cssShapeMarks(rule), rule).toHaveLength(1);
    // The icon's colours, its breathing centre and a mask-drawn mark are the icon's own.
    expect(cssShapeMarks(".task-state-icon[data-state='needs'] { color: var(--task-state-needs); }")).toEqual([]);
    expect(cssShapeMarks('.task-state-icon .tsi-pulse { border-radius: 50%; background: currentColor; }')).toEqual([]);
    expect(cssShapeMarks("a.task-link[data-user-state='waiting']::before { -webkit-mask-image: var(--tsi-mask-waiting); }")).toEqual([]);
  });

  it('the icon\'s dot form, in code', () => {
    expect(dotForm('<TaskStateIcon state={taskIconState(t)} dot decorative />')).not.toBeNull();
    expect(dotForm('<TaskStateIcon dot state="needs" />')).not.toBeNull();
    expect(dotForm('<TaskStateIcon state={s} dot={true} />')).not.toBeNull();
    expect(dotForm('<i className="task-state-dot" data-state="waiting" />')).not.toBeNull();
    expect(dotForm('<TaskStateIcon state={s} className="session-taskbar-dot" size={12} decorative />')).toBeNull();
  });
});

describe('a task status mark is drawn only by TaskStateIcon', () => {
  it('no file names a retired status helper or class', () => {
    const retired = /\b(binaryPhaseIcon|sectionRowIcon|phaseIcon\s*\(|taskCircleClass|useTaskCircle)\b|task-circle-|task-attention-dot|task-quick-attention|session-panel-attention-dot|org-state-(alert|working|quiet|parked)\b/;
    const hits = SOURCES.filter((s) => retired.test(s.text)).map((s) => `${s.file}: ${s.text.match(retired)![0]}`);
    expect(hits).toEqual([]);
  });

  it('no code file keeps a colour or class table of task states', () => {
    const hits = code
      .filter((s) => s.file !== COMPONENT && !NOT_TASK_TABLES[s.file])
      .filter((s) => colourTable(s.text))
      .map((s) => s.file);
    expect(hits).toEqual([]);
  });

  it('no inline style picks a colour by a task state', () => {
    const hits = code
      .filter((s) => !NOT_TASK_TABLES[s.file])
      .map((s) => [s.file, stateStyle(s.text)] as const)
      .filter(([, hit]) => hit)
      .map(([file, hit]) => `${file}: ${hit!.slice(0, 90)}`);
    expect(hits).toEqual([]);
  });

  it('no stylesheet but the shared one draws a status dot from a task state', () => {
    const hits: string[] = [];
    for (const s of css) {
      if (s.file === SHARED_CSS) continue;
      // Any data-user-state selector at all: the pills' dots are the shared stylesheet's.
      if (/\[data-user-state/.test(s.text)) hits.push(`${s.file}: data-user-state`);
      for (const sel of stateMarkRules(s.text)) hits.push(`${s.file}: ${sel}`);
    }
    expect(hits).toEqual([]);
  });

  it('no code draws the icon\'s retired dot form', () => {
    const hits = code.map((s) => [s.file, dotForm(s.text)] as const).filter(([, hit]) => hit).map(([file, hit]) => `${file}: ${hit}`);
    expect(hits).toEqual([]);
  });

  it('no stylesheet, the shared one included, draws a status mark as a CSS disc or ring', () => {
    const hits = css.flatMap((s) => cssShapeMarks(s.text).map((sel) => `${s.file}: ${sel}`));
    expect(hits).toEqual([]);
  });

  it('the old phase glyphs and symbol tables stay in actions and filters', () => {
    const glyph = /\bICON_(PHASE_[A-Z_]+|ATTENTION)\b|\b(PHASE_SYMBOLS|phaseSymbols|statusSymbols|PHASE_ICON)\b/;
    const hits = code.filter((s) => !GLYPH_ALLOWED[s.file] && glyph.test(s.text)).map((s) => `${s.file}: ${s.text.match(glyph)![0]}`);
    expect(hits).toEqual([]);
  });

  it('no table draws a state or phase as a circle or check character', () => {
    const hits = code.filter((s) => !GLYPH_ALLOWED[s.file] && glyphTable(s.text)).map((s) => s.file);
    expect(hits).toEqual([]);
  });

  it('every listed exception still exists, so the lists only shrink', () => {
    const known = new Set(SOURCES.map((s) => s.file));
    expect(Object.keys({ ...NOT_TASK_TABLES, ...GLYPH_ALLOWED }).filter((f) => !known.has(f))).toEqual([]);
    const sheets = css.map((s) => s.text).join('\n');
    expect(Object.keys(NOT_TASK_MARKS).filter((k) => !sheets.includes(`.${k}`))).toEqual([]);
  });

  it('the surfaces that draw a task status draw TaskStateIcon', () => {
    const users = code.filter((s) => s.file !== COMPONENT && /<TaskStateIcon\b/.test(s.text)).map((s) => s.file);
    // Home rows, the task table, the session header, Focus cards, subtask and leader pills, search
    // rows, the Org pages, the Board, the taskbar, the Ask drawer, badges and status menus.
    expect(users.length).toBeGreaterThanOrEqual(25);
    for (const f of [
      'components/tasks/StatusSections.tsx', 'components/tasks/TodoPanel.tsx', 'components/tasks/TasksPageTable.tsx',
      'components/sessions/TaskQuickActions.tsx', 'components/tasks/TaskStatusControl.tsx', 'components/tasks/FocusSatelliteCards.tsx',
      'components/tasks/SubtaskPill.tsx', 'components/tasks/LeaderPill.tsx', 'components/tasks/AgentSearchResultRows.tsx',
      'components/org/OrgChartProject.tsx', 'components/org/OrgTaskRail.tsx', 'components/org/OrgAvatar.tsx',
      'components/board/BoardStatusView.tsx', 'components/common/StatusBadge.tsx', 'components/sessions/SessionTaskbar.tsx',
      // 2026-11-22: the Org rail's kept rows, the VP header's task chips, a thread's task chips, Home's
      // Running count, the "@" palette's rows and the extension panel's task rows.
      'components/org/OrgChannelList.tsx', 'components/org/OrgNodeDetail.tsx', 'components/org/ThreadTaskChips.tsx',
      'components/tasks/TodoProjectsMiniBar.tsx', 'components/chat/MentionPalette.tsx', 'popout/PopoutExtTasks.tsx',
    ]) expect(users, f).toContain(f);
  });
});

describe('the shared component and stylesheet', () => {
  const sheet = readFileSync(join(WEB_SRC, SHARED_CSS), 'utf8');
  const component = readFileSync(join(WEB_SRC, COMPONENT), 'utf8');

  it('Working breathes in CSS alone, and stays still under reduced motion', () => {
    expect(component).not.toMatch(/setInterval|setTimeout|requestAnimationFrame/);
    expect(sheet).toMatch(/@keyframes task-state-breathe\s*\{\s*0%, 100% \{ opacity: 1; \}\s*50% \{ opacity: 0\.7; \}/);
    expect(sheet).toMatch(/animation: task-state-breathe 2s ease-in-out infinite;/);
    const reduced = sheet.slice(sheet.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.tsi-pulse[\s\S]*animation: none;/);
    expect(reduced).toMatch(/a\.task-link\[data-user-state='working'\]::before[\s\S]*animation: none;/);
  });

  it('uses the status tokens only: Needs you is --error, Working --success, To read --warning', () => {
    expect(sheet).toMatch(/--task-state-needs: var\(--error\);/);
    expect(sheet).toMatch(/--task-state-working: color-mix\(in srgb, var\(--success\) 80%, black\);/);
    expect(sheet).toMatch(/--task-state-read: color-mix\(in srgb, var\(--warning\) 80%, black\);/);
    expect(sheet).toMatch(/--task-state-quiet: var\(--fg-muted\);/);
    // No raw colour at all: the white mark on Needs you is --on-accent.
    expect(sheet.replace(/\/\*[\s\S]*?\*\//g, '').match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
    expect(sheet).toMatch(/\.tsi-mark \{ fill: var\(--on-accent\); \}/);
  });

  it('the light theme reaches 3:1 for green and amber on white; the dark theme draws the tokens', () => {
    const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const lum = ([r, g, b]: number[]) => 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
    const onWhite = (rgb: number[]) => 1.05 / (lum(rgb) + 0.05);
    const tokens = readFileSync(join(WEB_SRC, 'styles/globals.css'), 'utf8');
    const hex = (name: string) => {
      const h = tokens.match(new RegExp(`--${name}:\\s*#([0-9A-Fa-f]{6})`))![1]!;
      return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    };
    for (const name of ['success', 'warning']) {
      expect(onWhite(hex(name)), `${name} as is`).toBeLessThan(3);
      expect(onWhite(hex(name).map((c) => c * 0.8)), `${name} at 80% with black`).toBeGreaterThanOrEqual(3);
    }
    for (const name of ['error', 'fg-muted']) expect(onWhite(hex(name)), name).toBeGreaterThanOrEqual(3);
    expect(sheet).toMatch(/:root\[data-theme="dark"\] \{\s*--task-state-read: var\(--warning\);\s*--task-state-working: var\(--success\);/);
  });

  it('every pill state and Brief heading wears its icon\'s own shape (a mask), never a dot', () => {
    const rule = (sel: string) => {
      const at = sheet.indexOf(sel);
      return at < 0 ? '' : sheet.slice(sheet.indexOf('{', at), sheet.indexOf('}', at));
    };
    for (const s of ['needs', 'read', 'working', 'waiting', 'done']) {
      expect(rule(`a.task-link[data-user-state='${s}']::before`), s).toContain(`mask-image: var(--tsi-mask-${s});`);
    }
    for (const s of ['needs', 'working', 'waiting']) expect(sheet, s).toContain(`.org-brief-body [data-brief-section='${s}']::before`);
    expect(sheet).not.toMatch(/task-state-dot/);
    // The masks are put on the page before the first render.
    expect(readFileSync(join(WEB_SRC, 'main.tsx'), 'utf8')).toMatch(/\ninstallTaskStateMasks\(\);/);
  });
});

// A routine is not a task, so its dot is its own; but its two quiet states must still read apart
// (the audit: "Off" and "Paused" drew the same hollow ring).
describe('the Routines dot tells Paused from Off', () => {
  it('the row names which one, and each has its own shape', () => {
    const row = readFileSync(join(WEB_SRC, 'components/routines/RoutineRow.tsx'), 'utf8');
    expect(row).toMatch(/data-off=\{health === 'off' \? offLabel\(routine\)\.toLowerCase\(\) : undefined\}/);
    const css = readFileSync(join(WEB_SRC, 'styles/routines-groups.css'), 'utf8');
    const rule = (sel: string) => css.match(new RegExp(`${sel.replace(/[.[\]"]/g, (c) => `\\${c}`)} \\{([^}]*)\\}`))?.[1] ?? '';
    const paused = rule('.routine-dot.off[data-off="paused"]');
    const off = rule('.routine-dot.off[data-off="off"]');
    expect(paused).toMatch(/linear-gradient/);
    expect(off).toMatch(/border: 1px dashed var\(--fg-muted\)/);
    expect(paused).not.toEqual(off);
  });
});

describe('a caller\'s own class places the icon', () => {
  // 2026-11-22, UI audit: `.task-state-icon { position: relative }` loaded after org-page.css and beat
  // `.org-state-dot { position: absolute }`, so the avatar's corner icon sat between the picture and
  // the name. The icon's box rules weigh nothing (:where), so any class a caller passes wins.
  const BOX = /(?:^|;)\s*(?:position|display|flex|vertical-align|margin|inset|top|left|right|bottom)\s*:/;
  it('no rule of the bare icon sets its box at class weight', () => {
    const css = readFileSync(join(WEB_SRC, SHARED_CSS), 'utf8');
    const heavy = rules(css).filter((r) => r.sel.split(',').some((s) => s.trim() === '.task-state-icon') && BOX.test(r.body)).map((r) => r.sel);
    expect(heavy, 'wrap the icon\'s own box rules in :where(.task-state-icon)').toEqual([]);
    expect(css).toMatch(/:where\(\.task-state-icon\)\s*\{[^}]*position:\s*relative/);
  });
});
