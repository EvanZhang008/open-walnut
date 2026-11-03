/**
 * Finds every use of a terminal status (useSessionTerminal's `status`) that is not
 * on the allowlist, over one file's TypeScript AST. Used by
 * tests/web/terminal-status-pill-guard.test.ts.
 *
 * Tracked, by name within the file (repeated until nothing new is found):
 *  - hook RESULTS: `useSessionTerminal(...)` itself, a name it is stored in (or
 *    copied to), a rest element destructured from one, and a name typed
 *    `UseSessionTerminalReturn` / `ReturnType<typeof useSessionTerminal>`;
 *  - status VALUES: `status` (or `status: s`) destructured from a result,
 *    `const s = <result>.status`, and a name typed `TerminalStatus` or
 *    `UseSessionTerminalReturn['status']` (inline, or through an interface or type
 *    alias declared in the same file).
 * A result may only be read by member (`term.kill()`, `term.status`) or
 * destructured; passing it whole (an argument, a spread, a JSX attribute, a
 * context value, an array or object) lets another component print its status, so
 * it fails. A value may only be compared (`===`, `!==`), passed as
 * `status={...}` to TerminalStatusPill or `data-status={...}` on a native tag,
 * listed in a hook's dependency array, handed to the label functions, or put in an
 * object passed to `log.*` / `console.*`.
 */
import ts from 'typescript'

const SAFE_CALLS = new Set(['terminalStatusLabel', 'terminalStatusClass', 'isTerminalStatus'])
const DEP_HOOKS = new Set(['useEffect', 'useLayoutEffect', 'useCallback', 'useMemo', 'useImperativeHandle'])
const LOGGERS = new Set(['log', 'console'])
const RESULT_TYPE = /\bUseSessionTerminalReturn\b|ReturnType<\s*typeof\s+useSessionTerminal\s*>/
const RESULT_STATUS_TYPE = /(\bUseSessionTerminalReturn\b|ReturnType<\s*typeof\s+useSessionTerminal\s*>)\s*\[\s*['"]status['"]\s*\]/
export const STATUS_FIX = 'render terminalStatusLabel(status) or <TerminalStatusPill status={status} />, never the code'
export const RESULT_FIX = 'pass status only to TerminalStatusPill or the label functions, or pass explicit fields; never the whole hook result'

type Kind = 'value' | 'result' | null

function typeKind(t: ts.TypeNode | undefined): Kind {
  if (!t) return null
  const text = t.getText()
  if (/\bTerminalStatus\b/.test(text) || RESULT_STATUS_TYPE.test(text)) return 'value'
  return RESULT_TYPE.test(text) ? 'result' : null
}

/** Parentheses, `!`, `as` and `satisfies` change nothing about what a value is. */
function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression
  return e
}

/** The outermost wrapper around `n` (so its parent is the real use). */
function outer(n: ts.Node): ts.Node {
  while (n.parent && (ts.isParenthesizedExpression(n.parent) || ts.isNonNullExpression(n.parent) || ts.isAsExpression(n.parent) || ts.isSatisfiesExpression(n.parent))) n = n.parent
  return n
}

const isHookCall = (e: ts.Expression): boolean =>
  ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'useSessionTerminal'

/** True for a reference to an identifier, not a declaration name or a property key. */
function isReference(n: ts.Identifier): boolean {
  const p = n.parent
  if ((ts.isBindingElement(p) && (p.name === n || p.propertyName === n)) || ((ts.isVariableDeclaration(p) || ts.isParameter(p)) && p.name === n)) return false
  if ((ts.isPropertyAccessExpression(p) && p.name === n) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p)) return false
  if ((ts.isPropertyAssignment(p) && p.name === n) || ts.isJsxAttribute(p) || ts.isTypeReferenceNode(p)) return false
  if (ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isImportSpecifier(p) || ts.isImportClause(p)) return false
  return !ts.isQualifiedName(p)
}

