// The single-command author flow, with every side effect injected: no install, no browser, no real HOME, no network, no waiting on a watcher.
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appPath, appUrl, DEFAULT_APP_ID } from '../../packages/plugin-cli/src/app-route.js'
import {
  runDev,
  runNew,
  syncPlugin,
  type DevDependencies,
  type PluginRuntimeStatus,
} from '../../packages/plugin-cli/src/dev.js'
import { API_TIMEOUT_MS, ApiError, apiRequest } from '../../packages/plugin-cli/src/http.js'
import { scaffoldPlugin } from '../../packages/plugin-cli/src/scaffold.js'
import type { PluginManifest, ValidationResult } from '../../packages/plugin-cli/src/manifest.js'
import type { BuildPluginOptions, PluginBuildResult } from '../../packages/plugin-cli/src/build.js'

const PLUGIN_ID = 'demo-plugin'
const BASE_URL = 'http://127.0.0.1:3456'
const APP_URL = `${BASE_URL}/apps/${PLUGIN_ID}~${DEFAULT_APP_ID}`

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-plugin-dev-'))
  roots.push(root)
  return root
}

interface Harness {
  /** Ordered log of every injected side effect plus every printed line. */
  calls: string[]
  output: string
  deps: DevDependencies
  /** Fire the watcher's rebuild callback, the way esbuild would after a save. */
  rebuild(): Promise<void>
  builds: number
}

function harness(options: {
  manifest?: Partial<PluginManifest>
  status?: PluginRuntimeStatus | undefined
  discover?(pluginId: string): Promise<void>
  reload?(pluginId: string): Promise<void>
  canOpen?: boolean
} = {}): Harness {
  const calls: string[] = []
  const chunks: string[] = []
  let onRebuild: (() => void | Promise<void>) | undefined
  const manifest: PluginManifest = {
    id: PLUGIN_ID,
    name: 'Demo Plugin',
    apiVersion: 1,
    engines: { walnut: '>=0.0.0' },
    server: 'dist/server.mjs',
    web: 'dist/web.mjs',
    ...options.manifest,
  }
  const state: Harness = {
    calls,
    get output() { return chunks.join('') },
    builds: 0,
    async rebuild() {
      if (!onRebuild) throw new Error('the flow never started a watch build')
      await onRebuild()
    },
    deps: {
      install: async (root) => { calls.push(`install:${root}`) },
      validate: async (root): Promise<ValidationResult> => {
        calls.push(`validate:${root}`)
        return { manifest, errors: [], warnings: [] }
      },
      build: async (buildOptions: BuildPluginOptions): Promise<PluginBuildResult> => {
        state.builds += 1
        calls.push(`build:watch=${String(!!buildOptions.watch)}`)
        onRebuild = buildOptions.onRebuild
        return { outputs: [], stop: async () => { calls.push('stop') } }
      },
      link: async (root) => {
        calls.push('link')
        return path.join(root, '..', 'home', 'plugins', PLUGIN_ID)
      },
      discover: options.discover ?? (async (pluginId) => { calls.push(`discover:${pluginId}`) }),
      reload: options.reload ?? (async (pluginId) => { calls.push(`reload:${pluginId}`) }),
      status: async (pluginId) => {
        calls.push(`status:${pluginId}`)
        return 'status' in options ? options.status : { id: pluginId, state: 'active' }
      },
      openUrl: async (url) => { calls.push(`open:${url}`) },
      write: (text) => { chunks.push(text); calls.push(`print:${text.trim()}`) },
      baseUrl: () => BASE_URL,
      canOpen: () => options.canOpen ?? true,
    },
  }
  return state
}

