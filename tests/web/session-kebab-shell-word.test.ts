/**
 * The session menu's "Copy resume command" puts the folder in front as one shell
 * word, so a folder with a space or a quote still pastes as a working `cd`.
 */
import { describe, expect, it } from 'vitest'
import { shellWord } from '../../web/src/components/sessions/session-kebab-meta'

describe('shellWord', () => {
  it('leaves a plain path bare', () => {
    expect(shellWord('/work/repo-1/a_b.c')).toBe('/work/repo-1/a_b.c')
    expect(shellWord('~/x')).toBe('~/x')
  })
  it('single-quotes a path with a space', () => {
    expect(shellWord('/Users/me/My Repo')).toBe("'/Users/me/My Repo'")
  })
  it('escapes a single quote inside the path', () => {
    expect(shellWord("/a/it's")).toBe(`'/a/it'\\''s'`)
  })
  it('quotes shell metacharacters', () => {
    expect(shellWord('/a/$(rm)')).toBe("'/a/$(rm)'")
  })
})
