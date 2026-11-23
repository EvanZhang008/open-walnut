/**
 * Which witness lists the settings accept. A `dir` is a path on one computer and the config is read on both
 * machines, so once a witness is on another machine every witness is named by its machine; two names for one
 * place count one witness twice.
 */
import { describe, expect, it } from 'vitest'
import { parseSwitchSettings } from '../../../../src/core/leader/switch/settings.js'

const machines = [
  { id: 'a', home: '/h/a', standby_dir: '/s/a', port: 4001 },
  { id: 'b', home: '/h/b', standby_dir: '/s/b', port: 4002 },
]
const parse = (witnesses: unknown[]) => parseSwitchSettings({ witnesses, machines })

describe('witness lists', () => {
  it('accepts three directories on this computer, and three machines', () => {
    expect(parse([{ id: 'w1', dir: '/w/1' }, { id: 'w2', dir: '/w/2' }, { id: 'w3', dir: '/w/3' }]).settings).not.toBeNull()
    expect(parse([{ id: 'w1', host: 'dev1' }, { id: 'w2', host: 'dev2' }, { id: 'w3', host: 'dev3' }]).settings).not.toBeNull()
  })

  it('refuses a dir beside a host: the same path is another computer\'s directory on the other machine', () => {
    const r = parse([{ id: 'w1', dir: '/w/1' }, { id: 'w2', host: 'dev2' }, { id: 'w3', host: 'dev3' }])
    expect(r.settings).toBeNull()
    expect(r.problem).toMatch(/every witness needs a host/)
  })

  it('refuses two witnesses on one place, however the host is spelled', () => {
    expect(parse([{ id: 'w1', host: 'Dev1' }, { id: 'w2', host: 'dev1' }, { id: 'w3', host: 'dev3' }]).settings).toBeNull()
    expect(parse([{ id: 'w1', dir: '/w/1' }, { id: 'w2', dir: '/w/1' }, { id: 'w3', dir: '/w/3' }]).settings).toBeNull()
  })
})
