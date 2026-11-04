/**
 * `walnut pass` (src/core/vault/pass-cli.ts): its words, the wait for a person's approval,
 * `run` giving a command its secrets as env vars, and the masking that keeps them out of what
 * the command prints, across chunk boundaries and in a real child process. Fake values only.
 */
import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'
import { createMasker, MASK, parseEnvSpec, parsePassArgv, runPass, spawnMasked, PASS_EXIT, type OpResult, type PassIo } from '../../../src/core/vault/pass-cli.js'

function io(answers: Record<string, Array<OpResult | ((args: Record<string, unknown>) => OpResult)>>, extra: Partial<PassIo> = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const said: string[] = []
  let out = ''
  const value: PassIo = {
    call: async (name, args) => {
      calls.push({ name, args })
      const next = answers[name]?.shift()
      if (!next) return { ok: false, message: `no answer for ${name}` }
      return typeof next === 'function' ? next(args) : next
    },
    say: (l) => { said.push(l) },
    out: (t) => { out += t },
    sleep: async () => {},
    ...extra,
  }
  return { io: value, calls, said, out: () => out }
}

const released = (values: Record<string, string>, item: Record<string, unknown> = { id: 'i1', title: 'GitHub' }): OpResult =>
  ({ ok: true, result: { status: 'released', item, values, via: 'allow' } })

describe('pass words', () => {
  it('parses list, get and run', () => {
    expect(parsePassArgv(['list', 'git', 'hub', '--site', 'https://github.com/login'])).toEqual({ ok: true, kind: 'list', query: 'git hub', site: 'https://github.com/login', json: false })
    expect(parsePassArgv(['get', 'GitHub', '--purpose', 'push the fix', '--field', 'username', '--field', 'password', '--task']))
      .toEqual({ ok: true, kind: 'get', item: 'GitHub', fields: ['username', 'password'], purpose: 'push the fix', task: true, json: false })
    const run = parsePassArgv(['run', '-p', 'deploy the test app', '--env', 'GH_TOKEN=GitHub', '--env', 'STRIPE_API_KEY', '--', 'deploy.sh', '--prod'])
    expect(run).toEqual({ ok: true, kind: 'run', purpose: 'deploy the test app', task: false, cmd: 'deploy.sh', args: ['--prod'], env: [{ name: 'GH_TOKEN', item: 'GitHub' }, { item: 'STRIPE_API_KEY' }] })
  })

  it('needs a purpose, one item, and a command after --', () => {
    expect(parsePassArgv(['get', 'GitHub'])).toMatchObject({ ok: false, error: expect.stringMatching(/purpose/) })
    expect(parsePassArgv(['get', 'a', 'b', '--purpose', 'why not'])).toMatchObject({ ok: false })
    expect(parsePassArgv(['run', '--purpose', 'run it', '--env', 'X=y'])).toMatchObject({ ok: false, error: expect.stringMatching(/command/) })
    expect(parsePassArgv(['run', '--purpose', 'run it', '--', 'ls'])).toMatchObject({ ok: false, error: expect.stringMatching(/--env/) })
    expect(parsePassArgv(['nope'])).toMatchObject({ ok: false })
  })

  it('reads an env spec with a field, a site and a plain item', () => {
    expect(parseEnvSpec('DB_USER=Prod DB:username')).toEqual({ name: 'DB_USER', item: 'Prod DB', field: 'username' })
    expect(parseEnvSpec('TOKEN=github.com')).toEqual({ name: 'TOKEN', item: 'github.com' })
    expect(parseEnvSpec('URL=https://git.example.test')).toEqual({ name: 'URL', item: 'https://git.example.test' })
    expect(parseEnvSpec('OPENAI_API_KEY')).toEqual({ item: 'OPENAI_API_KEY' })
  })
})

