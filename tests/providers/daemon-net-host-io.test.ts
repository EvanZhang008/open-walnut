/** Host-server install scripts and files use the joined host's existing daemon, never SSH. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { __setTransferConnectionResolverForTesting } from '../../src/core/transfer/daemon-transfer-client.js'
import { MAX_UPLOAD_FRAME_BYTES } from '../../src/providers/ssh-upload-budget.js'

const host = 'joined-box'
const target = { hostname: 'joined-box.walnut-net.invalid', via: 'net' as const, endpoint: '60d53783dcf0c6e95fe6c2ff390fd3131d42a167eecee7eac15e57e69ed36f5b' }
let conn: DaemonConnection | null = null
afterEach(() => {
  conn?.disconnect()
  conn = null
  __setTransferConnectionResolverForTesting(null)
  vi.restoreAllMocks()
})

function setup(o: { precheck?: string; exitCode?: number; noCap?: string; unconfirmed?: boolean } = {}) {
  conn = new DaemonConnection(host, target)
  const c = conn
  const parts: Buffer[] = []
  const ssh = vi.spyOn(c as unknown as { sshExec: (...args: unknown[]) => Promise<string> }, 'sshExec').mockRejectedValue(new Error('SSH certificate expired'))
  vi.spyOn(c, 'hasCapability').mockImplementation((cap) => cap !== o.noCap)
  const send = vi.spyOn(c, 'send').mockImplementation(async (cmd, params = {}) => {
    if (cmd === 'exec.run') {
      const line = (params.argv as string[] | undefined)?.[2] ?? String(params.command)
      const marker = /walnut-update-output-[0-9a-f]+/.exec(line)![0]
      return { ok: true, exitCode: o.exitCode ?? 0, output: `login noise\n${marker}\n${o.precheck ?? 'answer'}\n` }
    }
    if (cmd === 'fs.writePart') {
      const bytes = Buffer.from(String(params.data), 'base64')
      parts.push(bytes)
      return { ok: true, staged: Number(params.offset) + bytes.length, ...(params.final ? { done: !o.unconfirmed, sha256: params.sha256 } : {}) }
    }
    throw new Error(`unexpected command ${cmd}`)
  })
  __setTransferConnectionResolverForTesting(async (key) => key === host ? [c] : [])
  return { c, ssh, send, parts }
}

describe('joined host install IO with SSH certificates expired', () => {
  it('runs the POSIX script through exec.run, preserving the deadline and removing login noise', async () => {
    const { c, ssh, send } = setup()
    await expect(c.runRemoteScript('printf answer', 5_000)).resolves.toBe('answer')
    expect(send).toHaveBeenCalledWith('exec.run', expect.objectContaining({ timeoutMs: 5_000, argv: ['/bin/sh', '-c', expect.stringContaining('printf answer')] }), 20_000)
    expect(ssh).not.toHaveBeenCalled()
  })

  it('does not call a failed command successful', async () => {
    const { c, ssh } = setup({ exitCode: 7 })
    await expect(c.runRemoteScript('false')).rejects.toThrow('exit 7')
    expect(ssh).not.toHaveBeenCalled()
  })

  it.each([Buffer.alloc(0), Buffer.from('\u03bb\u4e2d\u6587\n'), Buffer.alloc(MAX_UPLOAD_FRAME_BYTES * 5 + 17, 0xa5)])('uploads all bytes atomically with a checked final part (%#)', async (data) => {
    const { c, ssh, parts, send } = setup({ precheck: '' })
    const progress: number[] = []
    const sha = crypto.createHash('sha256').update(data).digest('hex')
    await expect(c.uploadFile('/home/user/incoming/build.gz', data, { onProgress: (sent, total) => { expect(total).toBe(data.length); progress.push(sent) } })).resolves.toEqual({ skipped: false })
    expect(Buffer.concat(parts)).toEqual(data)
    expect(parts.every((part) => part.length <= MAX_UPLOAD_FRAME_BYTES)).toBe(true)
    expect(send).toHaveBeenLastCalledWith('fs.writePart', expect.objectContaining({ final: true, size: data.length, sha256: sha }), 60_000)
    expect(progress).toEqual([0, data.length])
    expect(ssh).not.toHaveBeenCalled()
  })

  it('skips a file the host already holds, without sending any part', async () => {
    const data = Buffer.from('held file')
    const sha = crypto.createHash('sha256').update(data).digest('hex')
    const { c, parts, ssh } = setup({ precheck: `sha=${sha}\nsize=${data.length}` })
    await expect(c.uploadFile('/home/user/incoming/build.gz', data, { sha256: sha.toUpperCase() })).resolves.toEqual({ skipped: true })
    expect(parts).toHaveLength(0)
    expect(ssh).not.toHaveBeenCalled()
  })

  it('refuses an incorrect caller checksum before creating a file', async () => {
    const { c, send } = setup()
    await expect(c.uploadFile('/home/user/build.gz', Buffer.from('x'), { sha256: '0'.repeat(64) })).rejects.toThrow('does not match')
    expect(send).not.toHaveBeenCalled()
  })

  it('requires the checked final reply before reporting success', async () => {
    const { c, ssh } = setup({ precheck: '', unconfirmed: true })
    await expect(c.uploadFile('/home/user/build.gz', Buffer.from('x'))).rejects.toThrow('did not confirm')
    expect(ssh).not.toHaveBeenCalled()
  })

  it.each(['host-exec-v1', 'fs-write-part-v1'])('an older daemon without %s fails clearly and never falls back to SSH', async (noCap) => {
    const { c, ssh, send } = setup({ noCap })
    await expect(c.uploadFile('/home/user/build.gz', Buffer.from('x'))).rejects.toThrow('needs a daemon update')
    expect(send).not.toHaveBeenCalled()
    expect(ssh).not.toHaveBeenCalled()
  })
})
