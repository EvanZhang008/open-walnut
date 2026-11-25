/**
 * The locked-note file format (src/core/notes/locked-note-format.ts) and its guards
 * (src/core/notes/locked-note.ts): build and parse round-trip, the stub every other reader sees,
 * text that only quotes the format (a plain note, writable everywhere), a file an outside editor
 * bent (writers still refuse it), the hidden mark (a plain note only the person reads and writes),
 * and the parse's cost on a large CRLF note.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import {
  HIDDEN_NOTE_STUB, HIDDEN_STUB_LEAD, LOCKED_NOTE_STUB, assertNotLocked, assertNotLockedText, buildLockedNoteText,
  hasHiddenMark, hasLockMark, isHiddenNoteText, isLockedNoteText, looksLockedNoteText, looksProtectedNoteText,
  noteForReader, noteProtection, parseLockedNote, readableNoteText, withHiddenMark, withoutHiddenMark,
} from '../../../src/core/notes/locked-note.js'
import { parseFrontmatter, withNoteId } from '../../../src/core/parse-frontmatter.js'
import { isHiddenNote, isLockedNote } from '../../../web/src/components/notes/locked-note'
import { splitFrontmatter } from '../../../web/src/components/notes/frontmatter'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const envelope = { key: 'item-1', iv: 'AAAAAAAAAAAAAAAA', ct: 'YWJjZGVmZ2hpams=' }
const LINE = `<!-- walnut-locked-note v1 ${JSON.stringify(envelope)} -->`
const LOCKED = buildLockedNoteText({ id: 'n_abc123', envelope })

/** A writer's two checks: on the bytes there now (423) and on new text (400). */
function writersRefuse(text: string): void {
  expect(() => assertNotLocked(text)).toThrow(expect.objectContaining({ status: 423, code: 'note_locked' }))
  expect(() => assertNotLockedText(text)).toThrow(expect.objectContaining({ status: 400, code: 'locked_note_text' }))
}

function plainEverywhere(text: string): void {
  expect(isLockedNoteText(text)).toBe(false)
  expect(looksLockedNoteText(text)).toBe(false)
  expect(looksProtectedNoteText(text)).toBe(false)
  expect(noteProtection(text)).toBeNull()
  expect(parseLockedNote(text)).toBeNull()
  expect(readableNoteText(text)).toBe(text)
  expect(noteForReader(text)).toEqual({ content: text })
  expect(() => assertNotLocked(text, 'change', text)).not.toThrow()
  const split = splitFrontmatter(text)
  expect(isLockedNote(split.frontmatter, split.body)).toBe(false)
  expect(isHiddenNote(split.frontmatter)).toBe(false)
}

describe('locked-note format', () => {
  it('builds a file that parses back to its envelope, id and stub', () => {
    expect(isLockedNoteText(LOCKED)).toBe(true)
    const p = parseLockedNote(LOCKED)
    expect(p).toMatchObject({ envelope, id: 'n_abc123' })
    expect(p!.stub).toContain(LOCKED_NOTE_STUB)
    expect(p!.stub).toContain('walnut_locked: 1')
    expect(p!.stub).not.toContain('walnut-locked-note v1')
    expect(readableNoteText(LOCKED)).toBe(p!.stub)
    // The web reads the stub the server answers by the same mark.
    const split = splitFrontmatter(p!.stub)
    expect(isLockedNote(split.frontmatter, split.body)).toBe(true)
    writersRefuse(LOCKED)
  })

  it('leaves every other note as it is', () => {
    for (const t of ['', '# Plain\n', '---\nid: n_x\n---\nbody', 'mentions <!-- walnut-locked-note v1 in a sentence -->', `  ${LINE}`, `# Notes\n\n${LINE}\n`]) {
      plainEverywhere(t)
    }
    expect(isLockedNoteText(null)).toBe(false)
    expect(looksLockedNoteText(undefined)).toBe(false)
  })

  it('counts an envelope it cannot read as locked, so nothing writes over it', () => {
    for (const line of [
      '<!-- walnut-locked-note v2 {"key":"k","iv":"AA==","ct":"AA=="} -->',
      '<!-- walnut-locked-note v1 {not json} -->',
      '<!-- walnut-locked-note v1 {"key":"k","iv":"not base64!","ct":"AA=="} -->',
    ]) {
      const text = `---\nid: n_q\nwalnut_locked: 1\n---\nstub\n\n${line}\n`
      expect(isLockedNoteText(text)).toBe(true)
      expect(parseLockedNote(text)).toMatchObject({ envelope: null, id: 'n_q' })
      expect(readableNoteText(text)).not.toContain('walnut-locked-note')
      writersRefuse(text)
    }
  })

  it('refuses an envelope that would break its own line', () => {
    expect(() => buildLockedNoteText({ envelope: { ...envelope, key: 'a"b' } })).toThrow()
    expect(() => buildLockedNoteText({ envelope: { ...envelope, ct: 'x-->y' } })).toThrow()
  })
})

