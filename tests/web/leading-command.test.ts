import { describe, expect, it } from 'vitest'
import { keepCommandFirst, splitLeadingCommand } from '../../web/src/components/chat/leading-command'

const CMD = '/walnut-trigger'

describe('splitLeadingCommand', () => {
  it('finds a command that is the first word, followed by a space or nothing', () => {
    expect(splitLeadingCommand('/walnut-trigger watch PR 123')).toEqual({ command: '/walnut-trigger', rest: 'watch PR 123' })
    expect(splitLeadingCommand('/walnut-trigger')).toEqual({ command: '/walnut-trigger', rest: '' })
    expect(splitLeadingCommand('/plugin:skill-name go')).toEqual({ command: '/plugin:skill-name', rest: 'go' })
  })

  it('is null for prose, paths and a command the CLI would not split', () => {
    expect(splitLeadingCommand('watch /walnut-trigger')).toBeNull()
    expect(splitLeadingCommand('/Users/a/b.ts is broken')).toBeNull()
    expect(splitLeadingCommand('/walnut-trigger\nwatch')).toBeNull()
    expect(splitLeadingCommand('/ nothing')).toBeNull()
    expect(splitLeadingCommand('')).toBeNull()
  })
})

describe('keepCommandFirst', () => {
  const quote = (t: string) => `> the passage\n\n${t}`

  it('puts what the composer adds into the command arguments, after a space', () => {
    expect(keepCommandFirst(`${CMD} watch this`, quote)).toBe(`${CMD} \n> the passage\n\nwatch this`)
    expect(keepCommandFirst(CMD, quote)).toBe(`${CMD} \n> the passage\n\n`)
  })

  it('sends a command message as typed when the composer adds nothing', () => {
    expect(keepCommandFirst(`${CMD} watch this`, (t) => t)).toBe(`${CMD} watch this`)
  })

  it('composes plain prose exactly as before', () => {
    expect(keepCommandFirst('what does this mean?', quote)).toBe('> the passage\n\nwhat does this mean?')
  })
})
