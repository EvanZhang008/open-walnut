/**
 * getBoardView: a reader that only looks gets the board parsed once per file change, shared and
 * frozen. 2026-11-24: the server read one leader's 230 KB board about 490 times in 10 minutes
 * (host slices, status passes, choice lookups) for a file written 9 times.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-board-view'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { getBoard, getBoardView, postBoardMessage, setBoardHtml, stopBoardStore } from '../../../src/core/boards/board-store.js'

const T = 'mt0view1-aaaa'
const pause = () => new Promise((r) => setTimeout(r, 120)) // past the kept reader's racy window

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})
afterEach(async () => {
  stopBoardStore()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('getBoardView', () => {
  it('a task with no board reads null', async () => {
    expect(await getBoardView(T)).toBeNull()
  })

  it('reads what getBoard reads, the same object while the file is unchanged, frozen', async () => {
    await setBoardHtml(T, '<h1>Acme</h1>', { by: 'human' })
    await pause()
    const a = await getBoardView(T)
    const b = await getBoardView(T)
    expect(a).toEqual(await getBoard(T))
    expect(b).toBe(a)
    expect(Object.isFrozen(a)).toBe(true)
    expect(Object.isFrozen(a!.threads)).toBe(true)
    expect(() => { (a as { html: string }).html = 'x' }).toThrow()
  })

  it('a write is read at once, by a writer here or a file changed under it', async () => {
    await setBoardHtml(T, '<h1>Acme</h1>', { by: 'human' })
    await pause()
    const before = await getBoardView(T)
    await postBoardMessage(T, 'acme-thread', { author: 'user', text: 'Ship it' } as never).catch(() => undefined)
    await setBoardHtml(T, '<h1>Acme two</h1>', { by: 'human' })
    const after = await getBoardView(T)
    expect(after).not.toBe(before)
    expect(after?.html).toBe('<h1>Acme two</h1>')
    expect(after).toEqual(await getBoard(T))
    // A file written by someone else (git-sync, another process).
    await pause()
    const file = path.join(WALNUT_HOME, 'boards', `${T}.json`)
    const raw = JSON.parse(await fs.readFile(file, 'utf8'))
    await fs.writeFile(file, JSON.stringify({ ...raw, html: '<h1>Acme three</h1>' }))
    expect((await getBoardView(T))?.html).toBe('<h1>Acme three</h1>')
  })

  it('getBoard still hands out a board of its own to edit', async () => {
    await setBoardHtml(T, '<h1>Acme</h1>', { by: 'human' })
    await pause()
    const view = await getBoardView(T)
    const own = await getBoard(T)
    own!.threads.edited = []
    expect(view!.threads.edited).toBeUndefined()
  })
})