describe('the mark is read in the first frontmatter block only (X2)', () => {
  it('a plain note that quotes the mark and the envelope below its frontmatter stays plain', () => {
    for (const t of [
      // The X2 probe: the old pattern ran past the first block to a later `---` line.
      `---\nid: n_doc\n---\n# How it looks\n\nwalnut_locked: 1\n---\n\n${LINE}\n`,
      // The doc's example in a code block, envelope line last inside it.
      `---\nid: n_doc\n---\n# Locked notes\n\n\`\`\`\n---\nid: n_x\nwalnut_locked: 1\n---\n**Locked note.** ...\n\n${LINE}\n\`\`\`\n`,
      // No frontmatter at all: the example pasted below a heading.
      `# Example\n---\nwalnut_locked: 1\n---\n${LINE}\n`,
      // A frontmatter that names other values of the key is not marked.
      `---\nwalnut_locked: 10\n---\n${LINE}\n`,
      `---\nwalnut_locked: 0\nnote: walnut_locked: 1 is the mark\n---\nbody\n`,
      // The same for the hidden mark: in the body, under a heading, or another value.
      `---\nid: n_doc\n---\n# How it looks\n\nwalnut_hidden: 1\n---\n`,
      `# Example\n---\nwalnut_hidden: 1\n---\nbody\n`,
      `---\nwalnut_hidden: 10\n---\nbody\n`,
      `---\nwalnut_hidden: 0\nnote: walnut_hidden: 1 is the mark\n---\nbody\n`,
      `---\nwalnut_hidden: true\n---\nbody\n`,
    ]) plainEverywhere(t)
  })

  it('the doc page itself, as a plain note\'s body, is plain and writable', () => {
    const doc = fs.readFileSync(path.join(root, 'docs/reference/locked-notes.md'), 'utf8')
    expect(doc).toContain('walnut_locked: 1')
    expect(doc).toContain('walnut_hidden: 1')
    expect(doc).toContain('<!-- walnut-locked-note v1')
    const stamped = withNoteId(doc, null).content
    for (const t of [doc, stamped, stamped.replace(/\n/g, '\r\n'), `---\nid: n_doc\ntags: [docs]\n---\n${doc}`]) plainEverywhere(t)
  })
})

describe('a file an outside editor bent still refuses every writer (S6)', () => {
  const body = `${LOCKED_NOTE_STUB}\n\n`
  const head = (mark = 'walnut_locked: 1') => `---\nid: n_bent\n${mark}\n---\n`
  const cases: Array<[string, string, boolean]> = [
    // [what, text, still read as locked (strict)]
    ['a BOM', `\uFEFF${LOCKED}`, true],
    ['an indented envelope line', `${head()}${body}    ${LINE}\n`, true],
    ['the mark quoted "1"', `${head('walnut_locked: "1"')}${body}${LINE}\n`, true],
    ["the mark quoted '1'", `${head("walnut_locked: '1'")}${body}${LINE}\n`, true],
    ['spaces around the mark', `${head('  walnut_locked :  1  ')}${body}${LINE}\n`, true],
    ['CRLF line ends', LOCKED.replace(/\n/g, '\r\n'), true],
    ['text after the envelope on its line', `${head()}${body}${LINE} trailing words\n`, false],
    ['a line written after the envelope', `${head()}${body}${LINE}\nTyped later in another editor.\n`, false],
    ['the envelope line cut', `${head()}${body}<!-- walnut-locked-note v1 {"key":"item-1","iv":"AAAA\n`, false],
    ['no envelope at all', `${head()}${body}`, false],
  ]
  for (const [what, text, strict] of cases) {
    it(what, () => {
      expect(looksLockedNoteText(text)).toBe(true)
      expect(hasLockMark(text)).toBe(true)
      expect(isLockedNoteText(text)).toBe(strict)
      writersRefuse(text)
      const split = splitFrontmatter(text.replace(/^\uFEFF/, ''))
      expect(isLockedNote(split.frontmatter, split.body)).toBe(true)
      if (strict) {
        const stub = readableNoteText(text)
        expect(stub).not.toContain('walnut-locked-note')
        expect(stub).not.toContain(envelope.ct)
        expect(stub.startsWith('\uFEFF')).toBe(false)
        expect(stub).toContain('**Locked note.**')
      }
    })
  }
})

