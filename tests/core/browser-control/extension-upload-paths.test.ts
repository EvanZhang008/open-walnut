/**
 * Which files the extension hands a page in a trusted upload (packages/browser-extension/src/agent-upload.ts):
 * a file the task downloaded, or one the person said yes to (`granted_paths`, which only the server
 * sets). Anything else is refused; a browser without file access says how to turn it on.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

const dl = vi.hoisted(() => ({ files: [] as string[] }))
vi.mock('../../../packages/browser-extension/src/agent-downloads', () => ({ downloadedFiles: async () => dl.files }))
vi.mock('../../../packages/browser-extension/src/agent-shared', () => ({
  AgentError: class AgentError extends Error { constructor(message: string, readonly code: string) { super(message) } },
}))

import { allowedPaths, fileAccessOn } from '../../../packages/browser-extension/src/agent-upload'

const g = globalThis as { chrome?: unknown }
afterEach(() => { dl.files = []; delete g.chrome })

async function refusal(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try { await p } catch (err) { return err as { code?: string; message: string } }
  throw new Error('not refused')
}

describe('allowedPaths', () => {
  it('takes a file this task downloaded and one the person said yes to', async () => {
    dl.files = ['/Users/evan/Downloads/report.pdf']
    const paths = ['/Users/evan/Downloads/report.pdf', '/Users/evan/Desktop/demo.mov']
    expect(await allowedPaths({ paths, granted_paths: ['/Users/evan/Desktop/demo.mov'] }, 'task:a')).toEqual(paths)
  })

  it('refuses any other file', async () => {
    const e = await refusal(allowedPaths({ paths: ['/Users/evan/.ssh/id_ed25519'], granted_paths: ['/Users/evan/Desktop/demo.mov'] }, 'task:a'))
    expect(e.code).toBe('path_not_allowed')
    expect(e.message).toContain('/Users/evan/.ssh/id_ed25519')
  })

  it('a browser with file access off says how to turn it on, before anything is set', async () => {
    g.chrome = { extension: { isAllowedFileSchemeAccess: async () => false } }
    const e = await refusal(allowedPaths({ paths: ['/Users/evan/a.mov'], granted_paths: ['/Users/evan/a.mov'] }, 'task:a'))
    expect(e.code).toBe('file_access_off')
    expect(e.message).toMatch(/Allow access to file URLs/)
  })

  it('needs paths', async () => {
    expect((await refusal(allowedPaths({}, 'task:a'))).code).toBe('bad_request')
  })
})

describe('fileAccessOn', () => {
  it('reads Chrome\'s answer, a promise or a plain value, and a browser that cannot tell lets Chrome answer', async () => {
    g.chrome = { extension: { isAllowedFileSchemeAccess: async () => false } }
    expect(await fileAccessOn()).toBe(false)
    g.chrome = { extension: { isAllowedFileSchemeAccess: () => true } }
    expect(await fileAccessOn()).toBe(true)
    g.chrome = { extension: { isAllowedFileSchemeAccess: () => undefined } }
    expect(await fileAccessOn()).toBe(true)
    g.chrome = { extension: { isAllowedFileSchemeAccess: () => { throw new Error('gone') } } }
    expect(await fileAccessOn()).toBe(true)
    delete g.chrome
    expect(await fileAccessOn()).toBe(true)
  })
})
