/**
 * The board frame's scripts (web/src/components/board/*.frame.js) share one kit object,
 * `window.__wnBoardKit`, built in board-runtime.frame.js. They are plain strings loaded into the
 * frame, so no type check reads them: 2026-11-27, a change removed `hhmm` from the runtime while the
 * kit still exported `hhmm: hhmm`, and the whole board script threw a ReferenceError on load.
 *
 * This fails when the kit names a value its file does not declare, or a frame script reads a
 * `kit.X` that the kit neither exports nor gets assigned (`kit.Remind = ...`).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const DIR = path.resolve(__dirname, '../../web/src/components/board')
const frames = fs.readdirSync(DIR).filter((f) => f.endsWith('.frame.js'))
const parse = (f: string) => ts.createSourceFile(f, fs.readFileSync(path.join(DIR, f), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)

function walk(n: ts.Node, fn: (n: ts.Node) => void) { fn(n); ts.forEachChild(n, (c) => walk(c, fn)) }

describe('board frame kit', () => {
  it('every name the kit exports is declared in board-runtime.frame.js', () => {
    const sf = parse('board-runtime.frame.js')
    const declared = new Set<string>()
    let kit: ts.ObjectLiteralExpression | undefined
    walk(sf, (n) => {
      if ((ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isClassDeclaration(n)) && n.name && ts.isIdentifier(n.name)) declared.add(n.name.text)
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && n.left.getText() === 'window.__wnBoardKit' && ts.isObjectLiteralExpression(n.right)) kit = n.right
    })
    expect(kit, 'window.__wnBoardKit = { ... } not found').toBeTruthy()
    const missing = kit!.properties.flatMap((p) => {
      const v = ts.isPropertyAssignment(p) ? p.initializer : ts.isShorthandPropertyAssignment(p) ? p.name : undefined
      return v && ts.isIdentifier(v) && !declared.has(v.text) ? [`${p.name?.getText()}: ${v.text}`] : []
    })
    expect(missing).toEqual([])
  })

  it('every kit.X a frame script reads is exported or assigned', () => {
    const sf = parse('board-runtime.frame.js')
    const have = new Set<string>()
    walk(sf, (n) => {
      if (ts.isBinaryExpression(n) && n.left.getText() === 'window.__wnBoardKit' && ts.isObjectLiteralExpression(n.right)) {
        for (const p of n.right.properties) if (p.name) have.add(p.name.getText())
      }
    })
    const reads: string[] = []
    for (const f of frames) {
      walk(parse(f), (n) => {
        if (!ts.isPropertyAccessExpression(n) || !ts.isIdentifier(n.expression) || n.expression.text !== 'kit') return
        const assigned = ts.isBinaryExpression(n.parent) && n.parent.left === n && n.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
        if (assigned) have.add(n.name.text)
        else reads.push(`${f}: kit.${n.name.text}`)
      })
    }
    expect(reads.filter((r) => !have.has(r.split('kit.')[1]))).toEqual([])
  })
})
