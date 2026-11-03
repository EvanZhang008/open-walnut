/**
 * The module-level names an extracted daemon function reads.
 *
 * Several suites take one function's text out of a daemon twin (by AST or by text) and
 * run it alone with the names it reads handed in. A name added at module scope that the
 * function reads then exists nowhere in that run: every frame failed with
 * `ReferenceError: SERVED_PUSHES is not defined` (2026-11-03, 113 tests), and a name read
 * only on a branch the suite does not take would not fail at all. A harness checks
 * `missingNames(text, provided)` before it runs the function, so a new name fails there,
 * by name, whichever branch reads it.
 */
import ts from 'typescript'

/** True for a node in a type position (annotations, `as T`, generics): no runtime name there. */
function isTypePosition(node: ts.Node): boolean {
  // `class A extends Base`: Base is a value read at run time, though TS parses it as a type node.
  if (ts.isExpressionWithTypeArguments(node) && ts.isHeritageClause(node.parent)
    && node.parent.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(node.parent.parent)) return false
  return ts.isTypeNode(node) || ts.isTypeParameterDeclaration(node)
    || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
}

function bindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) { out.add(name.text); return }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) bindingNames(element.name, out)
  }
}

/** Whether an identifier is a name read at run time, not a property key, a label or a declaration. */
function isReference(node: ts.Identifier): boolean {
  const parent = node.parent
  if (!parent) return true
  if ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)
    || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)
    || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)) && parent.name === node) return false
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent) || ts.isMetaProperty(parent)) return false
  if ((ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent)
    || ts.isClassExpression(parent) || ts.isVariableDeclaration(parent) || ts.isParameter(parent)
    || ts.isBindingElement(parent)) && parent.name === node) return false
  return true
}

/**
 * Names `code` reads that it does not declare itself and `globals` (the scope it runs in;
 * this process's by default) does not hold. A run in a `vm` context passes that context's
 * own global object: it has no `process`, `setTimeout` or `Buffer` unless handed in.
 * Declarations count wherever they are in the text (no scope walk): a guard that misses a
 * shadowed name is still a guard, and it never reports a name the code declares.
 */
export function freeNames(code: string, globals: object = globalThis): string[] {
  const file = ts.createSourceFile('extracted.ts', code, ts.ScriptTarget.ES2022, true)
  const declared = new Set<string>()
  const read = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (isTypePosition(node)) return
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node)) && node.name) declared.add(node.name.text)
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) bindingNames(node.name, declared)
    if (ts.isCatchClause(node) && node.variableDeclaration) bindingNames(node.variableDeclaration.name, declared)
    if (ts.isIdentifier(node) && isReference(node)) read.add(node.text)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return [...read].filter((name) => !declared.has(name) && !(name in globals) && name !== 'undefined' && name !== 'arguments').sort()
}

/** The names `code` reads that `provided` does not hand in: [] when the run can read them all. */
export function missingNames(code: string, provided: Iterable<string>, globals: object = globalThis): string[] {
  const have = new Set(provided)
  return freeNames(code, globals).filter((name) => !have.has(name))
}
