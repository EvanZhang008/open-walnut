/**
 * A hidden file in a commands folder is never listed as a command: macOS leaves `._<name>.md`
 * (AppleDouble metadata, binary) beside a file copied to some disks, and the Commands page showed
 * one as a command whose prompt was binary noise (2026-11-22, the UI audit). Every hidden name is
 * the class, so the test covers both folders and more than one kind of dot file.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('command-store-hidden'))

import { BUILTIN_COMMANDS_DIR, COMMANDS_DIR } from '../../src/constants.js'
import { listCommands } from '../../src/core/command-store.js'

async function put(dir: string, file: string, body: string | Buffer) {
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, file), body)
}

describe('command-store: hidden files', () => {
  beforeEach(async () => {
    await fsp.rm(COMMANDS_DIR, { recursive: true, force: true })
    await fsp.rm(BUILTIN_COMMANDS_DIR, { recursive: true, force: true })
  })

  it('lists the real commands and skips every dot file beside them', async () => {
    await put(COMMANDS_DIR, 'find-session.md', '---\ndescription: Find a session\n---\nFind it.\n')
    await put(COMMANDS_DIR, '._find-session.md', Buffer.from([0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00]))
    await put(COMMANDS_DIR, '.#find-session.md', 'editor lock')
    await put(BUILTIN_COMMANDS_DIR, 'built.md', 'Built in.\n')
    await put(BUILTIN_COMMANDS_DIR, '._built.md', Buffer.from([0x00, 0x05, 0x16, 0x07]))

    const names = (await listCommands()).map((c) => c.name).sort()
    expect(names).toEqual(['built', 'find-session'])
  })
})
