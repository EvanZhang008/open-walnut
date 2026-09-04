/**
 * After a server restart the reattach tails the stream from the end, so the
 * CLI's `init.slash_commands` this process never saw must come from the stream
 * file itself — read as a bounded TAIL through the daemon, never whole.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stat = vi.fn()
const readFileRange = vi.fn()
vi.mock('../../../src/core/daemon-file-reader.js', () => ({
  DaemonFileReader: class {
    constructor(public host: string) {}
    stat(p: string) { return stat(this.host, p) }
    readFileRange(p: string, start: number) { return readFileRange(this.host, p, start) }
  },
}))

import {
  lastInitSlashCommands, recoverCliSlashCommandsFromStream,
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
})
