/**
 * The host side of an engine CLI's sign-in and install (src/providers/acp-engine-sign-in.ts),
 * against a fake `agy` that prints the real CLI's words (tests/fixtures/antigravity/fake-agy.mjs):
 * the link and code checks, and the sign-in's states (link handed out, reused, code good / bad /
 * hanging, cancelled, gone stale), the account check, the sign-out and the install.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import { ENGINE_SIGN_INS, SIGN_IN_CODE_MAX, signInCodeOf, signInLinkOf } from '../../src/providers/acp-engine-sign-in.js'
import { ENGINE_REGISTRY } from '../../src/core/agents/engine-registry.js'
import { hostAdapterSpec } from '../../src/core/agents/host-adapter-spec.js'
import { descriptorAdapterEnv } from '../../src/providers/acp-worker/adapter-env.js'
import { fakeHostSignIn, makeFakeAgyHome, type FakeAgyHome } from '../helpers/fake-agy.js'

const spec = ENGINE_SIGN_INS.antigravity
const GOOGLE = 'https://accounts.google.com/o/oauth2/auth?client_id=x&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=s'
const descriptorEnv = descriptorAdapterEnv(ENGINE_REGISTRY.get('antigravity')!.acpAdapter)!

const homes: FakeAgyHome[] = []
function home(opts?: { installed?: boolean }): FakeAgyHome { const h = makeFakeAgyHome(opts); homes.push(h); return h }
afterEach(() => { for (const h of homes.splice(0)) h.cleanup() })

function alive(pid: number | undefined): boolean {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

async function until(fn: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('the sign-in table agrees with the engine registry', () => {
  it('names the registry\'s binary, override variable, ACP argv and installer', () => {
    const adapter = ENGINE_REGISTRY.get('antigravity')!.acpAdapter!
    const host = hostAdapterSpec('antigravity')!
    expect(spec.binary).toBe(adapter.binary)
    expect(spec.acpArgs).toEqual(adapter.args)
    expect(spec.overrideEnv).toBe(host.overrideEnv)
    expect(adapter.install).toBe(`curl -fsSL ${spec.installerUrl} | bash`)
    expect(adapter.auth?.otherwise).toBe(spec.accountMethod)
    expect(adapter.auth?.byEnv?.[0]?.[0]).toBe(spec.apiKeyEnv)
    // Every table entry is a registered engine.
    for (const engine of Object.keys(ENGINE_SIGN_INS)) expect(ENGINE_REGISTRY.has(engine as never)).toBe(true)
  })
})

describe('signInLinkOf', () => {
  it('takes the Google sign-in link out of the CLI\'s words', () => {
    const text = `Open this link in a browser to log in with Google:\n\n  ${GOOGLE}\n\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\n`
    expect(signInLinkOf(text, spec)).toBe(new URL(GOOGLE).toString())
  })
  it('refuses a link to another site, another path, plain http, or another redirect', () => {
    expect(signInLinkOf(GOOGLE.replace('accounts.google.com', 'accounts.google.com.evil.example'), spec)).toBeNull()
    expect(signInLinkOf(GOOGLE.replace('/o/oauth2/', '/signin/'), spec)).toBeNull()
    expect(signInLinkOf(GOOGLE.replace('https://', 'http://'), spec)).toBeNull()
    expect(signInLinkOf(GOOGLE.replace('antigravity.google%2Foauth-callback', 'evil.example%2Fcb'), spec)).toBeNull()
    expect(signInLinkOf(GOOGLE.replace('&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback', ''), spec)).toBeNull()
    expect(signInLinkOf('no link at all', spec)).toBeNull()
    expect(signInLinkOf(`https://accounts.google.com@evil.example/o/oauth2/auth?redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback`, spec)).toBeNull()
  })
})

describe('signInCodeOf', () => {
  it('trims one line and keeps a full landing URL', () => {
    expect(signInCodeOf('  4/0AbC-def_123  ')).toEqual({ code: '4/0AbC-def_123' })
    const url = 'https://antigravity.google/oauth-callback?code=4%2F0Ab&state=x'
    expect(signInCodeOf(url)).toEqual({ code: url })
  })
  it('refuses empty, non-text, too long, several lines and control characters', () => {
    expect(signInCodeOf('   ')).toHaveProperty('error')
    expect(signInCodeOf(42)).toHaveProperty('error')
    expect(signInCodeOf(undefined)).toHaveProperty('error')
    expect(signInCodeOf('x'.repeat(SIGN_IN_CODE_MAX + 1))).toHaveProperty('error')
    expect(signInCodeOf('x'.repeat(SIGN_IN_CODE_MAX))).toEqual({ code: 'x'.repeat(SIGN_IN_CODE_MAX) })
    expect(signInCodeOf('good\nrm -rf ~')).toHaveProperty('error')
    expect(signInCodeOf('good\rmore')).toHaveProperty('error')
    expect(signInCodeOf('a\u0000b')).toHaveProperty('error')
    expect(signInCodeOf('a\u001bb')).toHaveProperty('error')
  })
})

describe('the sign-in on a host', () => {
  it('hands out the link, takes a good code, and the account check then says signed in', async () => {
    const h = home()
    const si = fakeHostSignIn(h)
    const before = await si.status({ engine: 'antigravity', env: descriptorEnv })
    expect(before).toMatchObject({ ok: true, installed: true, version: '1.5.14', account: { signedIn: false }, signIn: null })
    const started = await si.start({ engine: 'antigravity', env: descriptorEnv }) as Record<string, unknown>
    expect(started).toMatchObject({ ok: true, phase: 'waiting_code' })
    expect(String(started.link)).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?/)
    expect(Number(started.expiresAt) - Number(started.startedAt)).toBe(10 * 60_000)
    // The env every agy process gets: file storage, and an SSH_CONNECTION where the host has none.
    expect(JSON.parse(fs.readFileSync(h.envSeenFile, 'utf8'))).toMatchObject({ AGY_ACP_FORCE_FILE_STORAGE: '1', SSH_CONNECTION: '127.0.0.1 0 127.0.0.1 0', args: ['acp', '--login'] })
    // A second start while it waits is the same sign-in.
    const again = await si.start({ engine: 'antigravity', env: descriptorEnv })
    expect(again).toMatchObject({ ok: true, reused: true, id: started.id, link: started.link })
    expect((await si.status({ engine: 'antigravity', env: descriptorEnv }) as Record<string, unknown>).signIn).toMatchObject({ id: started.id })
    const done = await si.finish({ engine: 'antigravity', signInId: started.id, code: '  good  ' })
    expect(done).toEqual({ ok: true, signedIn: true })
    expect(fs.existsSync(h.signedInFile)).toBe(true)
    const after = await si.status({ engine: 'antigravity', env: descriptorEnv })
    expect(after).toMatchObject({ installed: true, account: { signedIn: true, canLogout: true }, signIn: null })
    // Sign out: agy's own ACP logout.
    expect(await si.logout({ engine: 'antigravity', env: descriptorEnv })).toEqual({ ok: true })
    expect(fs.existsSync(h.signedInFile)).toBe(false)
    expect(await si.status({ engine: 'antigravity', env: descriptorEnv })).toMatchObject({ account: { signedIn: false } })
  })

  it('answers a bad code in the CLI\'s words, without the code, and the sign-in is over', async () => {
    const si = fakeHostSignIn(home())
    const started = await si.start({ engine: 'antigravity', env: descriptorEnv }) as Record<string, unknown>
    const code = 'not-a-real-code-123'
    const r = await si.finish({ engine: 'antigravity', signInId: started.id, code }) as Record<string, unknown>
    expect(r).toMatchObject({ ok: false, code: 'bad_code' })
    expect(String(r.message)).toMatch(/couldn't log in: token exchange failed/)
    expect(JSON.stringify(r)).not.toContain(code)
    expect(await si.finish({ engine: 'antigravity', signInId: started.id, code: 'good' })).toMatchObject({ ok: false, code: 'no_sign_in' })
    // A new start is a new sign-in.
    const next = await si.start({ engine: 'antigravity', env: descriptorEnv }) as Record<string, unknown>
    expect(next.id).not.toBe(started.id)
    expect(next.reused).toBeUndefined()
    si.cancel({ engine: 'antigravity' })
  })

  it('refuses a code that is not one line, and the sign-in still waits for a good one', async () => {
    const si = fakeHostSignIn(home())
    const started = await si.start({ engine: 'antigravity', env: descriptorEnv }) as Record<string, unknown>
    expect(await si.finish({ engine: 'antigravity', signInId: started.id, code: 'good\nmore' })).toMatchObject({ ok: false, code: 'invalid_code' })
    expect(await si.finish({ engine: 'antigravity', signInId: 'si-other', code: 'good' })).toMatchObject({ ok: false, code: 'no_sign_in' })
    expect(await si.finish({ engine: 'antigravity', signInId: started.id, code: 'good' })).toEqual({ ok: true, signedIn: true })
  })

  it('ends a code check that never answers at its deadline, and stops the process', async () => {
    const si = fakeHostSignIn(home(), { finish: 600 })
    const started = await si.start({ engine: 'antigravity', env: descriptorEnv }) as Record<string, unknown>
    const view = await si.status({ engine: 'antigravity', env: descriptorEnv }) as { signIn: { id: string } }
    expect(view.signIn.id).toBe(started.id)
    const r = await si.finish({ engine: 'antigravity', signInId: started.id, code: 'hang' })
    expect(r).toMatchObject({ ok: false, code: 'timeout' })
    expect((await si.status({ engine: 'antigravity', env: descriptorEnv }) as Record<string, unknown>).signIn).toBeNull()
  })

  it('cancel ends only that sign-in\'s process', async () => {
    const h = home()
    const si = fakeHostSignIn(h)
    const a = await si.start({ engine: 'antigravity', env: descriptorEnv }) as Record<string, unknown>
    // The waiting fake CLI of this HOME (Linux: read from /proc).
    const pidOf = () => {
      return Number(fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).find((d) => {
        try { return fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').includes('fake-agy.mjs') && fs.readFileSync(`/proc/${d}/environ`, 'utf8').includes(h.home) } catch { return false }
      }))
    }
    const linux = process.platform === 'linux'
    const pidA = linux ? pidOf() : 0
    if (linux) expect(alive(pidA)).toBe(true)
    expect(si.cancel({ engine: 'antigravity', signInId: 'si-someone-else' })).toEqual({ ok: true, cancelled: false })
    expect(si.cancel({ engine: 'antigravity', signInId: a.id })).toEqual({ ok: true, cancelled: true })
    if (linux) await until(() => !alive(pidA))
    expect(await si.finish({ engine: 'antigravity', signInId: a.id, code: 'good' })).toMatchObject({ code: 'no_sign_in' })
    // A new sign-in starts after it.
    const b = await si.start({ engine: 'antigravity', env: descriptorEnv }) as Record<string, unknown>
    expect(b).toMatchObject({ ok: true })
    expect(b.id).not.toBe(a.id)
    si.cancel({ engine: 'antigravity' })
  })

  it('a sign-in nobody finishes ends after its stale time', async () => {
    const si = fakeHostSignIn(home(), { stale: 300 })
    const s = await si.start({ engine: 'antigravity', env: descriptorEnv }) as Record<string, unknown>
    await new Promise((r) => setTimeout(r, 600))
    expect((await si.status({ engine: 'antigravity', env: descriptorEnv }) as Record<string, unknown>).signIn).toBeNull()
    expect(await si.finish({ engine: 'antigravity', signInId: s.id, code: 'good' })).toMatchObject({ code: 'no_sign_in' })
  })

  it('refuses a link to another site, a CLI that ends before its link, and one that never shows it', async () => {
    const h = home()
    const si = fakeHostSignIn(h, { link: 600 })
    const env = (mode: string) => ({ ...descriptorEnv, FAKE_AGY_LOGIN: mode })
    expect(await si.start({ engine: 'antigravity', env: env('other-link') })).toMatchObject({ ok: false, code: 'bad_link' })
    const ended = await si.start({ engine: 'antigravity', env: env('exit') }) as Record<string, unknown>
    expect(ended).toMatchObject({ ok: false, code: 'failed' })
    expect(String(ended.message)).toContain('login unavailable')
    expect(await si.start({ engine: 'antigravity', env: env('silent') })).toMatchObject({ ok: false, code: 'timeout' })
    // None of them is left as the host's sign-in.
    expect((await si.status({ engine: 'antigravity', env: descriptorEnv }) as Record<string, unknown>).signIn).toBeNull()
  })

  it('an unknown engine or op is refused, and a host without the CLI says so', async () => {
    const si = fakeHostSignIn(home({ installed: false }))
    expect(await si.handle({ op: 'start', engine: 'claude' })).toMatchObject({ ok: false, code: 'unknown_engine' })
    expect(await si.handle({ op: 'rm', engine: 'antigravity' })).toMatchObject({ ok: false, code: 'unknown_op' })
    expect(await si.handle({ op: 'status', engine: 'antigravity' })).toMatchObject({ ok: true, installed: false, reason: 'agy is not installed', account: null })
    expect(await si.handle({ op: 'start', engine: 'antigravity' })).toMatchObject({ ok: false, code: 'not_installed' })
  })
})

/** The fake CLI processes of one HOME (Linux: read from /proc), or null where /proc is not there. */
function fakeProcs(h: FakeAgyHome): number[] | null {
  if (process.platform !== 'linux') return null
  return fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).filter((d) => {
    try { return fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').includes('fake-agy.mjs') && fs.readFileSync(`/proc/${d}/environ`, 'utf8').includes(h.home) } catch { return false }
  }).map(Number)
}