/** Steps only: prints are noise here, except the App URL, whose place matters. */
function steps(calls: string[]): string[] {
  return calls.filter((call) => !call.startsWith('print:') || call.startsWith('print:App: '))
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('Plugin CLI app route', () => {
  it('derives the App route from the plugin id and the host base URL', () => {
    expect(DEFAULT_APP_ID).toBe('main')
    expect(appPath(PLUGIN_ID)).toBe(`/apps/${PLUGIN_ID}~main`)
    expect(appPath(PLUGIN_ID, 'reports')).toBe(`/apps/${PLUGIN_ID}~reports`)
    expect(appUrl(PLUGIN_ID, BASE_URL)).toBe(APP_URL)
    expect(appUrl(PLUGIN_ID, 'http://walnut.local:4000')).toBe(`http://walnut.local:4000/apps/${PLUGIN_ID}~main`)
  })

  it('follows OPEN_WALNUT_API_URL, so the printed URL is the host the CLI talked to', () => {
    const previous = process.env.OPEN_WALNUT_API_URL
    process.env.OPEN_WALNUT_API_URL = 'http://192.168.1.9:3456'
    try {
      expect(appUrl(PLUGIN_ID)).toBe(`http://192.168.1.9:3456/apps/${PLUGIN_ID}~main`)
    } finally {
      if (previous === undefined) delete process.env.OPEN_WALNUT_API_URL
      else process.env.OPEN_WALNUT_API_URL = previous
    }
  })
})

describe('walnut-plugin new --dev', () => {
  it('scaffolds, installs, builds once, links, discovers, reloads, then prints the App URL', async () => {
    const parent = await temporaryRoot()
    const directory = path.join(parent, PLUGIN_ID)
    const test = harness()

    const result = await runNew({
      id: PLUGIN_ID,
      directory,
      template: 'both',
      dev: true,
      deps: test.deps,
    })

    // The scaffold is real: only the steps AFTER it are injected.
    expect(result.root).toBe(directory)
    expect(existsSync(path.join(directory, 'manifest.json'))).toBe(true)
    expect(existsSync(path.join(directory, 'skills', PLUGIN_ID, 'SKILL.md'))).toBe(true)

    expect(steps(test.calls)).toEqual([
      `install:${directory}`,
      `validate:${directory}`,
      'build:watch=true',
      'link',
      `discover:${PLUGIN_ID}`,
      `reload:${PLUGIN_ID}`,
      `status:${PLUGIN_ID}`,
      `print:App: ${APP_URL}`,
    ])
    // One build, not two: the watch context's first build IS the build.
    expect(test.builds).toBe(1)
    expect(result.session?.state).toBe('active')
    expect(result.session?.appUrl).toBe(APP_URL)
    expect(test.output).toContain(`active: ${PLUGIN_ID}`)
    expect(test.output).toContain(directory)
  })

  it('--no-install skips npm install and changes nothing else', async () => {
    const parent = await temporaryRoot()
    const directory = path.join(parent, PLUGIN_ID)
    const test = harness()

    await runNew({ id: PLUGIN_ID, directory, dev: true, install: false, deps: test.deps })

    expect(test.calls.some((call) => call.startsWith('install:'))).toBe(false)
    expect(steps(test.calls)).toEqual([
      `validate:${directory}`,
      'build:watch=true',
      'link',
      `discover:${PLUGIN_ID}`,
      `reload:${PLUGIN_ID}`,
      `status:${PLUGIN_ID}`,
      `print:App: ${APP_URL}`,
    ])
  })

  it('without --dev it only scaffolds, touching neither npm nor the running Walnut', async () => {
    const parent = await temporaryRoot()
    const directory = path.join(parent, PLUGIN_ID)
    const test = harness()

    const result = await runNew({ id: PLUGIN_ID, directory, deps: test.deps })

    expect(result.session).toBeUndefined()
    expect(steps(test.calls)).toEqual([])
    expect(test.output.trim()).toBe(directory)
  })
})

describe('walnut-plugin dev', () => {
  it('reloads on a watch rebuild, and only after the first link', async () => {
    const test = harness()
    const session = await runDev({ root: '/tmp/walnut-dev-fixture', deps: test.deps })
    const afterStart = test.calls.length

    await test.rebuild()

    expect(steps(test.calls.slice(afterStart))).toEqual([
      `discover:${PLUGIN_ID}`,
      `reload:${PLUGIN_ID}`,
      `status:${PLUGIN_ID}`,
    ])
    expect(test.output).toContain('rebuilt')

    await session.stop()
    expect(test.calls).toContain('stop')
  })

  it('reports offline without pretending the plugin loaded', async () => {
    const test = harness({
      discover: async () => {
        throw new ApiError(`Walnut at ${BASE_URL} did not answer within 3000ms (fetch failed)`, { offline: true })
      },
    })

    const session = await runDev({ root: '/tmp/walnut-dev-fixture', open: true, deps: test.deps })

    expect(session.state).toBe('offline')
    expect(test.output).toContain('offline:')
    expect(test.output).toContain("the link loads on Walnut's next start")
    expect(test.output).not.toContain('active:')
    // A dead server gets no reload and no browser, but the URL is still where the App will be.
    expect(test.calls.some((call) => call.startsWith('reload:'))).toBe(false)
    expect(test.calls.some((call) => call.startsWith('open:'))).toBe(false)
    expect(test.output).toContain(`App: ${APP_URL}`)
  })

  it('reports a refusal from a live Walnut as a failure, not as offline', async () => {
    const test = harness({
      reload: async () => { throw new ApiError('Plugin quarantined after 3 crashes', { status: 409 }) },
    })

    const session = await runDev({ root: '/tmp/walnut-dev-fixture', deps: test.deps })

    expect(session.state).toBe('failed')
    expect(test.output).toContain('failed: Plugin quarantined after 3 crashes')
    expect(test.output).not.toContain('offline:')
    expect(test.output).not.toContain('active:')
  })

  it('trusts the status read over a successful reload', async () => {
    const test = harness({ status: { id: PLUGIN_ID, state: 'quarantined', error: 'activate threw' } })

    const session = await runDev({ root: '/tmp/walnut-dev-fixture', deps: test.deps })

    expect(session.state).toBe('failed')
    expect(test.output).toContain(`failed: ${PLUGIN_ID} is quarantined: activate threw`)
  })

  it('falls back to reload when the Walnut it found cannot discover', async () => {
    // An older build has no such route at all: a 404 with no JSON error of its own.
    const older = harness({
      discover: async () => {
        throw new ApiError('Walnut API returned 404', { status: 404, routeMissing: true })
      },
    })
    const olderSession = await runDev({ root: '/tmp/walnut-dev-fixture', deps: older.deps })
    expect(olderSession.state).toBe('active')
    expect(older.output).toContain('no discover route')
    expect(older.calls).toContain(`reload:${PLUGIN_ID}`)

    // A replica answers 501: it does not own the plugin directory.
    const replica = harness({
      discover: async () => { throw new ApiError('Plugin discovery is unavailable', { status: 501 }) },
    })
    const replicaSession = await runDev({ root: '/tmp/walnut-dev-fixture', deps: replica.deps })
    expect(replicaSession.state).toBe('active')
    expect(replica.calls).toContain(`reload:${PLUGIN_ID}`)
  })

  it('treats a discover route that ran and found nothing as a real failure', async () => {
    // Same status, opposite meaning: the route answered, so reloading would only hide a real miss.
    const test = harness({
      discover: async () => {
        throw new ApiError(`Plugin "${PLUGIN_ID}" is not discovered`, { status: 404 })
      },
    })

    const session = await runDev({ root: '/tmp/walnut-dev-fixture', deps: test.deps })

    expect(session.state).toBe('failed')
    expect(test.output).toContain('is not discovered')
    expect(test.output).not.toContain('no discover route')
    expect(test.calls.some((call) => call.startsWith('reload:'))).toBe(false)
  })

  it('opens the App only for an interactive terminal that is not CI', async () => {
    const opened = harness()
    await runDev({ root: '/tmp/walnut-dev-fixture', open: true, deps: opened.deps })
    expect(opened.calls).toContain(`open:${APP_URL}`)
    // The URL prints before the browser call, so a failed open still leaves something to click.
    expect(opened.calls.indexOf(`print:App: ${APP_URL}`)).toBeLessThan(opened.calls.indexOf(`open:${APP_URL}`))

    const headless = harness({ canOpen: false })
    await runDev({ root: '/tmp/walnut-dev-fixture', open: true, deps: headless.deps })
    expect(headless.calls.some((call) => call.startsWith('open:'))).toBe(false)
    expect(headless.output).toContain('not opening a browser')

    const never = harness()
    await runDev({ root: '/tmp/walnut-dev-fixture', deps: never.deps })
    expect(never.calls.some((call) => call.startsWith('open:'))).toBe(false)
  })

  it('prints no App URL for a plugin with no web surface', async () => {
    const test = harness({ manifest: { web: undefined } })

    const session = await runDev({ root: '/tmp/walnut-dev-fixture', open: true, deps: test.deps })

    expect(session.appUrl).toBeUndefined()
    expect(test.output).not.toContain('/apps/')
    expect(test.calls.some((call) => call.startsWith('open:'))).toBe(false)
    expect(session.state).toBe('active')
  })

  it('refuses to link an invalid manifest', async () => {
    const test = harness()
    test.deps.validate = async () => ({ errors: ['manifest.apiVersion must be 1'], warnings: [] })

    await expect(runDev({ root: '/tmp/walnut-dev-fixture', deps: test.deps })).rejects.toThrow(/apiVersion must be 1/)
    expect(test.calls.some((call) => call === 'link')).toBe(false)
  })

  it('stops the watcher when a step after the build throws', async () => {
    const test = harness()
    test.deps.link = async () => { throw new Error('link target already exists and is not a symlink') }

    await expect(runDev({ root: '/tmp/walnut-dev-fixture', deps: test.deps })).rejects.toThrow(/not a symlink/)

    // The build already started a watcher, so a failure must dispose it or the CLI hangs with no plugin loaded.
    expect(test.calls).toContain('stop')
    expect(test.calls.some((call) => call.startsWith('discover:'))).toBe(false)
    expect(test.calls.some((call) => call.startsWith('reload:'))).toBe(false)
  })

  it('stops the watcher when printing or opening throws', async () => {
    const test = harness()
    test.deps.openUrl = async () => { throw new Error('no browser here') }

    await expect(runDev({ root: '/tmp/walnut-dev-fixture', open: true, deps: test.deps }))
      .rejects.toThrow(/no browser here/)
    expect(test.calls).toContain('stop')
  })

  it('reports a plugin the running Walnut does not list', async () => {
    const test = harness({ status: undefined })

    const session = await runDev({ root: '/tmp/walnut-dev-fixture', deps: test.deps })

    expect(session.state).toBe('failed')
    expect(test.output).toContain("is not in the running Walnut's plugin list")
  })
})

describe('walnut-plugin dev against a real watcher', () => {
  // The one case a stub cannot cover: esbuild's own watch, where rebuild()+watch() used to build twice and fake a save.
  it('builds once at startup, then reloads on a real save', async () => {
    const parent = await temporaryRoot()
    const root = path.join(parent, 'watched-plugin')
    await scaffoldPlugin('watched-plugin', root, { template: 'server' })

    const test = harness({ manifest: { id: 'watched-plugin' } })
    const syncs = () => test.calls.filter((call) => call.startsWith('reload:')).length
    // Real validate, real esbuild; only the host-facing steps stay injected.
    const session = await runDev({
      root,
      deps: {
        link: test.deps.link,
        discover: async () => { test.calls.push('discover:watched-plugin') },
        reload: async () => { test.calls.push('reload:watched-plugin') },
        status: async () => ({ id: 'watched-plugin', state: 'active' }),
        write: test.deps.write,
        baseUrl: test.deps.baseUrl,
        canOpen: () => false,
      },
    })

    try {
      expect(session.state).toBe('active')
      expect(existsSync(path.join(root, 'dist', 'server.mjs'))).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 700))
      expect(syncs()).toBe(1)
      expect(test.output).not.toContain('rebuilt')

      await fs.writeFile(
        path.join(root, 'src', 'server.ts'),
        `${await fs.readFile(path.join(root, 'src', 'server.ts'), 'utf8')}\nexport const touched = true\n`,
      )
      const deadline = Date.now() + 15_000
      while (syncs() < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(syncs()).toBe(2)
      expect(test.output).toContain('rebuilt')
    } finally {
      await session.stop()
    }
  })

  it('fails the whole run when the first build is broken, leaving no watcher behind', async () => {
    const parent = await temporaryRoot()
    const root = path.join(parent, 'broken-plugin')
    await scaffoldPlugin('broken-plugin', root, { template: 'server' })
    await fs.writeFile(path.join(root, 'src', 'server.ts'), 'export function activate( {\n')

    const test = harness()
    await expect(runDev({
      root,
      deps: { link: test.deps.link, write: test.deps.write, baseUrl: test.deps.baseUrl },
    })).rejects.toThrow()
    // Nothing was linked or reloaded, so a broken save cannot take a plugin live.
    expect(test.calls).not.toContain('link')
    expect(test.calls.some((call) => call.startsWith('reload:'))).toBe(false)
  })
})

