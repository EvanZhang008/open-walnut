/**
 * The remote terminal command (buildRemoteDtachCommand) run for real through the
 * login shells an ssh command meets (zsh, bash, sh), with a stand-in dtach that
 * prints its argv and runs the command after its options. Pins what the string
 * assertions in spawn.test.ts cannot: the record script reaches dtach as ONE
 * argument, `"${SHELL:-/bin/bash}"` expands on the host into its $0, the record
 * names the process that ran it (`$PPID`, dtach's master in real use), and the
 * login shell is exec'd with `-l`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

vi.mock('../../../src/constants.js', async () => {
  const nodeFs = await import('node:fs')
  const nodePath = await import('node:path')
  const { createMockConstants } = await import('../../helpers/mock-constants.js')
  const root = nodeFs.mkdtempSync('/tmp/wdrc-')
  return createMockConstants('walnut-dtach-remote-cmd', { DTACH_SOCKET_DIR: nodePath.join(root, 'term') })
})

import { DTACH_SOCKET_DIR } from '../../../src/constants.js'
import { buildRemoteDtachCommand, dtachPidPath, dtachSocketPath, REMOTE_DTACH_SOCKET_DIR } from '../../../src/web/terminal/spawn.js'
import { dtachRecordScript } from '../../../src/web/terminal/dtach-master.js'
import { guardedPath } from '../../setup/exec-guard-core.js'

const root = path.dirname(DTACH_SOCKET_DIR)
const fake = path.join(root, 'bin', 'walnut-dtach')
const shells = ['/bin/zsh', '/bin/bash', '/bin/sh'].filter((s) => fs.existsSync(s))

beforeAll(() => {
  fs.mkdirSync(path.dirname(fake), { recursive: true })
  // `<bin> -A <sock> -z -E -r winch <cmd...>`: print the argv, run the command as a child.
  fs.writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@" > "$ARGV_OUT"\nshift 6\n"$@"\necho "FAKE_PID=$$"\n', { mode: 0o755 })
})

afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

describe.skipIf(REMOTE_DTACH_SOCKET_DIR !== DTACH_SOCKET_DIR)('the remote dtach command through a real login shell', () => {
  it.each(shells)('%s: one record argument, the host\'s $SHELL as its $0, a record naming its parent, then <shell> -l', (shell) => {
    const sid = `rc-${path.basename(shell)}`
    const argvOut = path.join(root, `${sid}.argv`)
    const cmd = buildRemoteDtachCommand(fake, sid)
    const out = execFileSync(shell, ['-c', cmd], { encoding: 'utf8', env: { PATH: guardedPath([], '/usr/bin:/bin'), HOME: root, SHELL: '/bin/echo', ARGV_OUT: argvOut } })

    const argv = fs.readFileSync(argvOut, 'utf8').split('\n').slice(0, -1)
    expect(argv).toEqual(['-A', dtachSocketPath(sid, true), '-z', '-E', '-r', 'winch', '/bin/sh', '-c', dtachRecordScript(dtachPidPath(sid, true), sid), '/bin/echo'])
    // `exec "$0" -l` with $0 = the host's $SHELL (here /bin/echo, which prints its argument).
    expect(out.split('\n')[0]).toBe('-l')
    const fakePid = Number(/FAKE_PID=(\d+)/.exec(out)?.[1])
    const [pid, start] = fs.readFileSync(dtachPidPath(sid, true), 'utf8').split('\n')
    expect(Number(pid)).toBe(fakePid)
    expect(start).toMatch(/^(?:proc|ps):\S/)
    expect(fs.existsSync(`${dtachPidPath(sid, true)}.tmp`)).toBe(false)
  })

  it('a record that cannot be written stays out of the terminal and the shell still starts', () => {
    const cmd = `/bin/sh -c '${dtachRecordScript('/nonexistent-dir/x.dpid').replace(/'/g, "'\\''")}' /bin/echo`
    const res = execFileSync('/bin/sh', ['-c', `${cmd} 2>&1`], { encoding: 'utf8', env: { PATH: guardedPath([], '/usr/bin:/bin') } })
    expect(res.trim()).toBe('-l')
  })
})