describe('two starts at once', () => {
  it('start one sign-in: the second waits for the first one\'s link and answers it as reused', async () => {
    const h = home()
    const si = fakeHostSignIn(h)
    const [a, b] = await Promise.all([si.start({ engine: 'antigravity', env: descriptorEnv }), si.start({ engine: 'antigravity', env: descriptorEnv })]) as Array<Record<string, unknown>>
    expect(a).toMatchObject({ ok: true })
    expect(b).toMatchObject({ ok: true, reused: true, id: a.id, link: a.link })
    expect(a.reused).toBeUndefined()
    const procs = fakeProcs(h)
    if (procs) expect(procs).toHaveLength(1)
    expect(await si.finish({ engine: 'antigravity', signInId: a.id, code: 'good' })).toEqual({ ok: true, signedIn: true })
  })

  it('a cancel while the first one starts ends it, and the waiting start says so', async () => {
    const si = fakeHostSignIn(home(), { link: 800 })
    const env = { ...descriptorEnv, FAKE_AGY_LOGIN: 'silent' }
    const first = si.start({ engine: 'antigravity', env })
    const second = si.start({ engine: 'antigravity', env })
    await new Promise((r) => setTimeout(r, 100))
    expect(si.cancel({ engine: 'antigravity' })).toEqual({ ok: true, cancelled: true })
    const [a, b] = await Promise.all([first, second]) as Array<Record<string, unknown>>
    expect(a.ok).toBe(false)
    expect(b.ok).toBe(false)
    expect((await si.status({ engine: 'antigravity', env: descriptorEnv }) as Record<string, unknown>).signIn).toBeNull()
  })
})