describe('Plugin CLI HTTP deadline', () => {
  it('bounds every call and reports a dead server as offline', async () => {
    expect(API_TIMEOUT_MS).toBe(3000)

    const seen: Array<{ url: string; signal: boolean; body: unknown }> = []
    vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      seen.push({ url: String(url), signal: !!init.signal, body: init.body })
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    await apiRequest('/api/plugin-runtime/discover', {
      method: 'POST',
      body: JSON.stringify({ pluginId: PLUGIN_ID }),
    })
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe(`${BASE_URL}/api/plugin-runtime/discover`)
    expect(seen[0].signal).toBe(true)
    expect(seen[0].body).toBe(`{"pluginId":"${PLUGIN_ID}"}`)

    vi.stubGlobal('fetch', async () => { throw new Error('fetch failed') })
    const offline = await apiRequest('/api/plugin-runtime').catch((error) => error)
    expect(offline).toBeInstanceOf(ApiError)
    expect((offline as ApiError).offline).toBe(true)
    expect((offline as ApiError).message).toContain('did not answer within 3000ms')

    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'nope' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    }))
    const refused = await apiRequest('/api/plugin-runtime').catch((error) => error)
    expect(refused).toBeInstanceOf(ApiError)
    expect((refused as ApiError).offline).toBe(false)
    expect((refused as ApiError).status).toBe(500)
    expect((refused as ApiError).message).toBe('nope')
    expect((refused as ApiError).routeMissing).toBe(false)
  })

  it('keeps the deadline when a caller passes its own signal', async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    vi.stubGlobal('fetch', async (_url: URL, init: RequestInit) => {
      seen = init.signal ?? undefined
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    })

    await apiRequest('/api/plugin-runtime', { signal: controller.signal })

    // A caller signal is COMPOSED with the timeout, never a substitute for it.
    expect(seen).toBeInstanceOf(AbortSignal)
    expect(seen).not.toBe(controller.signal)
    expect(seen?.aborted).toBe(false)
    controller.abort(new Error('caller went away'))
    expect(seen?.aborted).toBe(true)
  })

  it('separates a missing route from a route that answered 404', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>Cannot POST</html>', {
      status: 404,
      headers: { 'content-type': 'text/html' },
    }))
    const missing = await apiRequest('/api/plugin-runtime/discover', { method: 'POST' }).catch((error) => error)
    expect((missing as ApiError).routeMissing).toBe(true)
    expect((missing as ApiError).message).toBe('Walnut API returned 404')

    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'is not discovered' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    }))
    const answered = await apiRequest('/api/plugin-runtime/discover', { method: 'POST' }).catch((error) => error)
    expect((answered as ApiError).routeMissing).toBe(false)
    expect((answered as ApiError).message).toBe('is not discovered')
  })

  it('syncPlugin reads the discover body the server route expects', async () => {
    const bodies: unknown[] = []
    const deps = harness().deps
    deps.discover = async (pluginId) => { bodies.push({ pluginId }) }
    const report = await syncPlugin(PLUGIN_ID, deps)
    expect(bodies).toEqual([{ pluginId: PLUGIN_ID }])
    expect(report.state).toBe('active')
  })
})
