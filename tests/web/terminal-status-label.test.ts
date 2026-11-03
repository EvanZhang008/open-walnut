import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createElement } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
import {
  TERMINAL_STATUSES,
  TERMINAL_STATUS_LABEL,
  UNKNOWN_TERMINAL_STATUS_LABEL,
  terminalStatusLabel,
  type TerminalStatus,
} from '../../web/src/hooks/terminal-status-label'
import { TerminalStatusPill } from '../../web/src/components/sessions/TerminalModeNotices'
import { createEndGuard } from '../../web/src/hooks/terminal-end-model'

/**
 * The terminal status pill shows words, never the hook's code (users saw
 * END_UNCONFIRMED and SSH_FAILED). The states are the one list the hook's type
 * is built from, so a new state is checked here without editing this test.
 */
const repoRoot = path.resolve(__dirname, '../..')
const hookSrc = fs.readFileSync(path.join(repoRoot, 'web/src/hooks/useSessionTerminal.ts'), 'utf8')

describe('terminal status labels', () => {
  it('the hook takes its states from the label model, not a union of its own', () => {
    expect(hookSrc).toMatch(/import type \{ TerminalStatus \} from '\.\/terminal-status-label'/)
    expect(hookSrc).not.toMatch(/type TerminalStatus\s*=/)
  })

  it('every state has a plain label and the map has no extra keys', () => {
    expect(Object.keys(TERMINAL_STATUS_LABEL).sort()).toEqual([...TERMINAL_STATUSES].sort())
    for (const status of TERMINAL_STATUSES) {
      const label = TERMINAL_STATUS_LABEL[status]
      expect(label.trim(), status).not.toBe('')
      expect(label, status).not.toContain('_')
      // Never the code itself (a one-word state may share its word, capitalised).
      expect(label, status).not.toBe(status)
      expect(label[0], status).toBe(label[0].toUpperCase())
    }
  })

  it('a value no build knows reads Unknown, never the raw string', () => {
    expect(terminalStatusLabel('reattach_pending')).toBe(UNKNOWN_TERMINAL_STATUS_LABEL)
    expect(terminalStatusLabel(undefined)).toBe(UNKNOWN_TERMINAL_STATUS_LABEL)
    expect(terminalStatusLabel('toString')).toBe(UNKNOWN_TERMINAL_STATUS_LABEL)
  })

  it.each([...TERMINAL_STATUSES])('the pill for %s renders its label, the code only in class and data-status', (status) => {
    const out = renderToStaticMarkup(createElement(TerminalStatusPill, { status }))
    const text = out.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'")
    expect(text).toBe(TERMINAL_STATUS_LABEL[status])
    expect(text).not.toBe(status)
    expect(text).not.toContain('_')
    expect(out).toContain(`data-status="${status}"`)
    expect(out).toContain(`session-terminal-status-${status}`)
    // No other attribute (a title, an aria-label, ...) carries any state's code.
    const attrs = [...out.matchAll(/\s([\w:-]+)="([^"]*)"/g)].map(([, name, value]) => ({ name, value }))
    expect(attrs.map((a) => a.name)).toEqual(expect.arrayContaining(['class', 'data-status']))
    for (const { name, value } of attrs) {
      if (name === 'class' || name === 'data-status') continue
      for (const code of TERMINAL_STATUSES) {
        expect(value.toLowerCase(), `${name}="${value}" carries ${code}`).not.toContain(code)
      }
    }
  })

  it('an unknown runtime value gets the neutral class and the Unknown label', () => {
    const out = renderToStaticMarkup(createElement(TerminalStatusPill, { status: 'reattach_pending' as TerminalStatus }))
    expect(out).toContain('session-terminal-status-unknown')
    expect(out).toContain('>Unknown</span>')
  })
})

describe('End guard', () => {
  it('the hook holds End per generation, not with one boolean', () => {
    expect(hookSrc).toContain('useState(createEndGuard)') // made once, not every render
    expect(hookSrc).toContain('endGuard.take(gen)')
    expect(hookSrc).toContain('endGuard.release(gen)')
    expect(hookSrc).not.toMatch(/endingRef/)
  })

  it('a new generation (reopen or another session) is never blocked by an End still waiting', () => {
    const guard = createEndGuard()
    expect(guard.take(1)).toBe(true)
    expect(guard.take(1)).toBe(false) // one End at a time on the same terminal
    expect(guard.busy(1)).toBe(true)
    // sessionId changed: the hook reopened at generation 3
    expect(guard.busy(3)).toBe(false)
    expect(guard.take(3)).toBe(true)
    // the old End's answer lands 30 s later: it must not free the new hold
    guard.release(1)
    expect(guard.busy(3)).toBe(true)
    expect(guard.take(3)).toBe(false)
    guard.release(3)
    expect(guard.busy(3)).toBe(false)
    expect(guard.take(3)).toBe(true)
  })
})
