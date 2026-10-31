/**
 * Stale-object ratchet: a memoized callback that hands an object on whole
 * (`onClick(task)`) lists that object in its deps, not only a field of it.
 *
 * 2026-10-30: a task row's title click (TodoPanel `TaskRowBody`,
 * `handleTitleClick`) passed `task` to the row's click handler while its deps
 * named only `task.id`. A task whose session started after its row first
 * rendered kept the copy without a session in that closure, so a click on its
 * title selected the task and opened nothing, while the same row already drew
 * the fresh task (its Start button was gone). The real-pipeline spec
 * (tests/e2e/browser/single-timeline-real-pipeline.spec.ts) found it by opening
 * its session the way a person does.
 *
 * Over the TypeScript AST of every .ts/.tsx under web/src: in each useCallback
 * or useMemo whose deps name a field of `x` (`x.id`, `x?.id`) but not `x`
 * itself, every place the callback hands `x` on whole (a call argument, an
 * object shorthand `{ x }`, a spread, an array element, a JSX value, an
 * assignment, a returned value) is flagged: that copy is whatever `x` was when
 * a listed dep last changed. `x` is a nested object too: deps of
 * `[task.session.id]` with `onOpen(task.session)` are the same mistake.
 * Effects are left out: an effect runs
 * at the commit that changed its deps, with that render's values, so a missing
 * dep there skips a re-run but never hands an old copy on later.
 *
 * ALLOWED lists the safe ones, each with its reason; a stale entry fails too,
 * so the list only shrinks.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const repoRoot = path.resolve(__dirname, '../..');
const webSrc = path.join(repoRoot, 'web', 'src');

/** `file|holder|object` → why the stale copy cannot matter. */
const ALLOWED: Record<string, string> = {
  'web/src/contexts/FocusBarContext.tsx|value|focusBar':
    'deliberate: the context changes only with the pin and tier ids and visibility; consumers read fresh task data from TasksContext',
  'web/src/contexts/TasksContext.tsx|value|t':
    'deliberate: every data field of useTasks() is listed, and its callbacks are stable',
  'web/src/components/tasks/TaskDetailPane.tsx|useMemo|task':
    'taskSessionLayout reads only the session fields the deps list, and the result keeps no copy of the task',
  'web/src/pages/TaskDetailPage.tsx|sessionLayout|task':
    'taskSessionLayout reads only the session fields the deps list, and the result keeps no copy of the task',
  'web/src/stores/recap-tip-store.ts|useMemo|fields':
    'fields is rebuilt every render from exactly the four parts the deps list',
};

const HOOKS = new Set(['useCallback', 'useMemo']);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

type Fn = ts.FunctionExpression | ts.ArrowFunction;

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) return callee.name.text;
  return null;
}

/** `x`, `x.a.b` for `x?.a!.b`: an identifier and its property names; null for anything else. */
function chainText(e: ts.Expression): string | null {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e)) return chainText(e.expression);
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) {
    const head = chainText(e.expression);
    return head ? `${head}.${e.name.text}` : null;
  }
  return null;
}

/** The objects a dep reads a field of: `x` and `x.a` for `x.a.b`, `x` for `x[0]`. */
function fieldOwners(e: ts.Expression): string[] {
  if (ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e)) return fieldOwners(e.expression);
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
    const owner = chainText(e.expression);
    return [...fieldOwners(e.expression), ...(owner ? [owner] : [])];
  }
  return [];
}

function addBindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) { out.add(name.text); return; }
  for (const el of name.elements) if (!ts.isOmittedExpression(el)) addBindingNames(el.name, out);
}

/** Every name bound inside the callback (its parameters included): those shadow the outer object. */
function boundNames(fn: Fn): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isParameter(n) || ts.isVariableDeclaration(n) || ts.isBindingElement(n)) addBindingNames(n.name, out);
    else if ((ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) && n.name) out.add(n.name.text);
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return out;
}

/** The variable a hook's result is held in (`const onClick = useCallback(...)`), else the hook's name. */
function holderName(call: ts.CallExpression, hook: string): string {
  const parent = call.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  return hook;
}

export interface StaleObjectHit { key: string; where: string }

