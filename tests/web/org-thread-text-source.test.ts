/**
 * An Org thread's text opens on the machine of whoever wrote each block (2026-11-07: a summary's
 * path and an answer's picture were read on the node's current machine; another session on another
 * host wrote them). web/src/components/org/thread-text-source.ts names each block's writer from what
 * the server recorded (src/core/org/threads-model.ts); nothing is guessed from the node's current
 * session or from a message's own `sid`.
 *
 * Guard: fails when
 *  - a block of text in OrgThreads.tsx renders without its own recorded source (a new AgentText,
 *    RichMarkdown or Answer that names none, or one that names the node's task again);
 *  - the list around the blocks opens a path from anything but an unknown source;
 *  - the server writes a summary outside setReply, records a writer from the request body, calls a
 *    thread write without the verified source, or keeps a letter answer's writer from anything but
 *    its turn.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { renderContextOf, sourceHostOf } from '../../web/src/utils/agent-text-source'
import {
  THREAD_LIST_SOURCE, THREAD_WORDS_SOURCE, threadAnswerSource, threadOpenerSource, threadSummarySource,
} from '../../web/src/components/org/thread-text-source'

const read = (rel: string) => fs.readFileSync(path.resolve(rel), 'utf-8')
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
const noPeek = () => null

describe('each block names the writer the server recorded', () => {
  it('a summary: the user is the primary, a recorded session is that session, an older one is unknown', () => {
    expect(threadSummarySource({ reply_by: 'human' })).toEqual({ host: '__local__' })
    expect(threadSummarySource({ reply_by: 'task:lead', reply_sid: 'sid-a', reply_host: 'devbox' })).toEqual({ sessionId: 'sid-a', host: 'devbox' })
    expect(threadSummarySource({ reply_by: 'task:lead', reply_sid: 'sid-a' })).toEqual({ sessionId: 'sid-a' })
    // Written before the writer was recorded, or by a caller Walnut could not place: unknown.
    for (const t of [{}, { reply_by: 'agent' }, { reply_by: 'task:lead' }]) expect(threadSummarySource(t)).toEqual({ unknownSource: true })
  })

  it('an answer: the session it was read from, else unknown (never the message\'s sid)', () => {
    expect(threadAnswerSource({ text: 'a', at: 'x', sid: 'sid-read', host: 'devbox' })).toEqual({ sessionId: 'sid-read', host: 'devbox' })
    expect(threadAnswerSource({ text: 'a', at: 'x', from: 'letter' })).toEqual({ unknownSource: true })
    // A plugin's letter turn with its host recorded opens on that host, with no session to read.
    const plugin = threadAnswerSource({ text: 'a', at: 'x', from: 'letter', sid: 'external', host: 'devbox' })
    expect(sourceHostOf(plugin)).toEqual({ kind: 'host', host: 'devbox' })
    expect(renderContextOf(plugin, noPeek)).toEqual({ host: 'devbox', images: true })
    expect(threadAnswerSource({ text: 'a', at: 'x' })).toEqual({ unknownSource: true })
  })

  it('a first post: the user\'s is the primary, else its recorded session, else unknown', () => {
    expect(threadOpenerSource({ text: 'a', at: 'x', from: 'mail', by: 'human' })).toEqual({ host: '__local__' })
    expect(threadOpenerSource({ text: 'a', at: 'x', from: 'mail', by: 'task:lead', sid: 'sid-o', host: 'devbox' })).toEqual({ sessionId: 'sid-o', host: 'devbox' })
    expect(threadOpenerSource({ text: 'a', at: 'x', from: 'mail', by: 'task:lead' })).toEqual({ unknownSource: true })
  })

  it('his words are the primary\'s, and a picture in them loads here; an unknown block loads none', () => {
    expect(sourceHostOf(THREAD_WORDS_SOURCE)).toEqual({ kind: 'host' })
    expect(renderContextOf(THREAD_WORDS_SOURCE, noPeek)).toEqual({ images: true })
    // An older summary: no picture loads and no machine is picked; the click says why.
    expect(sourceHostOf(threadSummarySource({}))).toEqual({ kind: 'unknown' })
    expect(renderContextOf(threadSummarySource({}), noPeek)).toEqual({ images: false })
    // A remote answer: its pictures load from its host, with no session read.
    expect(renderContextOf(threadAnswerSource({ text: 'a', at: 'x', sid: 'sid-r', host: 'devbox' }), noPeek)).toEqual({ host: 'devbox', images: true })
    expect(sourceHostOf(THREAD_LIST_SOURCE)).toEqual({ kind: 'unknown' })
  })
})

describe('guard: every text block in OrgThreads.tsx opens from its own writer', () => {
  const src = code('web/src/components/org/OrgThreads.tsx')
  /** Every JSX element `<Name ...>` up to its own end, attributes and all. */
  const elements = (name: string) => [...src.matchAll(new RegExp(`<${name}\\b([\\s\\S]*?)\\/?>`, 'g'))].map((m) => m[1])

  it('the blocks are the ones listed, each with its source', () => {
    const agentText = elements('AgentText')
    // The summary, Walnut's stand-in line and his words; a new AgentText must be listed here with its writer.
    expect(agentText).toHaveLength(3)
    expect(agentText.filter((a) => /\{\.\.\.threadSummarySource\(t\)\}/.test(a))).toHaveLength(1)
    expect(agentText.filter((a) => /\{\.\.\.threadStandInSource\(t, card\.summary\)\}/.test(a))).toHaveLength(1)
    expect(agentText.filter((a) => /\{\.\.\.THREAD_WORDS_SOURCE\}/.test(a))).toHaveLength(1)
    for (const a of agentText) expect(a, 'never the node\'s own task as the writer').not.toMatch(/\btask=|\bowner\b|\bsessionId=/)

    const rich = elements('RichMarkdown')
    expect(rich).toHaveLength(1)
    expect(rich[0]).toMatch(/host=\{file\.render\.host\}/)
    expect(rich[0]).toMatch(/inlineImages=\{file\.render\.images\}/)
    expect(rich[0]).toMatch(/onClick=\{onClick\}/)

    const answers = elements('Answer')
    // The first post (card and conversation) and the node's answers (card and conversation).
    expect(answers).toHaveLength(4)
    for (const a of answers) expect(a).toMatch(/source=\{thread(Answer|Opener)Source\((x\.answer!?|t\.opener)\)\}/)
  })

  it('the file openers are the block\'s own and the list\'s unknown one; no HTML is set by hand', () => {
    const openers = [...src.matchAll(/useAgentFileOpener\(([^)]*)\)/g)].map((m) => m[1].trim())
    expect(openers.sort()).toEqual(['THREAD_LIST_SOURCE', 'source'])
    expect(src).not.toMatch(/dangerouslySetInnerHTML/)
    // The Answer keeps its click: the list never handles the same link a second time.
    expect(src).toMatch(/onEntityClick\(e\);\s*\n?\s*(\/\/[^\n]*\n\s*)?if \(\(e\.target as HTMLElement\)\.closest\('a'\)\) e\.stopPropagation\(\);/)
  })
})

