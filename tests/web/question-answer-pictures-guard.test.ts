/**
 * A question's answer and the pictures put with it reach the AI as ONE message (2026-11-03, the
 * user's direction: the answer and its pictures go to the AI as the same message, so the AI never
 * first replies that it sees no picture). The answer is the AskUserQuestion tool's result, so the server puts the pictures in
 * that same result (src/core/answer-pictures.ts withAnswerPictures). Both clients send them in the
 * answer's own request, and nothing sends them as a message after it.
 *
 * The members are read from source: every web and iOS file that answers a permission request,
 * and every server caller of respondSessionPermission. A new path that sends the pictures on
 * their own, or a caller that drops them, fails here.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

function walk(dir: string, ext: RegExp): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...walk(rel, ext)) }
    else if (ext.test(e.name) && !/\.test\./.test(e.name)) out.push(rel)
  }
  return out
}

/** Calls of a respond function, not its definition. */
const callsOf = (src: string, name: string) =>
  src.split('\n').filter((l) => new RegExp(`\\b${name}\\(`).test(l) && !/\b(function|func)\s/.test(l))

const ANSWERERS = /\b(respondToPermission|respondToPermissionRequest|respondPermission|respondSessionPermission)\(/
/** A message that carries pictures and no words: an answer's pictures sent on their own. */
const PICTURES_ALONE = [
  /session:send['"][^\n]*message:\s*''/,
  /sendSessionMessage\([^\n]*message:\s*''/,
  /\.send\(\s*""\s*,\s*images:/,
  /sendAnswerPictures/,
]

const clientFiles = [...walk('web/src', /\.(ts|tsx)$/), ...walk('ios-native/Walnut', /\.swift$/)]
const answering = clientFiles.filter((f) => ANSWERERS.test(read(f)))

describe('a question answer and its pictures are one message', () => {
  it('finds the files that answer a permission request in both clients', () => {
    expect(answering).toEqual(expect.arrayContaining([
      'web/src/stores/permission-request-store.ts',
      'ios-native/Walnut/Views/Sessions/SessionConversationView.swift',
    ]))
  })

  it.each(answering)('%s: sends no pictures on their own', (rel) => {
    const src = read(rel)
    for (const p of PICTURES_ALONE) expect(src, `${rel} matches ${p}`).not.toMatch(p)
  })

  it('both clients put the pictures in the answer request', () => {
    expect(read('web/src/api/sessions.ts')).toMatch(/\/permission`, \{ requestId, allow, message, optionId, answers, \.\.\.pictures \}/)
    const store = read('web/src/stores/permission-request-store.ts')
    expect(callsOf(store, 'respondToPermission').every((l) => /answers, pictures\)/.test(l))).toBe(true)
    expect(read('ios-native/Walnut/API/WalnutAPIWave1.swift')).toMatch(/let images: \[ImagePayload\]\?/)
    const conversation = read('ios-native/Walnut/Views/Sessions/SessionConversationView.swift')
    for (const l of callsOf(conversation, 'respondPermission').filter((l) => /answers:/.test(l))) expect(l).toMatch(/images: /)
    expect(read('ios-native/Walnut/Stores/SessionLifecycleController.swift')).toMatch(/answers: answers, images: images/)
  })

  /** Callers whose answer can carry no pictures, each with why (a new one is named here, never skipped). */
  const WORDS_ONLY: Record<string, string> = {
    'src/core/sessions/ask-settle.ts': 'an answer a lead gives in the user\'s place (task_send answers_ask) is words only: task_send takes no pictures',
  }

  it('every server caller of respondSessionPermission hands it the pictures', () => {
    const callers = walk('src', /\.ts$/).filter((f) => f !== 'src/core/sessions/session-lifecycle.ts' && /respondSessionPermission\(/.test(read(f)))
    expect(callers.length).toBeGreaterThanOrEqual(3)
    for (const [f, why] of Object.entries(WORDS_ONLY)) {
      expect(callers, `${f} is listed as words only (${why}) but no longer answers a prompt`).toContain(f)
      // Still true: the op that reaches it has no pictures to hand on.
      expect(read('src/ops/work.ts'), f).not.toMatch(/\bimage/i)
    }
    for (const f of callers.filter((c) => !WORDS_ONLY[c])) {
      const src = read(f)
      const at = [...src.matchAll(/respondSessionPermission\(/g)].map((m) => m.index!)
      for (const i of at) expect(src.slice(i, i + 260), `${f} drops the pictures`).toMatch(/imageRefs/)
    }
  })

  it('a relayed answer carries its pictures inline (the next box cannot read this one\'s uploads)', () => {
    const route = read('src/web/routes/session-lifecycle-v1.ts')
    expect(route).toMatch(/lead\.control\.permission\(lead\.target, \{ \.\.\.words, \.\.\.\(await relayedPictures\(body\)\) \}\)/)
    expect(route).toMatch(/relayControlAction\(res, 'permission'[\s\S]{0,400}relayedPictures\(body\)/)
  })
})
