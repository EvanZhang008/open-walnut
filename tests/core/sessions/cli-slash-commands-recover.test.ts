/**
 * After a server restart the reattach tails the stream from the end, so the
 * CLI's `init.slash_commands` this process never saw must come from the stream
 * file itself — read as a bounded TAIL through the daemon, never whole.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stat = vi.fn()
/**
 * The fake answers `{ content, fileSize }`: the bytes of [start, fileSize), the
 * content at their end and a filler line before it, as a real range read of
 * that length would hold.
 */
const readFileRange = vi.fn()
vi.mock('../../../src/core/daemon-file-reader.js', () => ({
  DaemonFileReader: class {
    constructor(public host: string) {}
    stat(p: string) { return stat(this.host, p) }
    async readFileRangeBuffer(p: string, start: number) {
      const res = await readFileRange(this.host, p, start)
      if (res === null) return null
      const body = Buffer.from(res.content, 'utf-8')
      const want = res.fileSize - start
      const buf = body.length >= want ? body : Buffer.concat([Buffer.from('#'.repeat(want - body.length - 1) + '\n'), body])
      return { buf, fileSize: res.fileSize }
    }
  },
}))

import {
  lastInitSlashCommands, recoverCliSlashCommandsFromStream, streamLooksKept, _resetStreamLooksForTesting,
} from '../../../src/core/sessions/cli-slash-commands-recover.js'

const init = (names: string[], terminal: string[] = []) =>
  JSON.stringify({ type: 'system', subtype: 'init', slash_commands: names, terminal_slash_commands: terminal, model: 'x' })

describe('lastInitSlashCommands', () => {
  it('takes the LAST init, drops terminal-only names, tolerates torn and foreign lines', () => {
    const content = [
      '"model":"x"}',                       // torn first line of a tail window
      init(['old', 'compact']),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '"subtype":"init" "slash_commands"' }] } }),
      init(['compact', 'deploy', 'doctor', 'color'], ['doctor', 'color']),
      JSON.stringify({ type: 'result', subtype: 'success' }),
      '',
    ].join('\n')
    expect(lastInitSlashCommands(content)).toEqual(['compact', 'deploy'])
  })

  it('null when no init is in the window', () => {
    expect(lastInitSlashCommands('{"type":"result"}\n{"type":"assistant"}\n')).toBeNull()
  })
})

