/**
 * Guard: a click on a task reference has ONE action, wherever the reference is drawn.
 *
 * 2026-11-13, the user: "why I clcik the taskroute to it jump this task detail I want it direct
 * to go task, can we make sure it is coded like this we find so many same issue, We want to clcik
 * go to taht sesison in home that is it"; then "in this task detail I clcik the session, the panle
 * shoujdl be gone and jump to that task directly". The same chip opened a second details popup in
 * a task's details, an Org side panel on the Org page, a column beside the Board, a preview in a
 * full-screen session. The class: a task-open callback threaded through props (`onTaskClick`,
 * `onOpenTask`, `onFocusChild`, `onOpenTaskId`, `chatTaskClick`, ...). Whoever hosted a surface
 * passed its own action down, and every new host was a new chance to pick a different one.
 *
 * Every member now calls the function `useOpenTask()` returns (web/src/hooks/useOpenTask.ts), which
 * is `openTaskOnHome` (web/src/utils/open-session.ts): Home, the task's session open, every details
 * popup closed. This test reads every web/src source file with the TypeScript parser and fails on:
 *   1. a name of the callback family anywhere (a prop, a parameter, a property, a variable);
 *   2. a task pill (`className` with `task-link`) whose own onClick opens something else;
 *   3. a TaskOpenerContext provider outside web/src/popout/ (windows that have no Home);
 *   4. useEntityClickHandler taking a task callback again;
 *   5. a Find on Home (`locateTaskOnHome`) or a raw `main:locate-task` outside the places listed
 *      with why: either one is how a click goes around the one action.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = join(__dirname, '../..');
const WEB_SRC = join(ROOT, 'web/src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

const FILES = sourceFiles(WEB_SRC).map((abs) => {
  const rel = relative(WEB_SRC, abs);
  const text = readFileSync(abs, 'utf8');
  const source = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, abs.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  return { rel, text, source };
});

/** The browser extension's panel is not the app and has no Home: it opens a task in its own frame.
 *  The other pop-outs (a session, a note) are app views and keep the rule. */
const NON_APP_WINDOW = /^popout\/(Ext\w*|PopoutExt\w*|ext-[\w-]+)\.tsx?$/;
/** The plugin API's TaskView props (packages/plugin-api/src/web.ts): a deprecated field kept so older plugins
 *  compile, and the one place that drops it (views.tsx). It is never called. */
const PLUGIN_CONTRACT = /^plugins\/(types\.ts|views\.tsx)$/;

const OPEN_VERB = '(?:Open|Click|Focus|Select|Show|Go|Jump|Navigate|Visit|View|Pick|Tap|Press|Phone\\w*)';
const FAMILY = [
  new RegExp(`^on${OPEN_VERB}\\w*(?:Task|Child|Linked)(?:Id|ById|Ref|Chip|Link|Row)?$`),
  /^on(?:Task|Child|Linked)(?:Ref|Chip|Row)?(?:Click|Open|Press|Tap|Select|Pick)$/,
  /TaskClick$/,
];
/** Names the pattern catches that are not a task-ref click, each with why. */
const NOT_A_REF: Record<string, string> = {
  onOpenTaskDetail: 'a "Details" menu item: asks for the details popup by name',
  onFocusTask: "Home's own task list hands its row press to Home: the list is the place, not a reference to it",
  onOpenTriageForTask: "the details popup's Triage history link: opens the triage panel, not a task",
};
export const isTaskOpenCallback = (name: string): boolean => !(name in NOT_A_REF) && FAMILY.some((re) => re.test(name));

type Hit = { file: string; line: number; what: string };
const at = (f: (typeof FILES)[number], node: ts.Node) => f.source.getLineAndCharacterOfPosition(node.getStart(f.source)).line + 1;

function declaredNames(f: (typeof FILES)[number]): Hit[] {
  const hits: Hit[] = [];
  const name = (n: ts.Node | undefined): string | null =>
    n && (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isPrivateIdentifier(n)) ? n.text : null;
  const visit = (node: ts.Node): void => {
    let n: string | null = null;
    if (ts.isJsxAttribute(node)) n = name(node.name as ts.Node);
    else if (ts.isPropertySignature(node) || ts.isMethodSignature(node) || ts.isPropertyAssignment(node)
      || ts.isShorthandPropertyAssignment(node) || ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) n = name(node.name);
    else if (ts.isBindingElement(node)) n = name(node.propertyName ?? node.name);
    else if (ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) n = name(node.name);
    if (n && isTaskOpenCallback(n)) hits.push({ file: f.rel, line: at(f, node), what: n });
    ts.forEachChild(node, visit);
  };
  visit(f.source);
  return hits;
}

/** Names this file binds to the one action: `const x = useOpenTask()`, or openTaskOnHome itself. */
function openers(f: (typeof FILES)[number]): Set<string> {
  const out = new Set<string>(['openTaskOnHome']);
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(f.source) === 'useOpenTask') {
      out.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(f.source);
  return out;
}

