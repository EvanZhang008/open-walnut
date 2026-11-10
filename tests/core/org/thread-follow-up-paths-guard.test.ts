/**
 * Every way a person's message reaches an Org node's chat either carries the thread a Follow up
 * names, or says why it has none (2026-11-10, the user: "我是在thread里回复的应该是 为啥没有
 * context"; his phone's Follow up went through the companion, whose relay carried the words alone,
 * so the Mac filed it as a new thread). The thread is filed in `prepareHintedSend`; this lists every
 * call of it in src/ and fails on a new one nobody classified, and on a classified one that stops
 * reading the thread the way its entry says.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../..')

type How =
  /** The request body's `threadId` (the primary box's send route). */
  | { carries: 'body'; mustContain: RegExp }
  /** The console's WS `session:send` `threadId`. */
  | { carries: 'ws'; mustContain: RegExp }
  /** The companion's relay: the thread the phone announced for the message id. */
  | { carries: 'announced'; mustContain: RegExp }
  /** No Follow up can come this way. */
  | { carries: 'none'; why: string }

const CALLS: Record<string, How> = {
  'src/web/routes/session-send-v1.ts': { carries: 'body', mustContain: /threadIdOf\(req\.body\?\.threadId\)/ },
  'src/web/routes/session-chat.ts': { carries: 'ws', mustContain: /data\.threadId/ },
  'src/providers/daemon-connection.ts': { carries: 'announced', mustContain: /followUpIntentFor\(record\.taskId, messageId\)[\s\S]{0,400}threadKey: messageId/ },
  'src/core/hints/hint-send.ts': { carries: 'none', why: 'the queue path for automated sources (routines, the wait clock, peers): no person typed a Follow up' },
  'src/core/sessions/side-thread-manager.ts': { carries: 'none', why: 'a side question files nothing (threads: false)' },
  'src/web/routes/quick-input-v1.ts': { carries: 'none', why: 'a launcher on the Mac sends into a task with no thread card' },
}

function callSites(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(e.name)) {
        const src = fs.readFileSync(p, 'utf8')
        // A call, not the definition (`export async function prepareHintedSend(`).
        if (/(?<!function )prepareHintedSend\(/.test(src.replace(/export async function prepareHintedSend\(/, ''))) out.push(path.relative(ROOT, p))
      }
    }
  }
  walk(path.join(ROOT, 'src'))
  return out.sort()
}

describe('a thread Follow up keeps its thread on every send path', () => {
  it('every call of prepareHintedSend is classified', () => {
    const found = callSites()
    const missing = found.filter((f) => !(f in CALLS))
    expect(missing, `classify these send paths in CALLS (does a Follow up's thread reach them?): ${missing.join(', ')}`).toEqual([])
    const gone = Object.keys(CALLS).filter((f) => !found.includes(f))
    expect(gone, 'listed but no longer calling prepareHintedSend: drop them').toEqual([])
  })

  it('each path that carries the thread still reads it', () => {
    for (const [file, how] of Object.entries(CALLS)) {
      if (how.carries === 'none') continue
      expect(fs.readFileSync(path.join(ROOT, file), 'utf8'), `${file} (${how.carries})`).toMatch(how.mustContain)
    }
  })

  it('the companion relay that drops the thread is paired with the announcement route', () => {
    const relay = fs.readFileSync(path.join(ROOT, 'src/web/routes/cloud-session-send.ts'), 'utf8')
    // The relay carries the words alone; if it ever carries a thread of its own, this pairing can go.
    expect(relay).toMatch(/bridgeRequest\(host, 'session\.message', \{\s*sessionId, message: text, messageId, stopFence,\s*\}/)
    const routes = fs.readFileSync(path.join(ROOT, 'src/web/routes/org-threads-v1.ts'), 'utf8')
    expect(routes).toMatch(/\.put\('\/tasks\/:id\/threads\/:thread\/follow-ups\/:messageId'/)
  })

  it('the phone announces the thread before it sends, under the same message id', () => {
    const store = fs.readFileSync(path.join(ROOT, 'ios-native/Walnut/Views/Org/OrgThreadsStore.swift'), 'utf8')
    const body = store.slice(store.indexOf('func followUp('))
    const announce = body.indexOf('announceThreadFollowUp(taskId: taskId, threadId: threadId, messageId: messageId)')
    const send = body.indexOf('sendThreadFollowUp(')
    expect(announce).toBeGreaterThan(0)
    expect(send).toBeGreaterThan(announce)
    expect(body.slice(send, send + 300)).toMatch(/messageId: messageId\)/)
  })
})
