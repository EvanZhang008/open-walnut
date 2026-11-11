/**
 * A tool card's result opens its paths through ONE handler with the tool writer's source: no host
 * and no session refuse with no read; a known host opens there once; the caller's opener keeps the
 * line; the row's handler around the card never opens the same click again.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act, useEffect } from '../../web/node_modules/react/index.js'
import { createRoot, type Root } from '../../web/node_modules/react-dom/client.js'

const opened: Array<Record<string, unknown>> = []
vi.mock('@/utils/open-anywhere', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../web/src/utils/open-anywhere')>()
  return { ...real, openFileAnywhere: (req: Record<string, unknown>) => { opened.push(req) } }
})

const ABS = '/home/me/work/notes.txt'
const RESULT = `Found ${ABS}:3 and src/rel/file.ts and [the letter](letter:lt-abc123-abcd)`
const TOOL = { name: 'Grep', input: { pattern: 'notes' }, toolUseId: 'tu-writer-1', result: RESULT }

let GenericToolCall: typeof import('../../web/src/components/sessions/SessionMessage').GenericToolCall
let RowDisclosureScope: typeof import('../../web/src/components/sessions/row-disclosure').RowDisclosureScope
let useRowDisclosure: typeof import('../../web/src/components/sessions/row-disclosure').useRowDisclosure
let MemoryRouter: typeof import('../../web/node_modules/react-router-dom').MemoryRouter
let win: { Event: typeof Event }
let doc: Document
let root: Root | null = null
let box: Element | null = null
const fileReads: string[] = []

beforeAll(async () => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  doc = dom.document as unknown as Document
  win = dom.window as unknown as { Event: typeof Event }
  g.fetch = async (input: unknown) => {
    const url = String(input)
    if (/\/api\/(file|files|local-image|sessions)/.test(url)) fileReads.push(url)
    return new Response('{}', { status: 404 })
  }
  ;({ GenericToolCall } = await import('../../web/src/components/sessions/SessionMessage'))
  ;({ RowDisclosureScope, useRowDisclosure } = await import('../../web/src/components/sessions/row-disclosure'))
  ;({ MemoryRouter } = await import('../../web/node_modules/react-router-dom'))
})

afterEach(async () => {
  if (root) await act(async () => { root!.unmount() })
  root = null
  box?.remove()
  opened.length = 0
  fileReads.length = 0
})

/** Opens the tool's disclosure in the scope before the card mounts, as a person's earlier press would. */
function OpenTool() {
  const [, set] = useRowDisclosure(`tool-${TOOL.toolUseId}`, false)
  useEffect(() => { set(true) }, [set])
  return null
}

async function mount(props: Record<string, unknown>, onRow: () => void): Promise<Element> {
  box = doc.createElement('div')
  doc.body.appendChild(box)
  root = createRoot(box)
  const scope = `scope-${Math.random()}`
  const tree = (withCard: boolean) => createElement(MemoryRouter, null,
    createElement(RowDisclosureScope.Provider, { value: scope },
      createElement('div', { onClick: onRow }, createElement(OpenTool), withCard ? createElement(GenericToolCall, { tool: TOOL, ...props }) : null)))
  await act(async () => { root!.render(tree(false)) })
  await act(async () => { root!.render(tree(true)) })
  expect(box.querySelector('.chat-tool-block-body'), 'the tool card is open').not.toBeNull()
  return box
}

async function press(el: Element | null): Promise<void> {
  expect(el, 'the link is drawn').not.toBeNull()
  await act(async () => { el!.dispatchEvent(new win.Event('click', { bubbles: true, cancelable: true })) })
}

const fileLink = (el: Element) => el.querySelector(`.chat-tool-block-result a.file-link[data-file-path="${ABS}"]`)

describe('a tool result opens with its writer', () => {
  it('no host and no session: the path is refused with no read, a relative path is no link, a letter reads nothing', async () => {
    let row = 0
    const el = await mount({}, () => { row++ })
    expect(el.querySelector('.chat-tool-block-result a.file-link[data-rel-path]'), 'a relative path with no writer is no link').toBeNull()
    await press(fileLink(el))
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({ path: ABS })
    expect(String(opened[0]!.sourceFailure ?? '')).toContain('No file was read')
    expect(row, 'the row handler never took the path click').toBe(0)
    const rel = doc.createElement('a')
    rel.className = 'file-link'
    rel.setAttribute('data-rel-path', 'src/rel/file.ts')
    rel.setAttribute('data-cwd', '/home/me/work')
    rel.setAttribute('href', '#')
    el.querySelector('.chat-tool-block-result')!.appendChild(rel)
    await press(rel)
    expect(opened).toHaveLength(2)
    expect(opened[1]).toMatchObject({ path: 'src/rel/file.ts' })
    expect(String(opened[1]!.sourceFailure ?? '')).toContain('No file was read')
    expect(row).toBe(0)
    await press(el.querySelector('.chat-tool-block-result a.letter-link'))
    expect(fileReads, 'zero file network for any of them').toEqual([])
  })

  it('a known host opens there, once, with no session read', async () => {
    let row = 0
    const el = await mount({ sessionId: 'sid-remote', sessionHost: 'devbox' }, () => { row++ })
    await press(fileLink(el))
    expect(opened).toEqual([expect.objectContaining({ path: ABS, host: 'devbox', sourceOnly: true, line: 3 })])
    expect(fileReads).toEqual([])
    expect(row).toBe(0)
  })

  it("the caller's opener (the panel's hand-off) keeps the line, and is the only one called", async () => {
    let row = 0
    const calls: unknown[][] = []
    const el = await mount({ sessionId: 'sid-local', sessionHost: '', onFileOpen: (...a: unknown[]) => { calls.push(a) } }, () => { row++ })
    await press(fileLink(el))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.slice(0, 2)).toEqual([ABS, 3])
    expect(opened).toEqual([])
    expect(row).toBe(0)
  })
})