describe('a sign-in process that stops reading its stdin', () => {
  it('the code written to it is no crash (EPIPE): the finish answers how the process ended', async () => {
    const si = fakeHostSignIn(home())
    const started = await si.start({ engine: 'antigravity', env: { ...descriptorEnv, FAKE_AGY_LOGIN: 'close-stdin' } }) as Record<string, unknown>
    expect(started.ok).toBe(true)
    // Its stdin is closed by now: the write fails asynchronously, with no reader.
    await new Promise((r) => setTimeout(r, 400))
    const r = await si.finish({ engine: 'antigravity', signInId: started.id, code: 'good' }) as Record<string, unknown>
    expect(r).toMatchObject({ ok: false, code: 'bad_code' })
    expect(String(r.message)).toContain('stopped reading')
    // A vitest run fails on an uncaught EPIPE; this one has a listener on every stream.
  })
})

describe('the install on a host', () => {
  const state = async (si: ReturnType<typeof fakeHostSignIn>) => await si.installStatus({ engine: 'antigravity', env: descriptorEnv }) as Record<string, unknown>

  it('runs the official installer through curl | bash, then finds the CLI; a second install is refused', async () => {
    const h = home({ installed: false })
    const si = fakeHostSignIn(h)
    expect(await state(si)).toMatchObject({ ok: true, state: 'idle' })
    expect(await si.install({ engine: 'antigravity', env: descriptorEnv })).toMatchObject({ ok: true, state: 'running' })
    await until(async () => (await state(si)).state !== 'running', 15_000)
    expect(await state(si)).toMatchObject({ ok: true, state: 'done', installed: true, version: '1.5.14', exitCode: 0, path: h.agy })
    expect(String((await state(si)).log)).toContain('installed agy')
    expect(fs.readFileSync(`${h.root}/curl-url`, 'utf8').trim()).toBe(spec.installerUrl)
    expect(await si.install({ engine: 'antigravity', env: descriptorEnv })).toMatchObject({ ok: false, code: 'installed' })
    expect(await si.status({ engine: 'antigravity', env: descriptorEnv })).toMatchObject({ installed: true, install: { state: 'done' } })
  })

  it('an installer that fails says so, and the CLI stays missing', async () => {
    const h = home({ installed: false })
    fs.writeFileSync(`${h.root}/installer.sh`, 'echo "download failed" >&2\nexit 3\n')
    const si = fakeHostSignIn(h)
    await si.install({ engine: 'antigravity', env: descriptorEnv })
    await until(async () => (await state(si)).state !== 'running', 15_000)
    const r = await state(si)
    expect(r).toMatchObject({ state: 'failed', installed: false, exitCode: 3 })
    expect(String(r.log)).toContain('download failed')
    expect(String(r.error)).toContain('agy is not installed')
  })

  it('outlives its daemon: the next daemon on the host reads it running, then done', async () => {
    const h = home({ installed: false })
    // A slow installer: still running when its daemon goes.
    fs.writeFileSync(`${h.root}/installer.sh`, `sleep 1\n${fs.readFileSync(`${h.root}/installer.sh`, 'utf8')}`)
    const first = fakeHostSignIn(h)
    expect(await first.install({ engine: 'antigravity', env: descriptorEnv })).toMatchObject({ ok: true, state: 'running' })
    // The next daemon: nothing in memory, the same state dir.
    const next = fakeHostSignIn(h)
    expect(await state(next)).toMatchObject({ state: 'running' })
    expect(await next.install({ engine: 'antigravity', env: descriptorEnv })).toMatchObject({ ok: true, state: 'running' })
    await until(async () => (await state(next)).state !== 'running', 15_000)
    expect(await state(next)).toMatchObject({ state: 'done', installed: true, exitCode: 0 })
    // Its output went to a file, never a pipe a daemon held.
    expect(fs.readFileSync(`${h.root}/daemon/engine-install/antigravity.log`, 'utf8')).toContain('installed agy')
  })

  it('no sign-in starts while an install runs, and no install while a sign-in waits', async () => {
    const missing = home({ installed: false })
    fs.writeFileSync(`${missing.root}/installer.sh`, `sleep 1\n${fs.readFileSync(`${missing.root}/installer.sh`, 'utf8')}`)
    const a = fakeHostSignIn(missing)
    await a.install({ engine: 'antigravity', env: descriptorEnv })
    expect(await a.start({ engine: 'antigravity', env: descriptorEnv })).toMatchObject({ ok: false, code: 'busy' })
    await until(async () => (await state(a)).state !== 'running', 15_000)
    const s = await a.start({ engine: 'antigravity', env: descriptorEnv }) as Record<string, unknown>
    expect(s.ok).toBe(true)
    expect(await a.install({ engine: 'antigravity', env: descriptorEnv })).toMatchObject({ ok: false, code: 'busy' })
    a.cancel({ engine: 'antigravity' })
  })
})