describe('pass runs', () => {
  it('get prints the released value only', async () => {
    const t = io({ password_use: [released({ password: 'kT7-fake-Pass' })] })
    const p = parsePassArgv(['get', 'GitHub', '--purpose', 'push the fix'])
    if (!p.ok) throw new Error(p.error)
    expect(await runPass(p, t.io)).toBe(PASS_EXIT.ok)
    expect(t.out()).toBe('kT7-fake-Pass\n')
    // An explicit reveal; no scope, so an approval covers the task for the person's grant length.
    expect(t.calls[0]).toMatchObject({ name: 'password_use', args: { item: 'GitHub', fields: ['password'], purpose: 'push the fix', use: 'reveal' } })
    expect(t.calls[0].args).not.toHaveProperty('scope')
  })

  it('waits for the person, then goes on; a denial exits 1', async () => {
    const pending: OpResult = { ok: true, result: { status: 'pending', requestId: 'apr-1', waitToken: 'tok', mode: 'tap', item: { title: 'GitHub' } } }
    const t = io({ password_use: [pending], password_wait: [{ ok: true, result: { status: 'pending' } }, { ok: true, result: { status: 'released', answeredBy: 'iPhone', item: { id: 'i1', title: 'GitHub' }, values: { password: 'p-fake-1' } } }] })
    const p = parsePassArgv(['get', 'GitHub', '--purpose', 'push the fix'])
    if (!p.ok) throw new Error(p.error)
    expect(await runPass(p, t.io)).toBe(PASS_EXIT.ok)
    expect(t.said.join('\n')).toMatch(/Waiting for approval to use GitHub/)
    expect(t.said.join('\n')).toMatch(/Approved on iPhone/)
    expect(t.calls.filter((c) => c.name === 'password_wait')).toHaveLength(2)

    const d = io({ password_use: [pending], password_wait: [{ ok: false, status: 400, code: 'denied', message: 'Walnut API error (denied): The person said no.' }] })
    expect(await runPass(p, d.io)).toBe(PASS_EXIT.denied)
    expect(d.said.join('\n')).toMatch(/The person said no/)
  })

  it('a refusal exits 1 whether it comes at once or during the wait', async () => {
    const pending: OpResult = { ok: true, result: { status: 'pending', requestId: 'apr-1', waitToken: 't', item: { title: 'GitHub' } } }
    const p = parsePassArgv(['get', 'GitHub', '--purpose', 'push the fix'])
    if (!p.ok) throw new Error(p.error)
    const late = io({ password_use: [pending], password_wait: [{ ok: false, status: 403, code: 'agents_off', message: 'Walnut API error (agents_off): off' }] })
    expect(await runPass(p, late.io)).toBe(PASS_EXIT.denied)
    const now = io({ password_use: [{ ok: false, status: 403, code: 'agents_off', message: 'Walnut API error (agents_off): off' }] })
    expect(await runPass(p, now.io)).toBe(PASS_EXIT.denied)
  })

  it('Ctrl-C while waiting withdraws the ask', async () => {
    let interrupt: () => void = () => undefined
    const t = io({
      password_use: [{ ok: true, result: { status: 'pending', requestId: 'apr-2', waitToken: 'tok', item: { title: 'GitHub' } } }],
      password_wait: [() => { interrupt(); return { ok: true, result: { status: 'pending' } } }],
      password_cancel: [{ ok: true, result: { ok: true } }],
    }, { onInterrupt: (fn) => { interrupt = fn; return () => undefined } })
    const p = parsePassArgv(['get', 'GitHub', '--purpose', 'push the fix'])
    if (!p.ok) throw new Error(p.error)
    expect(await runPass(p, t.io)).toBe(PASS_EXIT.interrupted)
    expect(t.calls.at(-1)).toMatchObject({ name: 'password_cancel', args: { id: 'apr-2', token: 'tok' } })
  })

  it('run asks once per item and gives the command its env, an API key under its own name', async () => {
    let got: { cmd: string; env: Record<string, string>; secrets: string[] } | null = null
    const t = io({
      password_use: [
        (a) => released({ username: 'bot', password: 'gh-fake-secret' }, { id: 'i1', title: 'GitHub' }),
        () => released({ password: 'sk_test_fake_0000' }, { id: 'i2', title: 'Stripe', envName: 'STRIPE_API_KEY' }),
      ],
    }, { runChild: async (cmd, _args, env, secrets) => { got = { cmd, env, secrets }; return 7 } })
    const p = parsePassArgv(['run', '--purpose', 'deploy the test app', '--env', 'GH_USER=GitHub:username', '--env', 'GH_TOKEN=GitHub', '--env', 'Stripe', '--', 'deploy.sh'])
    if (!p.ok) throw new Error(p.error)
    expect(await runPass(p, t.io)).toBe(7)
    expect(t.calls.map((c) => c.name)).toEqual(['password_use', 'password_use'])
    expect(t.calls[0].args.fields).toEqual(['username', 'password'])
    expect(t.calls[0].args.command).toBe('deploy.sh')
    expect(got!.env).toEqual({ GH_USER: 'bot', GH_TOKEN: 'gh-fake-secret', STRIPE_API_KEY: 'sk_test_fake_0000' })
    expect(got!.secrets).toEqual(expect.arrayContaining(['gh-fake-secret', 'sk_test_fake_0000']))
    expect(t.out()).toBe('')
  })

  it('run refuses an item with no env var name and no NAME=', async () => {
    const t = io({ password_use: [released({ password: 'x-fake-secret' })] }, { runChild: async () => 0 })
    const p = parsePassArgv(['run', '--purpose', 'run the tool', '--env', 'GitHub', '--', 'tool'])
    if (!p.ok) throw new Error(p.error)
    expect(await runPass(p, t.io)).toBe(PASS_EXIT.error)
    expect(t.said.join('\n')).toMatch(/no env var name/)
  })
})

