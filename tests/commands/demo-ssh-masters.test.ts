/**
 * A Demo's stop ends the SSH masters its data dir holds (src/commands/demo-ssh-masters.ts), so a
 * reset is not held by a master and its ProxyCommand until ControlPersist ends them.
 * Pure: the sockets, the ends and the hosts are stand-ins; no ssh runs.
 */
import { describe, expect, it } from 'vitest'
import { endDemoSshMasters, type DemoSshMasterDeps } from '../../src/commands/demo-ssh-masters.js'
import { masterTargetIdentity } from '../../src/providers/ssh-control-master.js'

function deps(hosts: Record<string, unknown>, live: Set<string>, calls: string[]): DemoSshMasterDeps {
  return {
    hosts: async () => hosts as never,
    daemonSocket: (host, target) => `/tmp/walnut-ssh-${host}-[${target}]`,
    terminalSocket: (host) => `/tmp/walnut-term-ssh-${host}`,
    end: async (socket, host) => {
      calls.push(`${host} ${socket}`)
      if (socket.includes('boom')) throw new Error('ssh failed')
      return live.has(socket)
    },
  }
}

describe('the Demo stop ends its own SSH masters', () => {
  it('ends the daemon link and terminal masters of every SSH host, skips the host network and hostless rows', async () => {
    const calls: string[] = []
    const live = new Set(['/tmp/walnut-ssh-olddev-[builder@dev-box.example.test:]', '/tmp/walnut-term-ssh-lab'])
    const ended = await endDemoSshMasters(deps({
      olddev: { hostname: 'dev-box.example.test', user: 'builder' },
      lab: { hostname: '10.0.0.9', port: 2222 },
      'home-pc': { hostname: 'home-pc.walnut-net.invalid', transport: 'net', endpoint: 'ab' },
      broken: { label: 'no hostname' },
    }, live, calls))
    expect(ended).toEqual(['/tmp/walnut-ssh-olddev-[builder@dev-box.example.test:]', '/tmp/walnut-term-ssh-lab'])
    expect(calls).toEqual([
      'olddev /tmp/walnut-ssh-olddev-[builder@dev-box.example.test:]',
      'olddev /tmp/walnut-term-ssh-olddev',
      'lab /tmp/walnut-ssh-lab-[10.0.0.9:2222]',
      'lab /tmp/walnut-term-ssh-lab',
    ])
  })

  it('one failing end does not stop the others, and a config that cannot be read ends nothing', async () => {
    const calls: string[] = []
    expect(await endDemoSshMasters(deps({ boom: { hostname: 'a.example.test' }, ok: { hostname: 'b.example.test' } }, new Set(['/tmp/walnut-term-ssh-ok']), calls)))
      .toEqual(['/tmp/walnut-term-ssh-ok'])
    expect(calls).toHaveLength(4)
    const none = await endDemoSshMasters({ ...deps({}, new Set(), []), hosts: async () => { throw new Error('no config') } })
    expect(none).toEqual([])
  })

  it('names the machine as the daemon link does (one function): user@hostname:port', () => {
    expect(masterTargetIdentity({ hostname: 'h.example.test', user: 'u' })).toBe('u@h.example.test:')
    expect(masterTargetIdentity({ hostname: 'h.example.test', port: 22 })).toBe('h.example.test:22')
  })
})
