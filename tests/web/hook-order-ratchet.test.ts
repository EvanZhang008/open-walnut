/**
 * Hook-order ratchet: no React hook runs after a conditional return, or inside
 * a branch, in a component or a custom hook under web/src.
 *
 * React matches hooks to state by call order, so a render that calls a
 * different number of hooks than the one before it throws "Rendered more hooks
 * than during the previous render" and takes the whole tree down. The fork r6
 * gate found one: App returned the popout shell before its own `useRef`, so a
 * popout window that navigated to an app path (the task page leaving a merged
 * or deleted task) crashed, in Chromium and WebKit. The same scan found two
 * more: ChatMessage and SessionMessage returned their special rows (heartbeat
 * line, system line, interrupt marker) above the bubble's hooks, and a live row
 * can change kind. All three now branch BEFORE any hook or hand the branch to
 * a separate component.
 *
 * Over the TypeScript AST of every .ts/.tsx under web/src, each function named
 * like a component (PascalCase) or a hook (`use…`) is read statement by
 * statement: a hook call after the first statement that can return, or inside
 * an if / ?: / && / || / ?? / loop / switch / try, is flagged.
 *
 * ALLOWED lists the few that are safe, each with its reason; a stale entry
 * fails too, so the list only shrinks.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const repoRoot = path.resolve(__dirname, '../..');
const webSrc = path.join(repoRoot, 'web', 'src');

/** `file|function|hook` → why the call order cannot change between renders. */
const ALLOWED: Record<string, string> = {
  'web/src/components/board/kanban/useKanbanBoard.ts|useFeedSafe|useNotifications':
    'inside try only: it calls useContext on every render, and the catch covers a window with no provider, which never changes for a mounted tree',
};

const BRANCH_OPERATORS = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const isHookName = (name: string) => /^use[A-Z0-9]/.test(name);
const isComponentName = (name: string) => /^[A-Z]/.test(name);

type Fn = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

function isFn(node: ts.Node): node is Fn {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
}

/** The name a function is known by: its own, its variable's, or the variable holding `memo(fn)` / `forwardRef(fn)`. */
function fnName(fn: Fn): string | null {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const parent = fn.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent && ts.isCallExpression(parent)) {
    const holder = parent.parent;
    if (holder && ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) return holder.name.text;
  }
  return null;
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) return callee.name.text;
  return null;
}

/** Does this statement return (not counting nested functions)? */
function canReturn(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found || isFn(n)) return;
    if (ts.isReturnStatement(n)) { found = true; return; }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function isBranch(node: ts.Node): boolean {
  return ts.isIfStatement(node) || ts.isConditionalExpression(node) || ts.isSwitchStatement(node)
    || ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)
    || ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isTryStatement(node)
    || (ts.isBinaryExpression(node) && BRANCH_OPERATORS.has(node.operatorToken.kind));
}

/** The part of a branch that runs on every pass: an if's condition, the left of `&&`, a ternary's test, a switch's subject. */
function alwaysRuns(parent: ts.Node, child: ts.Node): boolean {
  if (ts.isIfStatement(parent)) return child === parent.expression;
  if (ts.isBinaryExpression(parent)) return child === parent.left;
  if (ts.isConditionalExpression(parent)) return child === parent.condition;
  if (ts.isSwitchStatement(parent)) return child === parent.expression;
  return false;
}

function hookCalls(statement: ts.Statement): { call: ts.CallExpression; name: string; conditional: boolean }[] {
  const out: { call: ts.CallExpression; name: string; conditional: boolean }[] = [];
  const visit = (node: ts.Node, conditional: boolean) => {
    if (isFn(node)) return;
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name && isHookName(name)) out.push({ call: node, name, conditional });
    }
    const branch = isBranch(node);
    ts.forEachChild(node, (child) => visit(child, conditional || (branch && !alwaysRuns(node, child))));
  };
  visit(statement, false);
  return out;
}

export interface HookOrderHit { key: string; where: string }