describe('guard: the server records each writer from Walnut\'s own record only', () => {
  const model = code('src/core/org/threads-model.ts')
  const route = code('src/web/routes/org-threads-v1.ts')
  const answers = code('src/core/org/thread-answers.ts')
  const bodyOf = (src: string, name: string) => {
    const start = src.indexOf(`function ${name}(`)
    expect(start, name).toBeGreaterThanOrEqual(0)
    let depth = 0
    // The body's brace ends its line; a return type's `{ ... }` does not.
    for (let i = src.indexOf('{\n', start); i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
    }
    throw new Error(`no body for ${name}`)
  }

  it('a summary and its writer are written in setReply alone (and read back in normalizeReplySource)', () => {
    let rest = model
    for (const fn of ['setReply', 'normalizeReplySource']) rest = rest.replace(bodyOf(model, fn), '')
    expect(rest).not.toMatch(/\.reply\s*=[^=]/)
    expect(rest).not.toMatch(/\.reply_(by|sid|host)\s*=[^=]/)
    expect(bodyOf(model, 'updateThread')).toMatch(/if \(text !== cur\.reply\) setReply\(next, text, by, source\)/)
    expect(bodyOf(model, 'openThread')).toMatch(/verifiedSource\(source\)/)
  })

  it('the route reads no writer from the body, and every write that records one passes the verified source', () => {
    expect(route).not.toMatch(/str\(b, '(sid|host|by|reply_sid|reply_host|reply_by)'\)/)
    expect(route).not.toMatch(/\bb\.(sid|host|by|reply_sid|reply_host|reply_by)\b/)
    expect(route).toMatch(/resolveThreadCaller\(header\(req, 'x-walnut-caller-sid'\)\)/)
    // Every caller of the two writes that record a writer, anywhere in the server.
    const calls: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.ts$/.test(e.name) && p !== path.resolve('src/core/org/threads-store.ts')) {
          for (const m of code(path.relative(process.cwd(), p)).matchAll(/\b(patchThread|openNodeThread)\(([\s\S]*?)\)\s*$/gm)) calls.push(`${path.relative(process.cwd(), p)}: ${m[1]}(${m[2].replace(/\s+/g, ' ')})`)
        }
      }
    }
    walk(path.resolve('src'))
    expect(calls.length).toBeGreaterThanOrEqual(2)
    for (const c of calls) expect(c, c).toMatch(/,\s*by,\s*source\)$/)
  })

  it('an answer\'s writer is the transcript read or the letter turn\'s own sender, never the message\'s sid', () => {
    expect(bodyOf(answers, 'letterAnswerOf')).toMatch(/turnSource\(reply\)/)
    expect(bodyOf(answers, 'letterAnswerOf')).not.toMatch(/\bm\.sid\b/)
    expect(bodyOf(answers, 'answersIn')).toMatch(/answersFromRows\(messages, rows, \{ wholeUntil, source \}\)/)
    expect(bodyOf(answers, 'answersIn')).toMatch(/const source: ThreadTextSource = \{ sid,/)
    expect(answers.match(/from: 'letter'/g) ?? []).toHaveLength(1)
  })
})
