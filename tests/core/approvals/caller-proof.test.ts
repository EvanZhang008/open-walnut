import { describe, expect, it } from 'vitest'
import { clientPidsFromLsof, clientPidsFromSs, descendsFrom, normAddr, parentName, parseProcessTable, selfAndAbove, shortProgram } from '../../../src/core/approvals/caller-proof.js'

// A session's CLI (500) ran bash (600), which ran python (700), which ran walnut (800).
// An unrelated terminal (900 -> 910) runs its own walnut (920) and names the same session.
const PS = `
    1     0 /sbin/launchd
  500     1 claude
  600   500 /bin/bash
  700   600 /usr/bin/python3
  800   700 walnut
  900     1 /bin/zsh
  910   900 python3
  920   910 walnut
`

describe('caller proof: the asking process must descend from the session it names', () => {
  const table = parseProcessTable(PS)

  it("a script the session ran, however deep, is the session's", () => {
    expect(descendsFrom(table, 800, [500])).toBe(true)
    expect(parentName(table, 800)).toBe('python3')
  })

  it('a process outside the session naming its id is not (a forged session)', () => {
    expect(descendsFrom(table, 920, [500])).toBe(false)
  })

  it('init and unknown pids never count as an ancestor, and a missing row ends the walk', () => {
    expect(descendsFrom(table, 800, [1, 0])).toBe(false)
    expect(descendsFrom(table, 12345, [500])).toBe(false)
  })

  it('a cycle in a garbled table ends', () => {
    const loop = parseProcessTable('10 11 a\n11 10 b\n')
    expect(descendsFrom(loop, 10, [500])).toBe(false)
  })

  it("reads the pid holding exactly this connection's client end from lsof and ss", () => {
    const conn = { remoteAddress: '::ffff:127.0.0.1', remotePort: 51234, localAddress: '::ffff:127.0.0.1', localPort: 3456 }
    // The server's own end (4242) and the client's (800).
    const lsof = 'p4242\nf30\nn127.0.0.1:3456->127.0.0.1:51234\np800\nf3\nn127.0.0.1:51234->127.0.0.1:3456\n'
    expect(clientPidsFromLsof(lsof, conn)).toEqual([800])
    // A process that bound the same port number on another loopback address is not this connection.
    const squatter = `${lsof}p900\nf4\nn127.0.0.2:51234->127.0.0.1:3456\n`
    expect(clientPidsFromLsof(squatter, conn)).toEqual([800])
    // Nor one connected to another server port from the same port number.
    expect(clientPidsFromLsof('p901\nf4\nn127.0.0.1:51234->127.0.0.1:9999\n', conn)).toEqual([])
    const v6 = { remoteAddress: '::1', remotePort: 55379, localAddress: '::1', localPort: 3456 }
    expect(clientPidsFromLsof('p2032\nf25\nn[::1]:55379->[::1]:3456\n', v6)).toEqual([2032])
    // `ss ... state established` prints no State column.
    const ss = [
      '0 0 [::ffff:127.0.0.1]:3456 [::ffff:127.0.0.1]:51234 users:(("walnut",pid=4242,fd=30))',
      '0 0 [::ffff:127.0.0.1]:51234 [::ffff:127.0.0.1]:3456 users:(("curl",pid=801,fd=5))',
      '0 0 127.0.0.2:51234 127.0.0.1:3456 users:(("sh",pid=902,fd=5))',
    ].join('\n')
    expect(clientPidsFromSs(ss, conn)).toEqual([801])
    expect(normAddr('[::FFFF:127.0.0.1]')).toBe('127.0.0.1')
  })

  it('names the program of a command line by its file name', () => {
    expect(shortProgram('/opt/homebrew/Cellar/python@3.14/3.14.7/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python /work/release.py wait'))
      .toBe('Python /work/release.py wait')
    expect(shortProgram('python3 release.py')).toBe('python3 release.py')
    expect(shortProgram('/usr/bin/env')).toBe('env')
  })

  it('the server and every process above it never count as a session', () => {
    expect([...selfAndAbove(table, 800)]).toEqual([800, 700, 600, 500])
  })
})