export function terminalStatusViolations(fileName: string, src: string): string[] {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const values = new Set<string>()
  const results = new Set<string>()
  const isResult = (e: ts.Expression): boolean => {
    const u = unwrap(e)
    return isHookCall(u) || (ts.isIdentifier(u) && results.has(u.text))
  }
  const isStatusMember = (e: ts.Expression): boolean => {
    const u = unwrap(e)
    return ts.isPropertyAccessExpression(u) && u.name.text === 'status' && isResult(u.expression)
  }

  // Interfaces and type aliases of this file: member name -> kind.
  const localTypes = new Map<string, Map<string, Kind>>()
  const members = (list: readonly ts.TypeElement[]) => {
    const m = new Map<string, Kind>()
    for (const el of list) if (ts.isPropertySignature(el)) m.set(el.name.getText(), typeKind(el.type))
    return m
  }
  const collectTypes = (n: ts.Node) => {
    if (ts.isInterfaceDeclaration(n)) localTypes.set(n.name.text, members(n.members))
    if (ts.isTypeAliasDeclaration(n) && ts.isTypeLiteralNode(n.type)) localTypes.set(n.name.text, members(n.type.members))
    ts.forEachChild(n, collectTypes)
  }
  collectTypes(sf)
  const memberKinds = (t: ts.TypeNode | undefined): Map<string, Kind> | undefined => {
    if (!t) return undefined
    if (ts.isTypeLiteralNode(t)) return members(t.members)
    if (ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName)) return localTypes.get(t.typeName.text)
    return undefined
  }

  const add = (kind: Kind, name: string): boolean => {
    const set = kind === 'value' ? values : kind === 'result' ? results : null
    if (!set || set.has(name)) return false
    set.add(name)
    return true
  }
  const collect = (n: ts.Node): boolean => {
    let grew = false
    if (ts.isVariableDeclaration(n) || ts.isParameter(n)) {
      const init = n.initializer
      if (ts.isIdentifier(n.name)) {
        const kind: Kind = init && isResult(init) ? 'result' : init && isStatusMember(init) ? 'value' : typeKind(n.type)
        grew = add(kind, n.name.text) || grew
      } else if (ts.isObjectBindingPattern(n.name)) {
        const fromResult = !!init && isResult(init)
        const byMember = memberKinds(n.type)
        for (const el of n.name.elements) {
          if (!ts.isIdentifier(el.name)) continue
          const prop = el.propertyName ? el.propertyName.getText() : el.name.text
          let kind: Kind = null
          if (fromResult) kind = el.dotDotDotToken ? 'result' : prop === 'status' ? 'value' : null
          else kind = byMember?.get(prop) ?? null
          grew = add(kind, el.name.text) || grew
        }
      }
    }
    ts.forEachChild(n, (c) => { grew = collect(c) || grew })
    return grew
  }
  for (let i = 0; i < 8 && collect(sf); i++) { /* until no new name */ }

  const valueUseAllowed = (ref: ts.Node): boolean => {
    const node = outer(ref)
    const p = node.parent
    if (ts.isBinaryExpression(p)) {
      const op = p.operatorToken.kind
      return op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken
    }
    if (ts.isJsxExpression(p) && ts.isJsxAttribute(p.parent)) {
      const attr = p.parent.name.getText()
      const tag = p.parent.parent.parent.tagName.getText()
      return (attr === 'data-status' && /^[a-z][\w-]*$/.test(tag)) || (attr === 'status' && tag === 'TerminalStatusPill')
    }
    if (ts.isArrayLiteralExpression(p) && ts.isCallExpression(p.parent) && p.parent.arguments[1] === p) {
      const callee = p.parent.expression
      return ts.isIdentifier(callee) && DEP_HOOKS.has(callee.text)
    }
    if (ts.isCallExpression(p) && p.arguments.includes(node as ts.Expression)) {
      return ts.isIdentifier(p.expression) && SAFE_CALLS.has(p.expression.text)
    }
    if (ts.isVariableDeclaration(p) && p.initializer === node && ts.isIdentifier(p.name) && isStatusMember(node as ts.Expression)) return true
    if ((ts.isPropertyAssignment(p) && p.initializer === node) || ts.isShorthandPropertyAssignment(p)) {
      const call = p.parent.parent
      return ts.isObjectLiteralExpression(p.parent) && ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) &&
        ts.isIdentifier(call.expression.expression) && LOGGERS.has(call.expression.expression.text)
    }
    return false
  }
  const resultUseAllowed = (ref: ts.Node): boolean => {
    const node = outer(ref)
    const p = node.parent
    if (ts.isPropertyAccessExpression(p) && p.expression === node) return true
    if (ts.isVariableDeclaration(p) && p.initializer === node) return true
    return ts.isExpressionStatement(p)
  }

  const out: string[] = []
  const report = (n: ts.Node, fix: string) => {
    const at = outer(n)
    const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1
    out.push(`${fileName}:${line}: \`${(at.parent ?? at).getText().slice(0, 80)}\` (${fix})`)
  }
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'status' && isResult(n.expression)) {
      if (!valueUseAllowed(n)) report(n, STATUS_FIX)
    } else if (ts.isIdentifier(n) && isReference(n) && values.has(n.text)) {
      if (!valueUseAllowed(n)) report(n, STATUS_FIX)
    }
    if ((ts.isIdentifier(n) && isReference(n) && results.has(n.text)) || (ts.isCallExpression(n) && isHookCall(n))) {
      if (!resultUseAllowed(n)) report(n, RESULT_FIX)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}
