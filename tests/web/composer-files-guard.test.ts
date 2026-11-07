/**
 * Every composer whose words go to a session takes any file (a log, a PDF, a
 * zip), not only pictures: it hands ChatInput a `fileTarget` (the session whose
 * host keeps the file, or `{}` before a session exists). A box that stays
 * pictures-only is listed here with why, so a new composer fails until it is
 * decided.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const WEB_SRC = path.resolve(import.meta.dirname, '../../web/src')

/** Files drawing a ChatInput that take pictures only, and why. */
const PICTURES_ONLY: Record<string, string> = {
  'components/chat/PluginChatView.tsx': "a plugin's own chat agent through the chat RPC, not a session with a host to keep files",
  'components/notes/NotesChat.tsx': "the notes assistant's chat RPC, not a session with a host to keep files",
  'components/board/BoardReplyDock.tsx': "a Board thread's reply, posted to the thread route that keeps pictures only",
  'components/sessions/SideQuestionDrawer.tsx': 'a side question starts its own thread through the side-thread route, which takes pictures inline',
  'components/tasks/AgentSearchFollowUp.tsx': 'a follow-up to one search answer, a short question about rows already shown',
  'components/notes/NotesSessionChat.tsx': 'the notes page chat keeps sends locally until its session exists, and that queue holds pictures only',
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (/\.(tsx|jsx)$/.test(e.name)) out.push(path.relative(WEB_SRC, full))
  }
  return out
}
const read = (rel: string) => fs.readFileSync(path.join(WEB_SRC, rel), 'utf8')

/** Each `<ChatInput ...>` opening, up to its closing `>` at depth 0 of braces. */
function chatInputsOf(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/<ChatInput\b/g)) {
    let depth = 0
    let i = m.index! + m[0].length
    for (; i < src.length; i++) {
      const c = src[i]
      if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0) break
    }
    out.push(src.slice(m.index!, i + 1))
  }
  return out
}

const chatFiles = walk(WEB_SRC).filter((f) => f !== 'components/chat/ChatInput.tsx' && /<ChatInput\b/.test(read(f)))

describe('every session composer takes any file', () => {
  it('finds the composers', () => {
    expect(chatFiles.length).toBeGreaterThan(8)
  })

  it.each(chatFiles)('%s: each ChatInput takes files, or the file says why not', (rel) => {
    if (PICTURES_ONLY[rel]) return
    const without = chatInputsOf(read(rel)).filter((t) => !/\bfileTarget=/.test(t))
    expect(without, `${rel}: pass fileTarget={{ sessionId }} (or {} before a session exists), or list it in PICTURES_ONLY with why`).toEqual([])
  })

  it('every pictures-only box listed still exists and still draws a ChatInput without files', () => {
    for (const rel of Object.keys(PICTURES_ONLY)) {
      expect(fs.existsSync(path.join(WEB_SRC, rel)), rel).toBe(true)
      expect(chatInputsOf(read(rel)).some((t) => !/\bfileTarget=/.test(t)), `${rel} takes files now: drop it from the list`).toBe(true)
    }
  })

  it('the session panel, the dock and a new session take files', () => {
    for (const rel of ['components/sessions/SessionPanel.tsx', 'components/sessions/DraftSessionPanel.tsx', 'components/dock/FocusDock.tsx', 'components/sessions/TreeSplitLeft.tsx']) {
      expect(chatInputsOf(read(rel)).every((t) => /\bfileTarget=/.test(t)), rel).toBe(true)
    }
  })
})
