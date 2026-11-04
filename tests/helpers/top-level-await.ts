/**
 * A module's top-level awaits: `await` or `for await` outside every function
 * body. dist/cli-fast.js is CommonJS (scripts/build-cli-fast.mjs), which has
 * none, so one anywhere in its import graph fails the build.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

/** Each top-level await of `file` as `<file relative to root>:<line>: <code>`. */
export function topLevelAwaits(file: string, root: string): string[] {
  const text = fs.readFileSync(file, 'utf8')
  const kind = /\.tsx?$/.test(file) ? (file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS) : ts.ScriptKind.JS
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node)) return
    if (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier !== undefined)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart())
      found.push(`${path.relative(root, file)}:${line + 1}: ${node.getText().split('\n')[0]}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}
