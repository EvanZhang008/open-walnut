/**
 * The field tree of the Config interface, read from the source (src/core/types.ts
 * and the files its sections name), for the config copy's ratchet
 * (tests/core/replication/config-allowlist.test.ts). A small reader of the type
 * syntax the Config sections use: object literals, `Record<string, T>`, `Array<T>`,
 * `T[]`, unions, and named interfaces or aliases from a fixed file list.
 */
import fs from 'node:fs'
import path from 'node:path'

export interface TypeNode {
  /** Fields of an object type. */
  fields?: Record<string, TypeNode>
  /** The entry type of a map keyed by a name. */
  each?: TypeNode
  /** The element type of a list. */
  elem?: TypeNode
  /** A named type the reader could not find (or one that names itself): treat it as a record. */
  unresolved?: string
}

const ROOT = path.join(__dirname, '../..')
const FILES = ['src/core/types.ts', 'src/core/keep-awake.ts', 'src/model/providers/types.ts']
let sources: string[] | null = null

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
}

function src(): string[] {
  sources ??= FILES.map((f) => stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8')))
  return sources
}

const OPEN = '{<([', CLOSE = '}>)]'

/** `s` split on `sep` where no bracket is open. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0, from = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (OPEN.includes(c)) depth++
    else if (CLOSE.includes(c) && !(c === '>' && s[i - 1] === '=')) depth--
    else if (depth === 0 && s.startsWith(sep, i)) { out.push(s.slice(from, i)); from = i + sep.length }
  }
  out.push(s.slice(from))
  return out.map((x) => x.trim()).filter((x) => x.length > 0)
}

/** The fields of an object literal's body (between its braces). */
function fieldsOf(body: string): Record<string, TypeNode> {
  const out: Record<string, TypeNode> = {}
  for (const member of splitTop(body, ';')) {
    const m = /^(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\??\s*:\s*([\s\S]+)$/.exec(member)
    if (m) out[m[1]!] = typeNode(m[2]!)
  }
  return out
}

const resolving = new Set<string>()

/** A named interface or alias from the file list, or an unresolved node. */
function named(name: string): TypeNode {
  if (resolving.has(name)) return { unresolved: name }
  resolving.add(name)
  try { return namedOnce(name) ?? { unresolved: name } } finally { resolving.delete(name) }
}

function namedOnce(name: string): TypeNode | null {
  for (const s of src()) {
    const i = new RegExp(`export interface ${name}\\s*(?:extends[^{]*)?\\{`).exec(s)
    if (i) return { fields: fieldsOf(s.slice(i.index + i[0].length, closing(s, i.index + i[0].length - 1))) }
    const t = new RegExp(`export type ${name}\\s*=`).exec(s)
    if (t) {
      const rest = s.slice(t.index + t[0].length)
      return typeNode(splitTop(rest, ';')[0]!)
    }
  }
  return null
}

/** The index of the brace closing the one at `open`. */
function closing(s: string, open: number): number {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++
    else if (s[i] === '}' && --depth === 0) return i
  }
  throw new Error('unclosed brace')
}

export function typeNode(raw: string): TypeNode {
  const t = raw.trim().replace(/^\|\s*/, '')
  const union = splitTop(t, '|')
  if (union.length > 1) {
    // A union is the merge of its parts: a scalar part adds nothing.
    const parts = union.map(typeNode)
    const out: TypeNode = {}
    for (const p of parts) {
      if (p.fields) out.fields = { ...out.fields, ...p.fields }
      if (p.each) out.each = p.each
      if (p.unresolved) out.unresolved = p.unresolved
      if (p.elem) out.elem = out.elem?.fields || !p.elem.fields ? (out.elem ?? p.elem) : p.elem
    }
    return out
  }
  if (t.startsWith('{')) return { fields: fieldsOf(t.slice(1, closing(t, 0))) }
  let m = /^Record<\s*string\s*,([\s\S]*)>$/.exec(t)
  if (m) return { each: typeNode(m[1]!) }
  m = /^(?:Readonly)?Array<([\s\S]*)>$/.exec(t)
  if (m) return { elem: typeNode(m[1]!) }
  if (t.endsWith('[]')) return { elem: typeNode(t.slice(0, -2).replace(/^\(([\s\S]*)\)$/, '$1')) }
  m = /^(?:Omit|Partial|Required)<\s*([A-Za-z_][\w]*)[\s\S]*>$/.exec(t)
  if (m) return named(m[1]!)
  m = /^(?:import\('[^']+'\)\.)?([A-Z][A-Za-z0-9_]*)$/.exec(t)
  if (m) return named(m[1]!)
  // A scalar, a literal, or the element of a const list (`(typeof IDS)[number]`).
  if (/^[a-z]+$|^'[^']*'$|^`[^`]*`$|^-?[0-9]+$|^\(typeof [A-Za-z_]\w*\)\[number\]$/.test(t)) return {}
  return { unresolved: t }
}

/** The Config interface's field tree. */
export function configTypeTree(): Record<string, TypeNode> {
  const n = named('Config')
  if (!n.fields) throw new Error('no Config interface')
  return n.fields
}