describe('two envelopes (N3)', () => {
  it('no envelope line reaches a reader; the last one is the note\'s', () => {
    const other = { key: 'item-2', iv: 'BBBBBBBBBBBBBBBB', ct: 'c2Vjb25kY2lwaGVy' }
    const text = `---\nid: n_two\nwalnut_locked: 1\n---\n${LOCKED_NOTE_STUB}\n\n${LINE}\n\n<!-- walnut-locked-note v1 ${JSON.stringify(other)} -->\n`
    const p = parseLockedNote(text)
    expect(p).toMatchObject({ envelope: other, id: 'n_two' })
    const stub = readableNoteText(text)
    for (const s of [envelope.ct, other.ct, 'walnut-locked-note']) expect(stub).not.toContain(s)
    expect(stub).toBe(`---\nid: n_two\nwalnut_locked: 1\n---\n${LOCKED_NOTE_STUB}\n`)
  })
})

const SECRET = 'okapi private words'
const HIDDEN = `---\nid: n_hid\ntags: [journal]\nwalnut_hidden: 1\n---\n# Diary\n\n${SECRET}\n`

describe('a hidden note (plain text, only the person reads and writes it)', () => {
  it('is read by every reader but the person as its frontmatter and the hidden stub', () => {
    expect(hasHiddenMark(HIDDEN)).toBe(true)
    expect(noteProtection(HIDDEN)).toBe('hidden')
    expect(isHiddenNoteText(HIDDEN)).toBe(true)
    expect(looksProtectedNoteText(HIDDEN)).toBe(true)
    expect(isLockedNoteText(HIDDEN)).toBe(false)
    const stub = readableNoteText(HIDDEN)
    expect(stub).toBe(`---\nid: n_hid\ntags: [journal]\nwalnut_hidden: 1\n---\n${HIDDEN_NOTE_STUB}\n`)
    expect(stub).not.toContain(SECRET)
    expect(stub).not.toContain('Diary')
    expect(noteForReader(HIDDEN)).toEqual({ content: stub, hidden: true })
    // The stub parses: the index keeps the id and tags, the web reads the mark from it.
    expect(parseFrontmatter(stub).data).toMatchObject({ id: 'n_hid', tags: ['journal'], walnut_hidden: 1 })
    expect(parseFrontmatter(stub).body.startsWith(HIDDEN_STUB_LEAD)).toBe(true)
    const split = splitFrontmatter(stub)
    expect(isHiddenNote(split.frontmatter)).toBe(true)
    expect(isLockedNote(split.frontmatter, split.body)).toBe(false)
  })

  it('takes the mark in the forms the lock mark takes, with a BOM, CRLF, or no newline after the block', () => {
    const head = (mark: string) => `---\nid: n_q\n${mark}\n---\n${SECRET}\n`
    for (const text of [
      head('walnut_hidden: "1"'), head("walnut_hidden: '1'"), head('"walnut_hidden": 1'), head('  walnut_hidden :  1  # private'),
      `\uFEFF${HIDDEN}`, HIDDEN.replace(/\n/g, '\r\n'), `---\nwalnut_hidden: 1\n---`,
    ]) {
      expect(noteProtection(text), text).toBe('hidden')
      const stub = readableNoteText(text)
      expect(stub).not.toContain(SECRET)
      expect(stub.startsWith('\uFEFF')).toBe(false)
      expect(stub).toContain(HIDDEN_STUB_LEAD)
      expect(parseFrontmatter(stub).hasFrontmatter).toBe(true)
    }
    expect(readableNoteText(HIDDEN.replace(/\n/g, '\r\n'))).toBe(`---\r\nid: n_hid\r\ntags: [journal]\r\nwalnut_hidden: 1\r\n---\r\n${HIDDEN_NOTE_STUB}\r\n`)
  })

  it('with both marks it is a locked note: the lock wins, and a bent one shows no body either', () => {
    const both = buildLockedNoteText({ id: 'n_both', envelope }).replace('walnut_locked: 1', 'walnut_locked: 1\nwalnut_hidden: 1')
    expect(noteProtection(both)).toBe('locked')
    expect(isHiddenNoteText(both)).toBe(false)
    expect(noteForReader(both)).toMatchObject({ locked: true })
    writersRefuse(both)
    // The mark with no envelope as its last line (an outside editor's work) and the hidden mark.
    const bent = `---\nid: n_bent\nwalnut_locked: 1\nwalnut_hidden: 1\n---\n${SECRET}\n`
    expect(noteProtection(bent)).toBe('locked')
    expect(readableNoteText(bent)).not.toContain(SECRET)
    writersRefuse(bent)
  })

  it('refuses every writer but the person, and the person\'s text keeps the mark', () => {
    expect(() => assertNotLocked(HIDDEN)).toThrow(expect.objectContaining({ status: 423, code: 'note_hidden' }))
    expect(() => assertNotLocked(HIDDEN, 'change', HIDDEN)).toThrow(expect.objectContaining({ code: 'note_hidden' }))
    expect(() => assertNotLockedText(HIDDEN)).toThrow(expect.objectContaining({ status: 400, code: 'hidden_note_text' }))
    // A plain note given the mark by anyone but the person: only the person hides a note.
    expect(() => assertNotLocked('# plain\n', 'change', HIDDEN)).toThrow(expect.objectContaining({ code: 'hidden_note_text' }))
    const person = { person: true }
    expect(() => assertNotLocked(HIDDEN, 'change', `${HIDDEN}more\n`, person)).not.toThrow()
    expect(() => assertNotLocked('# plain\n', 'change', HIDDEN, person)).not.toThrow()
    expect(() => assertNotLocked(HIDDEN, 'be deleted', undefined, person)).not.toThrow()
    // The person's save that lost the mark (an editor that dropped the frontmatter) never unhides it.
    expect(() => assertNotLocked(HIDDEN, 'change', `# Diary\n\n${SECRET}\n`, person)).toThrow(expect.objectContaining({ status: 409, code: 'hidden_mark_kept' }))
    // And the person never writes a locked note's file either.
    expect(() => assertNotLocked(HIDDEN, 'change', buildLockedNoteText({ envelope }), person)).toThrow(expect.objectContaining({ code: 'locked_note_text' }))
  })

  it('Hide adds the mark at the end of the first block (a new block when none) and Unhide takes it out', () => {
    const cases = [
      '# No frontmatter\n\nbody\n',
      '---\nid: n_x\ntags: [a]\n---\nbody\n',
      '---\r\nid: n_x\r\n---\r\nbody\r\n',
      '\uFEFF---\nid: n_bom\n---\nbody\n',
      '---\nid: n_x\n---',
      '',
    ]
    for (const plain of cases) {
      const hidden = withHiddenMark(plain)
      expect(noteProtection(hidden), JSON.stringify(plain)).toBe('hidden')
      expect(withHiddenMark(hidden)).toBe(hidden)
      expect(withoutHiddenMark(hidden), JSON.stringify(plain)).toBe(plain)
      expect(withoutHiddenMark(plain)).toBe(plain)
    }
    expect(withHiddenMark('---\nid: n_x\ntags: [a]\n---\nbody\n')).toBe('---\nid: n_x\ntags: [a]\nwalnut_hidden: 1\n---\nbody\n')
    expect(withHiddenMark('---\r\nid: n_x\r\n---\r\nbody\r\n')).toBe('---\r\nid: n_x\r\nwalnut_hidden: 1\r\n---\r\nbody\r\n')
    // Every form of the mark goes, and only from the first block.
    expect(withoutHiddenMark(`---\nid: n_x\nwalnut_hidden: '1'\n"walnut_hidden": 1\n---\nwalnut_hidden: 1\n`)).toBe('---\nid: n_x\n---\nwalnut_hidden: 1\n')
  })
})

