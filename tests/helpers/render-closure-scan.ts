/**
 * Finds the memoized closures that keep a render alive (web/src/hooks/useLeanCallback.ts):
 *
 *   useCallback   every call of React's `useCallback` (`useCallback(…)`, `React.useCallback(…)`)
 *   closureMemo   a `useMemo` whose value is a closure made in the render: its create function
 *                 returns a function (`useMemo(() => (x) => …)`), or an object or array literal
 *                 holding one at any depth (`useMemo(() => ({ onOpen: () => … }))`); both branches
 *                 of a returned `a ? b : c` / `a && b` / `a ?? b` count. A function only passed to
 *                 a call (`.map((t) => …)`, `make(() => …)`) is not counted: what that call keeps
 *                 is its own business, and a module-level factory is the fix this rule names.
 *
 * Over the TypeScript AST, so comments and strings never count. Used by
 * tests/web/lean-callback-ratchet.test.ts.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

export interface RenderClosureCounts { useCallback: number; closureMemo: number }

function isFn(n: ts.Node): boolean {
  return ts.isArrowFunction(n) || ts.isFunctionExpression(n)
}

/** Does this returned value carry a function made right here? */
function holdsClosure(e: ts.Expression): boolean {
  if (isFn(e)) return true
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) return holdsClosure(e.expression)
  if (ts.isConditionalExpression(e)) return holdsClosure(e.whenTrue) || holdsClosure(e.whenFalse)
  if (ts.isBinaryExpression(e) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(e.operatorToken.kind)) {
    return holdsClosure(e.left) || holdsClosure(e.right)
  }
  if (ts.isObjectLiteralExpression(e)) {
    return e.properties.some((p) => ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)
      || (ts.isPropertyAssignment(p) && holdsClosure(p.initializer))
      || (ts.isSpreadAssignment(p) && holdsClosure(p.expression)))
  }
  if (ts.isArrayLiteralExpression(e)) return e.elements.some((el) => !ts.isOmittedExpression(el) && holdsClosure(ts.isSpreadElement(el) ? el.expression : el))
  return false
}

/** The values a create function returns: its concise body, or its own return statements. */
function returnedValues(fn: ts.ArrowFunction | ts.FunctionExpression): ts.Expression[] {
  if (!ts.isBlock(fn.body)) return [fn.body]
  const out: ts.Expression[] = []
  const visit = (n: ts.Node) => {
    if (isFn(n) || ts.isFunctionDeclaration(n) || ts.isClassLike(n)) return
    if (ts.isReturnStatement(n) && n.expression) out.push(n.expression)
    ts.forEachChild(n, visit)
  }
  ts.forEachChild(fn.body, visit)
  return out
}

function hookName(call: ts.CallExpression): string | null {
  const c = call.expression
  if (ts.isIdentifier(c)) return c.text
  if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === 'React') return c.name.text
  return null
}

export function scanRenderClosures(fileName: string, text: string): RenderClosureCounts {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const counts: RenderClosureCounts = { useCallback: 0, closureMemo: 0 }
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const name = hookName(n)
      if (name === 'useCallback') counts.useCallback++
      else if (name === 'useMemo') {
        const fn = n.arguments[0]
        if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && returnedValues(fn).some(holdsClosure)) counts.closureMemo++
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return counts
}

/** Every component and hook source under `dir` (tests and declaration files left out), repo-relative. */
export function webSources(root: string, dir = path.join(root, 'web', 'src')): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...webSources(root, full))
    else if (/\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) out.push(path.relative(root, full).split(path.sep).join('/'))
  }
  return out.sort()
}

/** `file → [useCallback, closureMemo]` for every file with either, the shape the ratchet pins. */
export function renderClosureRows(root: string): Record<string, [number, number]> {
  const rows: Record<string, [number, number]> = {}
  for (const rel of webSources(root)) {
    const c = scanRenderClosures(rel, fs.readFileSync(path.join(root, rel), 'utf8'))
    if (c.useCallback || c.closureMemo) rows[rel] = [c.useCallback, c.closureMemo]
  }
  return rows
}
