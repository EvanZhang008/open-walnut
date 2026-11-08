// A host row does not know its host, and a copied command runs in the real home, so on Demo it copies nothing.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'

const demo = vi.hoisted(() => ({ copy: null as { command: string | null } | null }))
vi.mock('@/utils/demo-generation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../web/src/utils/demo-generation')>()
  return { ...actual, demoCommandCopy: (commands: readonly string[]) => actual.demoCommandCopyFor(demo.copy, commands) }
})
vi.mock('@/utils/log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

import {
  demoCommandCopyFor, demoHostMessageFor,
  DEMO_HOST_CLAUDE_ONE_CLICK, DEMO_HOST_NO_COMMAND, DEMO_HOST_SIGN_IN,
} from '@/utils/demo-generation'
import { HostCommands } from '../../web/src/components/hosts/HostCommands'

const SAFE = "/usr/bin/env -i HOME='/x/it'\\''s demo' CLAUDE_CONFIG_DIR='/x/.claude' PATH='/usr/bin' /bin/sh -c 'exec claude'"
const INSTALLS = ['curl -fsSL https://claude.ai/install.sh | bash', 'claude update', 'npm install -g @anthropic-ai/claude-code', 'brew upgrade claude-code', 'claude install']
const OTHERS = ['sudo apt-get install -y git', 'ssh-keygen -R devbox.example.com', 'aws sso login --profile dev', 'docker start walnut-box']

describe('the shared Demo command rule', () => {
  it('leaves every command alone off a confirmed Demo page, and an empty list everywhere', () => {
    for (const command of ['claude', 'claude auth login', ...INSTALLS, ...OTHERS]) {
      expect(demoCommandCopyFor(null, [command])).toEqual({ kind: 'normal' })
    }
    expect(demoCommandCopyFor({ command: SAFE }, [])).toEqual({ kind: 'normal' })
  })

  it.each([['claude'], ['claude auth login'], [' claude auth login '], ['claude update', 'claude']])(
    'a sign-in (%j) points at Demo own sign-in or the host terminal, never swapped for the local command', (...commands) => {
      for (const demo of [{ command: SAFE }, { command: null }]) {
        expect(demoCommandCopyFor(demo, commands)).toEqual({ kind: 'note', note: DEMO_HOST_SIGN_IN })
      }
    })

  it.each(INSTALLS)('an install or update (%s) copies nothing and points at Demo one-click', command => {
    expect(demoCommandCopyFor({ command: SAFE }, [command])).toEqual({ kind: 'note', note: DEMO_HOST_CLAUDE_ONE_CLICK })
  })

  it.each(OTHERS)('another command (%s) is never swapped for the Demo sign-in, and is not shown', command => {
    expect(demoCommandCopyFor({ command: SAFE }, [command])).toEqual({ kind: 'note', note: DEMO_HOST_NO_COMMAND })
  })

  it('keeps only the state sentence (host-problem firstSentence) of a message whose commands Demo hides', () => {
    const message = 'Claude Code is not signed in on this computer. Run `claude` once in a terminal and sign in.'
    expect(demoHostMessageFor({ command: SAFE }, message, ['claude'])).toBe('Claude Code is not signed in on this computer.')
    expect(demoHostMessageFor({ command: null }, 'Claude Code 2.1.258 is too old. Run `claude update`.', ['claude update']))
      .toBe('Claude Code 2.1.258 is too old.')
    expect(demoHostMessageFor({ command: SAFE }, 'Run `a.b` first. Then x.', ['ssh x'])).toBe('Run `a.b` first.')
    expect(demoHostMessageFor(null, message, ['claude'])).toBe(message)
    expect(demoHostMessageFor({ command: SAFE }, message, [])).toBe(message)
  })
})

describe('HostCommands', () => {
  let win: Window & typeof globalThis
  let host: HTMLElement
  let root: { render: (n: unknown) => void; unmount: () => void } | null = null
  const writeText = vi.fn(async (_text: string) => {})
  beforeAll(() => {
    const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
    const g = globalThis as unknown as Record<string, unknown>
    g.window = dom.window
    g.document = dom.document
    g.IS_REACT_ACT_ENVIRONMENT = true
    win = dom.window as unknown as Window & typeof globalThis
  })
  beforeEach(() => {
    demo.copy = null
    writeText.mockClear()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(async () => {
    if (root) { await act(async () => { root!.unmount() }); root = null }
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })
  const mount = async (commands: string[]) => {
    await act(async () => { root!.render(createElement(HostCommands, { commands, testId: 'hc' })) })
  }
  const chips = () => [...host.querySelectorAll('code.hc-chip')].map(el => el.textContent)
  const copyFirst = async () => {
    await act(async () => { host.querySelector('button.setup-copy-btn')!.dispatchEvent(new win.Event('click', { bubbles: true })) })
  }

  it.each([
    [['claude auth login', 'claude'], { command: SAFE }, DEMO_HOST_SIGN_IN],
    [['claude'], { command: null }, DEMO_HOST_SIGN_IN],
    [[INSTALLS[0]!, 'claude update'], { command: SAFE }, DEMO_HOST_CLAUDE_ONE_CLICK],
    [[OTHERS[0]!], { command: SAFE }, DEMO_HOST_NO_COMMAND],
  ])('on Demo %j shows a note and nothing to copy', async (commands, copy, note) => {
    demo.copy = copy
    await mount(commands)
    expect(chips()).toEqual([])
    expect(host.querySelector('button')).toBeNull()
    expect(host.textContent).toContain(note)
    expect(host.textContent).not.toContain(SAFE)
    expect(host.querySelector('.hc-other')).toBeNull()
    expect(writeText).not.toHaveBeenCalled()
  })

  it('a normal page copies the server commands unchanged, with Other ways', async () => {
    await mount(['claude auth login', INSTALLS[0]!])
    expect(chips()).toEqual(['claude auth login'])
    expect(host.querySelector('.hc-other')).not.toBeNull()
    await copyFirst()
    expect(writeText).toHaveBeenCalledWith('claude auth login')
  })
})

describe('every HostCommands caller', () => {
  const webSrc = path.resolve(import.meta.dirname, '../../web/src')
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(file) : /\.tsx?$/.test(entry.name) ? [file] : []
  })
  const callers = walk(webSrc).map(file => ({ rel: path.relative(webSrc, file), text: fs.readFileSync(file, 'utf8') }))
    .filter(row => row.text.includes('<HostCommands'))

  it('is listed here, so a new one is read for its Demo message', () => {
    expect(callers.map(row => row.rel).sort()).toEqual([
      'components/common/HostProblemRows.tsx',
      'components/sessions/HostGateErrorBar.tsx',
      'components/sessions/SessionHostErrorBar.tsx',
      'components/sessions/path-selector/HostNote.tsx',
      'components/settings/sections/RemoteHostReadiness.tsx',
    ])
  })

  it('HostProblemRows splits the Demo-safe message, not the raw one', () => {
    const rows = callers.find(row => row.rel === 'components/common/HostProblemRows.tsx')!.text
    const calls = [...rows.matchAll(/splitReadinessMessage\(([^;]+)\);/g)].map(m => m[1]!)
    expect(calls).toEqual(["fixFailed ? problem!.fix!.text : demoHostMessage(problem?.message ?? '', problem?.commands ?? [])"])
  })

  it('RemoteHostReadiness swaps its unconfirmed sign-in line on Demo only', () => {
    const readiness = callers.find(row => row.rel === 'components/settings/sections/RemoteHostReadiness.tsx')!.text
    expect(readiness).toMatch(/demoSignInCopy\(\) \? DEMO_HOST_SIGN_IN_UNCONFIRMED : `Walnut could not confirm the Claude Code sign-in on \$\{label\}/)
  })

  it('shows each problem message beside its commands through demoHostMessage, never raw', () => {
    for (const { rel, text } of callers) {
      for (const match of text.matchAll(/<HostCommands commands=\{([^}]+)\}/g)) {
        const expr = match[1]!.trim()
        if (expr.startsWith('[')) { expect(expr, rel).toBe("['claude auth login']"); continue }
        const base = expr.replace(/[!?]?\.commands$/, '').replace(/[!?]/g, '')
        const escaped = base.replace(/\./g, '[!?]?\\.')
        // Every read of that message, not just one: each sits inside demoHostMessage( with its commands.
        const reads = [...text.matchAll(new RegExp(`${escaped}[!?]?\\.message`, 'g'))]
        expect(reads.length, `${rel}: ${base}.message`).toBeGreaterThan(0)
        for (const read of reads) {
          expect(text.slice(Math.max(0, read.index! - 16), read.index), `${rel}: a raw ${base}.message`).toMatch(/demoHostMessage\($/)
        }
      }
    }
  })

  it('HostCommands asks the shared rule before it renders any chip', () => {
    const source = fs.readFileSync(path.join(webSrc, 'components/hosts/HostCommands.tsx'), 'utf8')
    const rule = source.indexOf('demoCommandCopy(list)')
    expect(rule).toBeGreaterThan(0)
    expect(rule).toBeLessThan(source.indexOf('<CommandChip command={list[0]}'))
  })
})