describe('the parse costs nothing on a large CRLF note (X1)', () => {
  const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join('\r\n')
  const variants: Array<[string, string]> = [
    // The X1 trigger: a block that never closes, CRLF, and the envelope named.
    ['an unclosed CRLF block', `---\r\n${lines(200, (i) => (i % 2 ? `key${i}: value ${i}` : 'walnut_locked: 1'))}\r\n${LINE}\r\n`],
    ['a CRLF note quoting the envelope and the mark', `---\r\nid: n_crlf\r\n---\r\n${lines(200, (i) => (i % 3 === 0 ? LINE : i % 3 === 1 ? 'walnut_locked: 1' : '---'))}\r\n`],
    ['a CRLF locked note with a long stub', `---\r\nid: n_crlf\r\nwalnut_locked: 1\r\n---\r\n${lines(200, (i) => `stub line ${i}`)}\r\n\r\n${LINE}\r\n`],
    ['a long whitespace run', `---\r\nwalnut_locked: 1\r\n---\r\n${' '.repeat(200_000)}x\r\n${LINE}\r\n`],
    // The hidden mark: an unclosed CRLF block naming it, a large CRLF hidden note, and both marks.
    ['an unclosed CRLF block naming the hidden mark', `---\r\n${lines(200, (i) => (i % 2 ? `key${i}: value ${i}` : 'walnut_hidden: 1'))}\r\n`],
    ['a large CRLF hidden note', `---\r\nid: n_crlf\r\nwalnut_hidden: 1\r\n---\r\n${lines(20_000, (i) => `private line ${i} walnut_hidden: 1`)}\r\n`],
    ['a CRLF note with both marks', `---\r\nwalnut_hidden: 1\r\nwalnut_locked: 1\r\n---\r\n${lines(200, (i) => (i % 2 ? LINE : '---'))}\r\n`],
  ]
  for (const [what, text] of variants) {
    it(`${what} is judged in under 50 ms`, () => {
      const t0 = performance.now()
      isLockedNoteText(text)
      looksLockedNoteText(text)
      parseLockedNote(text)
      readableNoteText(text)
      noteForReader(text)
      withoutHiddenMark(withHiddenMark(text))
      try { assertNotLocked(text, 'change', text) } catch { /* the verdict is not the point here */ }
      try { assertNotLocked(text, 'change', text, { person: true }) } catch { /* the verdict is not the point here */ }
      expect(performance.now() - t0).toBeLessThan(50)
    })
  }

  it('no regex in the format or its guards nests a quantifier or scans the whole text', () => {
    const problems: string[] = []
    for (const rel of ['src/core/notes/locked-note-format.ts', 'src/core/notes/locked-note.ts']) {
      const src = fs.readFileSync(path.join(root, rel), 'utf8')
      if (/\bnew RegExp\(/.test(src)) problems.push(`${rel}: builds a RegExp at run time`)
      const file = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true)
      const visit = (node: ts.Node): void => {
        if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
          const lit = node.getText(file)
          const body = lit.slice(1, lit.lastIndexOf('/'))
          const flags = lit.slice(lit.lastIndexOf('/') + 1)
          if (nestsQuantifier(body)) problems.push(`${rel}: ${lit} nests a quantifier (it can backtrack for ever)`)
          if (flags.includes('m') || body.includes('[\\s\\S]')) problems.push(`${rel}: ${lit} runs over many lines`)
        }
        ts.forEachChild(node, visit)
      }
      visit(file)
    }
    expect(problems).toEqual([])
  })

  it('the quantifier check catches the pattern that froze the server', () => {
    expect(nestsQuantifier(String.raw`^---\r?\n(?:[^\n]*\r?\n)*?walnut_locked:[ \t]*1`)).toBe(true)
    expect(nestsQuantifier('(a+)+b')).toBe(true)
    expect(nestsQuantifier('((ab)*c)*')).toBe(true)
    expect(nestsQuantifier(String.raw`^(["']?)walnut_locked\1[ \t]*:`)).toBe(false)
    expect(nestsQuantifier('^[A-Za-z0-9+/]+={0,2}$')).toBe(false)
    expect(nestsQuantifier('(a*)?b')).toBe(false)
  })
})

/** Whether a regex source repeats a group that itself holds a repetition (`(x*)*`, `(x+){2,}`). */
function nestsQuantifier(src: string): boolean {
  const repeats = (i: number): boolean => src[i] === '*' || src[i] === '+' || (src[i] === '{' && /^\{\d+,\d*\}/.test(src.slice(i)))
  const stack: boolean[] = [false]
  let inClass = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') { i++; continue }
    if (inClass) { if (c === ']') inClass = false; continue }
    if (c === '[') inClass = true
    else if (c === '(') stack.push(false)
    else if (c === ')') {
      const inner = stack.pop() ?? false
      if (inner && repeats(i + 1)) return true
      if (inner || repeats(i + 1)) stack[stack.length - 1] = true
    } else if (repeats(i)) stack[stack.length - 1] = true
  }
  return false
}
