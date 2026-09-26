/**
 * withLeadingCommand: the "+" menu's "Set up a trigger" row puts the skill's
 * slash command at the START of the composer text, because an engine reads
 * `/name` as a command only when the message begins with it.
 */
import { describe, expect, it } from 'vitest'
import { keepCommandFirst, splitLeadingCommand, withLeadingCommand } from '../../web/src/components/chat/leading-command'

const CMD = '/walnut-trigger'

describe('withLeadingCommand', () => {
  it('arms an empty composer with the command and a space to type after', () => {
    expect(withLeadingCommand('', CMD)).toEqual({ value: `${CMD} `, caret: CMD.length + 1 })
    expect(withLeadingCommand('   \n', CMD)).toEqual({ value: `${CMD} `, caret: CMD.length + 1 })
  })

  it('turns what the user already typed into the command argument', () => {
    const typed = 'tell me when PR 123 gets a review comment'
    const next = withLeadingCommand(typed, CMD)
    expect(next.value).toBe(`${CMD} ${typed}`)
    expect(next.caret).toBe(next.value.length)
    // Leading whitespace is dropped, the rest (inner newlines included) is kept.
    expect(withLeadingCommand('\n  watch the build\nand the deploy', CMD).value)
      .toBe(`${CMD} watch the build\nand the deploy`)
  })

  it('leaves text that already starts with the command alone, so a second click is a no-op', () => {
    const armed = `${CMD} watch the build`
    expect(withLeadingCommand(armed, CMD)).toEqual({ value: armed, caret: armed.length })
    // Twice in a row from empty gives the same text as once.
    const once = withLeadingCommand('', CMD).value
    expect(withLeadingCommand(once, CMD).value).toBe(once)
  })

  it('adds the space the CLI splits on when the command is followed by a newline or tab', () => {
    // The Claude CLI splits `/name args` on the first space; `/name\nargs` reads as one name.
    expect(withLeadingCommand(`${CMD}\nwatch the build`, CMD).value).toBe(`${CMD} \nwatch the build`)
    expect(withLeadingCommand(`${CMD}\twatch`, CMD).value).toBe(`${CMD} \twatch`)
    const fixed = withLeadingCommand(`${CMD}\nwatch`, CMD).value
    expect(withLeadingCommand(fixed, CMD).value).toBe(fixed)
  })

  it('completes a bare command instead of doubling it', () => {
    expect(withLeadingCommand(CMD, CMD)).toEqual({ value: `${CMD} `, caret: CMD.length + 1 })
  })

  it('does not mistake a longer command for this one', () => {
    expect(withLeadingCommand('/walnut-triggers list', CMD).value).toBe(`${CMD} /walnut-triggers list`)
    expect(withLeadingCommand('/walnut hello', CMD).value).toBe(`${CMD} /walnut hello`)
  })

  it('keeps non-ASCII text intact', () => {
    // CJK test data, written as escapes.
    const typed = '\u76ef\u7740 PR 123'
    expect(withLeadingCommand(typed, CMD).value).toBe(`${CMD} ${typed}`)
  })
})

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

