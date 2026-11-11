/**
 * The key ssh signs in to a host with (src/core/hosts/ssh-key-of.ts), read from `ssh -G`,
 * so the first-run walkthrough names the host's own IdentityFile in its commands.
 */
import { describe, expect, it } from 'vitest'
import { identityFilesOf, tildePath } from '../../../src/core/hosts/ssh-key-of'

describe('identityFilesOf', () => {
  it('reads every identityfile line of ssh -G, in order', () => {
    const out = 'user sam\nhostname 10.0.0.9\nidentityfile ~/.ssh/lab\nidentityfile ~/.ssh/id_ed25519\nport 22\n'
    expect(identityFilesOf(out)).toEqual(['~/.ssh/lab', '~/.ssh/id_ed25519'])
    expect(identityFilesOf('')).toEqual([])
  })
})

describe('tildePath', () => {
  it('writes a path under home with ~/ and leaves others alone', () => {
    expect(tildePath('/home/sam/.ssh/lab', '/home/sam')).toBe('~/.ssh/lab')
    expect(tildePath('~/.ssh/lab', '/home/sam')).toBe('~/.ssh/lab')
    expect(tildePath('/etc/keys/lab', '/home/sam')).toBe('/etc/keys/lab')
  })
})