function pillsWithOwnClick(f: (typeof FILES)[number]): Hit[] {
  const hits: Hit[] = [];
  const open = openers(f);
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
      const cls = attrs.find((a) => a.name.getText(f.source) === 'className');
      const click = attrs.find((a) => a.name.getText(f.source) === 'onClick');
      const isPill = !!cls?.initializer && /(^|[\s'"`])task-link([\s'"`]|$)/.test(cls.initializer.getText(f.source));
      if (isPill && click?.initializer) {
        let body = click.initializer.getText(f.source);
        // `onClick={handler}`: read the handler this file declares under that name.
        const bare = /^\{\s*([A-Za-z_$][\w$]*)\s*\}$/.exec(body)?.[1];
        if (bare) body = localDeclaration(f, bare) ?? `${bare}()`;
        const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'typeof', 'catch', 'function']);
        const calls = [...body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]!).filter((c) => !KEYWORDS.has(c));
        // Only the event's own housekeeping, or the one action.
        const HOUSEKEEPING = new Set(['preventDefault', 'stopPropagation', 'claimAgentLinkClick', 'recordTaskOpened']);
        const ok = calls.every((c) => HOUSEKEEPING.has(c) || open.has(c));
        if (!ok) hits.push({ file: f.rel, line: at(f, node), what: `task pill onClick: ${body.replace(/\s+/g, ' ').slice(0, 100)}` });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(f.source);
  return hits;
}

/** The initializer (or body) of `const name = ...` / `function name` in the file, else null. */
function localDeclaration(f: (typeof FILES)[number], name: string): string | null {
  let out: string | null = null;
  const visit = (node: ts.Node): void => {
    if (out) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) out = node.initializer.getText(f.source);
    else if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body) out = node.body.getText(f.source);
    else ts.forEachChild(node, visit);
  };
  visit(f.source);
  return out;
}

/** Each place a Find on Home is not a task-ref click, with why. */
const LOCATES: Record<string, string> = {
  'components/sessions/SessionPanel.tsx': "the panel's own Locate (kebab): finds its task, a host's onLocateTask first",
  'components/org/OrgSidePanel.tsx': "the Org side panel's Find on Home button and its session's Locate",
  'components/transfer/TransferDialogHost.tsx': 'after a transfer: shows the task it made, no click on a reference',
  'components/chat/AskObjectDrawer.tsx': "a toast's Find on Home, after an ask became a task",
};
/** Where the event itself is spoken: its sender, Home (its listener), the hook layers yield with, and the Waiting card that closes on it. */
const LOCATE_EVENT = new Set(['utils/open-session.ts', 'pages/MainPage.tsx', 'hooks/useOpenTask.ts', 'components/tasks/WaitingChip.tsx']);

const fmt = (hits: Hit[]) => hits.map((h) => `web/src/${h.file}:${h.line}  ${h.what}`).join('\n');

describe('a task-ref click has one action', () => {
  it('no task-open callback is threaded through props, parameters or variables', () => {
    const hits = FILES.filter((f) => !NON_APP_WINDOW.test(f.rel) && !PLUGIN_CONTRACT.test(f.rel)).flatMap(declaredNames);
    expect(hits, `call useOpenTask() (web/src/hooks/useOpenTask.ts) where the reference is drawn instead:\n${fmt(hits)}`).toEqual([]);
  });

  it('a task pill with its own onClick calls the one action', () => {
    const hits = FILES.filter((f) => !NON_APP_WINDOW.test(f.rel)).flatMap(pillsWithOwnClick);
    expect(hits, fmt(hits)).toEqual([]);
  });

  it('only a window that is not the app provides its own opener', () => {
    const hits = FILES.filter((f) => !NON_APP_WINDOW.test(f.rel) && /TaskOpenerContext\.Provider|<TaskOpenerContext\b/.test(f.text))
      .map((f) => ({ file: f.rel, line: 0, what: 'TaskOpenerContext provider' }));
    expect(hits, fmt(hits)).toEqual([]);
  });

  it('a Find on Home or a raw locate event is only where it is listed', () => {
    const calls = FILES.filter((f) => f.rel !== 'utils/open-session.ts' && /\blocateTaskOnHome\(/.test(f.text) && !(f.rel in LOCATES)).map((f) => f.rel);
    expect(calls, 'a task-ref click calls useOpenTask(); a real Find on Home is listed in LOCATES with why').toEqual([]);
    const stale = Object.keys(LOCATES).filter((rel) => !FILES.find((f) => f.rel === rel)?.text.match(/\blocateTaskOnHome\(/));
    expect(stale, 'a listed Find on Home is gone: drop it from LOCATES').toEqual([]);
    const raw = FILES.filter((f) => !LOCATE_EVENT.has(f.rel) && /['"]main:locate-task['"]/.test(f.text)).map((f) => f.rel);
    expect(raw, 'send it through openTaskOnHome; close a layer with useYieldsToTaskOpen').toEqual([]);
  });

  it('useEntityClickHandler opens a task pill itself', () => {
    const f = FILES.find((x) => x.rel === 'hooks/useEntityClickHandler.ts')!;
    expect(f.text).toMatch(/const openTask = useOpenTask\(\)/);
    expect(f.text).toMatch(/if \(taskId\) openTask\(taskId\)/);
  });

  it('the family pattern catches the old names and spares the kept ones', () => {
    for (const n of ['onTaskClick', 'onOpenTask', 'onFocusChild', 'onOpenTaskId', 'onPhoneOpenTask', 'chatTaskClick', 'onOpenLinkedTask', 'onTaskChipClick', 'onSelectTaskRef'])
      expect(isTaskOpenCallback(n), n).toBe(true);
    for (const n of ['onOpenTaskDetail', 'onFocusTask', 'onOpenTriageForTask', 'onLocateTask', 'onPinTask', 'onAddTask', 'onMoveTask', 'onOpenSession'])
      expect(isTaskOpenCallback(n), n).toBe(false);
  });
});