describe('recoverCliSlashCommandsFromStream', () => {
  beforeEach(() => {
    stat.mockReset()
    readFileRange.mockReset()
  })

  it('reads only a tail window of the first existing candidate and memoises by file size', async () => {
    const body = init(['compact', 'ship']) + '\n' + JSON.stringify({ type: 'result' }) + '\n'
    const size = 3 * 1024 * 1024
    stat.mockImplementation(async (_host: string, p: string) => (p.includes('/tmp/open-walnut-streams/') ? { size, mtimeMs: 1 } : null))
    readFileRange.mockResolvedValue({ content: 'torn}\n' + body, fileSize: size })

    const first = await recoverCliSlashCommandsFromStream('sid-a', 'box')
    expect(first).toEqual({ names: ['compact', 'ship'], fileSize: size })
    expect(readFileRange).toHaveBeenCalledTimes(1)
    const [host, , start] = readFileRange.mock.calls[0]
    expect(host).toBe('box')
    expect(start).toBe(size - 1024 * 1024)

    // Same size → memo hit, no second read. Grown file → re-read.
    await recoverCliSlashCommandsFromStream('sid-a', 'box')
    expect(readFileRange).toHaveBeenCalledTimes(1)
    stat.mockResolvedValue({ size: size + 10, mtimeMs: 2 })
    await recoverCliSlashCommandsFromStream('sid-a', 'box')
    expect(readFileRange).toHaveBeenCalledTimes(2)
  })

  it('widens once to the larger window, then gives up (caller falls back to discovery)', async () => {
    stat.mockResolvedValue({ size: 10 * 1024 * 1024, mtimeMs: 1 })
    readFileRange.mockResolvedValue({ content: '{"type":"assistant"}\n', fileSize: 10 * 1024 * 1024 })
    expect(await recoverCliSlashCommandsFromStream('sid-b', null)).toBeNull()
    expect(readFileRange).toHaveBeenCalledTimes(2)
    expect(readFileRange.mock.calls[0][0]).toBe('__local__')
    expect(readFileRange.mock.calls[1][2]).toBe(10 * 1024 * 1024 - 4 * 1024 * 1024)
  })

  it('null when no stream file exists or the host is unknown', async () => {
    stat.mockResolvedValue(null)
    expect(await recoverCliSlashCommandsFromStream('sid-c', 'box')).toBeNull()
    stat.mockRejectedValue(new Error('Unknown host: ghost'))
    expect(await recoverCliSlashCommandsFromStream('sid-d', 'ghost')).toBeNull()
    expect(readFileRange).not.toHaveBeenCalled()
  })

  /**
   * A session mid-turn grows its stream every second. Keyed by size alone, the
   * memo missed on every palette open and read the 1 MB tail (and the 4 MB one
   * when the init was further back) over the host's link again (2026-11-25).
   */
  it('a grown stream is read only from where the last look stopped', async () => {
    const MB = 1024 * 1024
    const size = 3 * MB
    const tail = 'torn}\n' + init(['compact', 'ship']) + '\n' + JSON.stringify({ type: 'assistant' }) + '\n' + '{"partial'
    stat.mockResolvedValue({ size, mtimeMs: 1, epoch: 'e1' })
    readFileRange.mockResolvedValue({ content: tail, fileSize: size })
    expect((await recoverCliSlashCommandsFromStream('sid-g', 'box'))?.names).toEqual(['compact', 'ship'])
    // Up to the end of the last whole line: the line still being written is read next time.
    const stoppedAt = size - Buffer.byteLength('{"partial')

    // Grown, no new init in the appended bytes: one read of just those, the names stand.
    stat.mockResolvedValue({ size: size + 500, mtimeMs: 2, epoch: 'e1' })
    readFileRange.mockResolvedValue({ content: '{"partial":1}\n{"type":"assistant"}\n', fileSize: size + 500 })
    expect((await recoverCliSlashCommandsFromStream('sid-g', 'box'))?.names).toEqual(['compact', 'ship'])
    expect(readFileRange).toHaveBeenCalledTimes(2)
    expect(readFileRange.mock.calls[1][2]).toBe(stoppedAt)

    // A new turn's init in the appended bytes wins.
    stat.mockResolvedValue({ size: size + 900, mtimeMs: 3, epoch: 'e1' })
    readFileRange.mockResolvedValue({ content: init(['compact', 'ship', 'deploy']) + '\n', fileSize: size + 900 })
    expect((await recoverCliSlashCommandsFromStream('sid-g', 'box'))?.names).toEqual(['compact', 'ship', 'deploy'])
    expect(readFileRange).toHaveBeenCalledTimes(3)
    expect(readFileRange.mock.calls[2][2]).toBe(size + 500)

    // A new file (another incarnation) is read from its tail again.
    stat.mockResolvedValue({ size: 2 * MB, mtimeMs: 4, epoch: 'e2' })
    readFileRange.mockResolvedValue({ content: init(['clear']) + '\n', fileSize: 2 * MB })
    expect((await recoverCliSlashCommandsFromStream('sid-g', 'box'))?.names).toEqual(['clear'])
    expect(readFileRange.mock.calls[3][2]).toBe(MB)
  })

  it('no init in reach: a grown stream reads only its appended bytes, not both tail windows again', async () => {
    const MB = 1024 * 1024
    stat.mockResolvedValue({ size: 10 * MB, mtimeMs: 1, epoch: 'e1' })
    readFileRange.mockResolvedValue({ content: '{"type":"assistant"}\n', fileSize: 10 * MB })
    expect(await recoverCliSlashCommandsFromStream('sid-h', 'box')).toBeNull()
    expect(readFileRange).toHaveBeenCalledTimes(2)

    stat.mockResolvedValue({ size: 10 * MB + 100, mtimeMs: 2, epoch: 'e1' })
    expect(await recoverCliSlashCommandsFromStream('sid-h', 'box')).toBeNull()
    expect(readFileRange).toHaveBeenCalledTimes(3)
    expect(readFileRange.mock.calls[2][2]).toBe(10 * MB)
  })

  /**
   * A restart emptied the looks, so the first palette of every session after a deploy read
   * the 1 MB tail (or 4 MB) over the link again. The looks are kept (slash-commands-disk.ts
   * writes `forDisk()`); one read back is trusted only for the same file incarnation.
   */
  it('after a restart, a look read back reads only what the stream gained; another file or no epoch reads the tail', async () => {
    const MB = 1024 * 1024
    const size = 3 * MB
    stat.mockResolvedValue({ size, mtimeMs: 1, epoch: 'e1' })
    readFileRange.mockResolvedValue({ content: 'torn}\n' + init(['compact', 'ship']) + '\n', fileSize: size })
    await recoverCliSlashCommandsFromStream('sid-r', 'box')
    stat.mockResolvedValue({ size, mtimeMs: 1 })
    await recoverCliSlashCommandsFromStream('sid-noepoch', 'box')
    stat.mockResolvedValue({ size, mtimeMs: 1, epoch: 'e9' })
    await recoverCliSlashCommandsFromStream('sid-other', 'box')
    const onDisk = JSON.parse(JSON.stringify(streamLooksKept.forDisk())) as unknown

    // A new process: nothing in memory, the kept looks read back (a malformed row is dropped).
    _resetStreamLooksForTesting()
    await streamLooksKept.restore(Promise.resolve([...(onDisk as unknown[]), ['sid-bad', { path: 7 }], 'junk']))
    readFileRange.mockClear()

    stat.mockResolvedValue({ size: size + 400, mtimeMs: 2, epoch: 'e1' })
    readFileRange.mockResolvedValue({ content: '{"type":"assistant"}\n', fileSize: size + 400 })
    expect((await recoverCliSlashCommandsFromStream('sid-r', 'box'))?.names).toEqual(['compact', 'ship'])
    expect(readFileRange).toHaveBeenCalledTimes(1)
    expect(readFileRange.mock.calls[0][2]).toBe(size) // old code: size + 400 - 1 MB, the tail again

    // Kept without an epoch: it cannot prove it is the same file, so the tail is read.
    readFileRange.mockClear()
    stat.mockResolvedValue({ size: size + 400, mtimeMs: 2 })
    readFileRange.mockResolvedValue({ content: init(['clear']) + '\n', fileSize: size + 400 })
    expect((await recoverCliSlashCommandsFromStream('sid-noepoch', 'box'))?.names).toEqual(['clear'])
    expect(readFileRange.mock.calls[0][2]).toBe(size + 400 - MB)

    // Another incarnation now: the tail too.
    readFileRange.mockClear()
    stat.mockResolvedValue({ size: size + 400, mtimeMs: 2, epoch: 'e10' })
    expect((await recoverCliSlashCommandsFromStream('sid-other', 'box'))?.names).toEqual(['clear'])
    expect(readFileRange.mock.calls[0][2]).toBe(size + 400 - MB)
  })
})