/** Every hook call whose order can change between renders, in one source text. */
export function scanHookOrder(relPath: string, text: string): HookOrderHit[] {
  const sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, relPath.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const hits: HookOrderHit[] = [];
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const check = (fn: Fn) => {
    const name = fnName(fn);
    if (!name || !(isHookName(name) || isComponentName(name))) return;
    if (!fn.body || !ts.isBlock(fn.body)) return;
    let returnedAt: number | null = null;
    for (const statement of fn.body.statements) {
      for (const hook of hookCalls(statement)) {
        if (returnedAt !== null) {
          hits.push({ key: `${relPath}|${name}|${hook.name}`, where: `${relPath}:${lineOf(hook.call)} ${name}: ${hook.name} after the return at line ${returnedAt}` });
        } else if (hook.conditional) {
          hits.push({ key: `${relPath}|${name}|${hook.name}`, where: `${relPath}:${lineOf(hook.call)} ${name}: ${hook.name} inside a branch` });
        }
      }
      if (returnedAt === null && canReturn(statement)) returnedAt = lineOf(statement);
    }
  };
  const visit = (node: ts.Node) => {
    if (isFn(node)) check(node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe('hook-order ratchet (web/src)', () => {
  it('flags the shapes that crash a render, and passes the shapes that do not', () => {
    const crashing = `
      export function App() {
        const location = useLocation();
        if (isPopoutPath(location.pathname)) return <PopoutRoot />;
        const navigateRef = useRef(null);
        return <Shell navigateRef={navigateRef} />;
      }
      export const Row = memo(function Row({ kind }: { kind: string }) {
        if (kind === 'system') { useMemo(() => 1, []); }
        const a = kind ? useState(0) : null;
        const b = kind === 'x' && useCallback(() => {}, []);
        return null;
      });
      function useThing(list: string[]) {
        for (const x of list) useRef(x);
        return null;
      }
    `;
    expect(scanHookOrder('web/src/Fake.tsx', crashing).map((h) => h.key)).toEqual([
      'web/src/Fake.tsx|App|useRef',
      'web/src/Fake.tsx|Row|useMemo',
      'web/src/Fake.tsx|Row|useState',
      'web/src/Fake.tsx|Row|useCallback',
      'web/src/Fake.tsx|useThing|useRef',
    ]);

    const safe = `
      export function App() {
        const location = useLocation();
        const navigateRef = useRef(null);
        const onClick = useCallback(() => { if (x) return; useNotAHookCallHere(); }, []);
        if (useIsPopout(location) && isPopoutPath(location.pathname)) return <PopoutRoot />;
        return <Shell navigateRef={navigateRef} onClick={onClick} />;
      }
      export function Dispatcher(props: Props) {
        const special = specialRow(props);
        if (special !== undefined) return special;
        return <Bubble {...props} />;
      }
      function helper() { if (a) return 1; return useless(); }
    `;
    expect(scanHookOrder('web/src/Fake.tsx', safe)).toEqual([]);
  });

  it('finds no hook whose call order can change, outside the reviewed list', () => {
    const hits = sourceFiles(webSrc).flatMap((file) => {
      const rel = path.relative(repoRoot, file).split(path.sep).join('/');
      return scanHookOrder(rel, fs.readFileSync(file, 'utf8'));
    });
    const unexpected = hits.filter((h) => !(h.key in ALLOWED)).map((h) => h.where);
    expect(unexpected, [
      'A hook runs after a conditional return or inside a branch, so a render can call a',
      'different number of hooks than the one before it and React throws "Rendered more hooks',
      'than during the previous render". Move every hook above the first return, or branch in',
      'a hook-free dispatcher that returns a separate component (see ChatMessageInner).',
    ].join(' ')).toEqual([]);

    const stale = Object.keys(ALLOWED).filter((key) => !hits.some((h) => h.key === key));
    expect(stale, 'ALLOWED entries that no longer match anything: delete them').toEqual([]);
  });
});
