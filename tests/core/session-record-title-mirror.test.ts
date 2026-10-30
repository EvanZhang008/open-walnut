/**
 * The AI title is mirrored onto the session record only over a title that
 * carries no human signal: empty, the placeholder, or the forms a launch mints
 * from the first message (claude-code-session.ts). 2026-10-30: every OpenCode
 * session kept the first 120 characters of its prompt as its title.
 */
import { describe, expect, it } from 'vitest'
import { isLaunchMintedRecordTitle } from '../../src/core/session-hooks/builtins.js'

const placeholder = 'Session: work'
const naming = 'Write a detailed essay about the Postgres connection pool timeout in the marina service, with five sections and a summary at the end.'

describe('isLaunchMintedRecordTitle', () => {
  it('empty and the placeholder', () => {
    expect(isLaunchMintedRecordTitle({ title: '' }, placeholder)).toBe(true)
    expect(isLaunchMintedRecordTitle({}, placeholder)).toBe(true)
    expect(isLaunchMintedRecordTitle({ title: placeholder }, placeholder)).toBe(true)
  })

  it('an ACP launch title: the first 120 characters of the message', () => {
    expect(isLaunchMintedRecordTitle({ title: naming.slice(0, 120), description: naming.slice(0, 500) }, placeholder)).toBe(true)
  })

  it('a native launch title: the placeholder and the first 80 characters', () => {
    expect(isLaunchMintedRecordTitle({ title: `${placeholder} — ${naming.slice(0, 80)}`, description: naming }, placeholder)).toBe(true)
  })

  it('a short message is its own whole title', () => {
    expect(isLaunchMintedRecordTitle({ title: 'fix the build', description: 'fix the build' }, placeholder)).toBe(true)
  })

  it('a title someone wrote is kept', () => {
    expect(isLaunchMintedRecordTitle({ title: 'Marina pool fix', description: naming }, placeholder)).toBe(false)
    expect(isLaunchMintedRecordTitle({ title: 'Marina pool fix' }, placeholder)).toBe(false)
    expect(isLaunchMintedRecordTitle({ title: naming.slice(0, 60), description: naming }, placeholder)).toBe(false)
  })
})