/** Every whole object a memoized callback hands on while its deps carry only a field of it. */
export function scanStaleObjects(relPath: string, text: string): StaleObjectHit[] {
  const sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, relPath.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const hits: StaleObjectHit[] = [];
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const check = (call: ts.CallExpression, hook: string) => {
    const [fn, deps] = call.arguments;
    if (!fn || !deps || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || !ts.isArrayLiteralExpression(deps)) return;
    const whole = new Set<string>();
    const fields = new Set<string>();
    for (const dep of deps.elements) {
      const text = chainText(dep);
      if (text) whole.add(text);
      for (const owner of fieldOwners(dep)) fields.add(owner);
    }
    // An object counts as listed when it, or an object holding it, is a dep.
    const listed = (name: string) => name.split('.').some((_, i, parts) => whole.has(parts.slice(0, i + 1).join('.')));
    const watched = [...fields].filter((name) => !listed(name));
    if (watched.length === 0) return;
    const bound = boundNames(fn);
    const holder = holderName(call, hook);
    const seen = new Set<string>();
    const flag = (e: ts.Expression, how: string) => {
      const text = chainText(e);
      if (!text || !watched.includes(text) || bound.has(text.split('.')[0])) return;
      const key = `${relPath}|${holder}|${text}`;
      if (seen.has(key)) return;
      seen.add(key);
      hits.push({ key, where: `${relPath}:${lineOf(e)} ${holder} hands ${text} on (${how}) while its deps name only ${text}'s fields` });
    };
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        for (const arg of n.arguments ?? []) flag(arg, 'a call argument');
      } else if (ts.isShorthandPropertyAssignment(n)) {
        flag(n.name, 'an object shorthand');
      } else if (ts.isSpreadAssignment(n) || ts.isSpreadElement(n)) {
        flag(n.expression, 'a spread');
      } else if (ts.isArrayLiteralExpression(n)) {
        for (const el of n.elements) flag(el, 'an array element');
      } else if (ts.isJsxExpression(n) && n.expression) {
        flag(n.expression, 'a JSX value');
      } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        flag(n.right, 'an assignment');
      } else if (ts.isReturnStatement(n) && n.expression) {
        flag(n.expression, 'the returned value');
      }
      ts.forEachChild(n, visit);
    };
    if (!ts.isBlock(fn.body)) flag(fn.body, 'the returned value');
    if (ts.isBlock(fn.body) || !chainText(fn.body)) visit(fn.body);
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name && HOOKS.has(name)) check(node, name);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe('stale-object ratchet (web/src)', () => {
  it('flags a whole object handed on under field-only deps, and passes the safe shapes', () => {
    const stale = `
      const Row = memo(function Row({ task, onClick }: Props) {
        const handleTitleClick = useCallback(() => { onClick(task); }, [onClick, task.id]);
        const payload = useMemo(() => ({ task }), [task?.id]);
        const picked = useMemo(() => task, [task.title]);
        const copy = useMemo(() => ({ ...task, open: true }), [task.id]);
        const list = useMemo(() => [task], [task.id]);
        const card = useMemo(() => <Card task={task} />, [task.id]);
        const keep = useCallback(() => { ref.current = task; }, [task.id]);
        const open = useCallback(() => { onOpen(task.session); }, [onOpen, task.session?.id]);
        return null;
      });
    `;
    expect(scanStaleObjects('web/src/Fake.tsx', stale).map((h) => h.key)).toEqual([
      'web/src/Fake.tsx|handleTitleClick|task',
      'web/src/Fake.tsx|payload|task',
      'web/src/Fake.tsx|picked|task',
      'web/src/Fake.tsx|copy|task',
      'web/src/Fake.tsx|list|task',
      'web/src/Fake.tsx|card|task',
      'web/src/Fake.tsx|keep|task',
      'web/src/Fake.tsx|open|task.session',
    ]);

    const safe = `
      const Row = memo(function Row({ task, onClick, onRename }: Props) {
        const a = useCallback(() => { onClick(task); }, [onClick, task]);
        const b = useCallback(() => { onRename(task.id, task.title); }, [onRename, task.id, task.title]);
        const c = useCallback((task: Task) => { onClick(task); }, [onClick, other.id]);
        const d = useCallback(() => { list.forEach((task) => onClick(task)); }, [list, task.id]);
        const e = useCallback(() => { onOpen(task.session); }, [onOpen, task]);
        const f = useCallback(() => { onOpen(task.session); }, [onOpen, task.session]);
        const g = useCallback(() => { onRename(task.session.id); }, [onRename, task.session.id]);
        useEffect(() => { onClick(task); }, [onClick, task.id]);
        return null;
      });
    `;
    expect(scanStaleObjects('web/src/Fake.tsx', safe)).toEqual([]);
  });

  it('every memoized callback that hands an object on lists that object in its deps', () => {
    const hits: StaleObjectHit[] = [];
    for (const file of sourceFiles(webSrc)) {
      const rel = path.relative(repoRoot, file).split(path.sep).join('/');
      hits.push(...scanStaleObjects(rel, fs.readFileSync(file, 'utf8')));
    }
    const unexpected = hits.filter((h) => !(h.key in ALLOWED)).map((h) => h.where);
    expect(unexpected, 'list the object itself in the deps (or read it through a ref)').toEqual([]);
    const live = new Set(hits.map((h) => h.key));
    expect(Object.keys(ALLOWED).filter((key) => !live.has(key)), 'stale ALLOWED entries').toEqual([]);
  });
});