describe('masking', () => {
  it('masks a secret split over chunks, and several secrets, longest first', () => {
    const m = createMasker(['hunter2-fake', 'hunter2-fake-long', 'ab'])
    const parts = ['token=hun', 'ter2-fa', 'ke and hunter2-fake-long; ab stays\n']
    const out = Buffer.concat([...parts.map((p) => m.push(Buffer.from(p))), m.end()]).toString()
    expect(out).toBe(`token=${MASK} and ${MASK}; ab stays\n`)
  })

  it('masks a 3-digit card code, and the URL, JSON and base64 forms of a secret', () => {
    const secret = 'p@ss "w0rd"/fake+'
    const basic = Buffer.from(`bot:${secret}`).toString('base64')
    const text = [
      'cvc 123',
      `url ${encodeURIComponent(secret)}`,
      `json ${JSON.stringify({ pw: secret })}`,
      `Authorization: Basic ${basic}`,
    ].join('\n')
    const m = createMasker(['123', secret])
    const out = Buffer.concat([m.push(Buffer.from(text)), m.end()]).toString()
    expect(out).not.toContain('123')
    expect(out).not.toContain(encodeURIComponent(secret))
    expect(out).not.toContain(JSON.stringify(secret).slice(1, -1))
    // At most the bytes the prefix shares with the secret survive: never enough to decode it.
    const left = out.split('Basic ')[1]
    expect(Buffer.from(left.replaceAll(MASK, ''), 'base64').toString()).not.toContain('w0rd')
  })

  it('masks each line of a value that spans lines, with any line ending', () => {
    const key = '-----BEGIN FAKE KEY-----\nAAAAfakekeyline1\nBBBBfakekeyline2\n-----END FAKE KEY-----'
    const m = createMasker([key])
    const out = Buffer.concat([m.push(Buffer.from(`k: ${key.replaceAll('\n', '\r\n')}\nline BBBBfakekeyline2 alone`)), m.end()]).toString()
    expect(out).not.toContain('fakekeyline')
  })

  it('passes output through when there is nothing to mask', () => {
    const m = createMasker([])
    expect(m.push(Buffer.from('plain')).toString()).toBe('plain')
  })

  it('masks a real child process output on stdout and stderr', async () => {
    const out = new PassThrough(); const err = new PassThrough()
    let o = ''; let e = ''
    out.on('data', (c) => { o += c }); err.on('data', (c) => { e += c })
    const code = await spawnMasked('sh', ['-c', 'echo "got $FAKE_TOKEN"; printf "%s" "$FAKE_TOKEN" >&2; exit 3'], { FAKE_TOKEN: 'tok-fake-12345' }, ['tok-fake-12345'], out, err)
    expect(code).toBe(3)
    expect(o).toBe(`got ${MASK}\n`)
    expect(e).toBe(MASK)
    // A command killed by a signal exits 128 + its number, as a shell reports it.
    expect(await spawnMasked('sh', ['-c', 'kill -TERM $$'], {}, [], new PassThrough(), new PassThrough())).toBe(143)
  })
})
