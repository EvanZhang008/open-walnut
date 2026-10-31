/**
 * useChat buffers `agent:text-delta` until the next animation frame, but every
 * other event applies at once. Text still in the buffer when a tool call came
 * in the same frame (or while a hidden tab had rAF paused) landed AFTER that
 * tool call and merged into the next round's text: "First, searching." showed
 * behind its own tool, glued to "Now, saving." (tests/e2e/browser/streaming-dedup.spec.ts).
 *
 * The fix: a handler that appends a block or a message, or ends the turn, calls
 * flushTextDelta() before it changes the messages. This ratchet enumerates every
 * useEvent handler in useChat.ts that calls setMessages, and every callback of
 * the hook that appends a message (a send, a local message), so a NEW one that
 * forgets the flush fails here. A handler that only edits an existing block or
 * message in place is listed below with the reason it cannot reorder text.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const SRC = readFileSync(path.join(import.meta.dirname, '../../web/src/hooks/useChat.ts'), 'utf8')

/** Handlers that change messages without appending after the buffered text. */
const IN_PLACE: Record<string, string> = {
  'agent:tool-result': 'marks its own tool block done, in place',
  'agent:subagent-stream': 'appends inside its own tool block, in place',
  '_ws:reconnected': 'replaces the list with the server copy',
  'chat:compacted': 'swaps the compacting placeholder for its divider, in place',
}

/** Every `useEvent('<name>', ...)` handler of the hook with its body (to its 2-space `});`). */
function handlers(src: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = []
  const re = /^ {2}useEvent\('([^']+)'/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const end = src.indexOf('\n  });', m.index)
    out.push({ name: m[1], body: src.slice(m.index, end === -1 ? undefined : end) })
  }
  return out
}

describe('useChat applies buffered text before any later event reorders it', () => {
  const all = handlers(SRC)

  it('finds the handlers it guards', () => {
    const names = all.map((h) => h.name)
    for (const n of ['agent:text-delta', 'agent:tool-call', 'agent:response', 'agent:error']) {
      expect(names).toContain(n)
    }
  })

  it('every handler that changes messages flushes the text first, or is listed as in place', () => {
    const missing: string[] = []
    for (const { name, body } of all) {
      const write = body.indexOf('setMessages(')
      if (write === -1 || name in IN_PLACE) continue
      const flush = body.indexOf('flushTextDelta()')
      if (flush === -1 || flush > write) missing.push(name)
    }
    expect(missing, 'call flushTextDelta() before setMessages, or list the handler in IN_PLACE with its reason').toEqual([])
  })

  it('the turn boundaries flush even though they may not write messages themselves', () => {
    for (const name of ['agent:tool-call', 'agent:response', 'agent:error']) {
      const h = all.find((x) => x.name === name)!
      expect(h.body, name).toContain('flushTextDelta()')
    }
  })

  it('every callback that appends a message flushes the text first', () => {
    const re = /^ {2}const (\w+) = useCallback\(/gm
    const appenders: string[] = []
    const missing: string[] = []
    let m: RegExpExecArray | null
    while ((m = re.exec(SRC))) {
      const end = SRC.indexOf('\n  }, [', m.index)
      const body = SRC.slice(m.index, end === -1 ? undefined : end)
      const write = body.search(/setMessages\(\(prev\) => \[\.\.\.prev|setMessages\(\[\]\)/)
      if (write === -1) continue
      appenders.push(m[1])
      const flush = body.indexOf('flushTextDelta()')
      if (flush === -1 || flush > write) missing.push(m[1])
    }
    expect(appenders).toEqual(expect.arrayContaining(['sendMessage', 'addLocalMessage', 'clearMessages']))
    expect(missing, 'call flushTextDelta() before the message is appended').toEqual([])
  })

  it('the buffered text keeps the turn it started in', () => {
    const delta = all.find((x) => x.name === 'agent:text-delta')!.body
    expect(delta).toMatch(/if \(!textDeltaBuffer\.current\) textDeltaTurn\.current = turnId/)
    const flush = SRC.slice(SRC.indexOf('const flushTextDelta = useCallback('), SRC.indexOf("useEvent('agent:text-delta'"))
    expect(flush).toContain('const turnId = textDeltaTurn.current')
  })

  it('lists no in-place handler that no longer exists', () => {
    const names = new Set(all.map((h) => h.name))
    expect(Object.keys(IN_PLACE).filter((n) => !names.has(n))).toEqual([])
  })
})
