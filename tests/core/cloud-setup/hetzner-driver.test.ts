/**
 * Hetzner driver — the API calls it makes, and the two things that can cost the
 * operator real money or real secrets if they regress.
 *
 * `fetch` is stubbed and every call is RECORDED, so these tests make zero
 * network calls. The recording is what lets the resume test assert a negative:
 * "adopting an existing server issued NO POST /servers". Response shapes follow
 * the Hetzner Cloud API v1 envelopes ({server}, {servers}, {firewall}, {error}).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { hetznerDriver, HETZNER_TIMINGS } from '../../../src/core/cloud-setup/providers/hetzner.js'

// Real 5s sleeps would put this file at ~20s for no added coverage: what the
// poll tests assert is the SEQUENCE of calls, not wall-clock patience. The
// timeout test restores the real budget so its message stays truthful.
const REAL_TIMINGS = { ...HETZNER_TIMINGS }
HETZNER_TIMINGS.pollIntervalMs = 1
HETZNER_TIMINGS.pollBudgetMs = 200

const TOKEN = 'hcloud-secret-token-do-not-leak-0123456789'
const USER_DATA = "#!/usr/bin/env bash\nprintf '%s' 'a1b2c3d4e5f60718293a4b5c6d7e8f90' > /etc/walnut/setup-token\n"

interface Call { method: string; path: string; body: unknown; auth: string | null }

let calls: Call[] = []
/** Queue-of-handlers keyed by "METHOD /path-prefix"; see route(). */
type Handler = (call: Call) => { status?: number; body?: unknown }
let routes: Array<{ match: RegExp; method: string; handler: Handler }> = []

function route(method: string, match: RegExp, handler: Handler): void {
  routes.push({ method, match, handler })
}

function server(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 4711,
    name: 'walnut-cloud',
    status: 'running',
    public_net: { ipv4: { ip: '203.0.113.77' } },
    ...over,
  }
}

beforeEach(() => {
  calls = []
  routes = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const path = url.replace('https://api.hetzner.cloud/v1', '')
    const headers = (init?.headers ?? {}) as Record<string, string>
    const call: Call = {
      method,
      path,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
      auth: headers.Authorization ?? null,
    }
    calls.push(call)
    const hit = routes.find((r) => r.method === method && r.match.test(path))
    if (!hit) throw new Error(`test: no stub for ${method} ${path}`)
    const { status = 200, body = {} } = hit.handler(call)
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Calls to POST /servers — the one request that creates a chargeable resource. */
function serverCreates(): Call[] {
  return calls.filter((c) => c.method === 'POST' && c.path === '/servers')
}

/** Happy-path stubs: nothing exists yet, and a created server boots to running. */
function stubFreshCreate(opts: { statuses?: string[] } = {}): void {
  const statuses = opts.statuses ?? ['running']
  let pollIndex = 0
  route('GET', /^\/servers\?name=/, () => ({ body: { servers: [] } }))
  route('GET', /^\/firewalls\?name=/, () => ({ body: { firewalls: [] } }))
  route('POST', /^\/firewalls$/, () => ({ body: { firewall: { id: 99 } } }))
  route('POST', /^\/servers$/, () => ({ body: { server: server({ status: 'initializing' }) } }))
  route('GET', /^\/servers\/4711$/, () => {
    const status = statuses[Math.min(pollIndex++, statuses.length - 1)]
    return { body: { server: server({ status }) } }
  })
}

describe('hetznerDriver.detectCreds', () => {
  it('always asks for an API token — there is no local login to inherit', async () => {
    const detect = await hetznerDriver.detectCreds()
    // needs:'api-token' is what routes the wizard to its password field
    // (CloudConfigureForm) and paints the "Needs API token" pill.
    expect(detect.needs).toBe('api-token')
    expect(detect.available).toBe(false)
    expect(detect.detail).toMatch(/API token/i)
  })

  it('makes no network call at all', async () => {
    await hetznerDriver.detectCreds()
    expect(calls).toHaveLength(0)
  })
})

describe('hetznerDriver.createVM — fresh create', () => {
  const logs: string[] = []
  beforeEach(() => { logs.length = 0 })

  it('creates the firewall, then the server, polls to running, and returns the IP', async () => {
    stubFreshCreate({ statuses: ['initializing', 'starting', 'running'] })
    const result = await hetznerDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'own-domain', domain: 'wn.example.com', credentials: TOKEN },
      (l) => logs.push(l),
    )
    expect(result).toMatchObject({
      ip: '203.0.113.77',
      instanceRef: '4711',
      domain: 'wn.example.com',
    })
    // Adopt-check comes first, before anything is created — and it must filter
    // by the managed_by label too, so an operator's unrelated server that
    // happens to be named walnut-cloud is never adopted.
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/servers?name=walnut-cloud&label_selector=managed_by%3Dopen-walnut' })
    expect(serverCreates()).toHaveLength(1)
    // Polled until running, not just once.
    expect(calls.filter((c) => c.path === '/servers/4711')).toHaveLength(3)
  })

  it('opens inbound tcp 80 and 443 to both IPv4 and IPv6', async () => {
    stubFreshCreate()
    await hetznerDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip', credentials: TOKEN },
      (l) => logs.push(l),
    )
    const fw = calls.find((c) => c.method === 'POST' && c.path === '/firewalls')!
    const rules = (fw.body as { name: string; rules: Array<Record<string, unknown>> }).rules
    expect(fw.body).toMatchObject({ name: 'walnut-cloud-fw' })
    // 80 matters as much as 443: Caddy's HTTP-01 challenge needs it.
    expect(rules.map((r) => r.port)).toEqual(['80', '443'])
    for (const rule of rules) {
      expect(rule).toMatchObject({ direction: 'in', protocol: 'tcp' })
      expect(rule.source_ips).toEqual(['0.0.0.0/0', '::/0'])
    }
  })

  it('boots Ubuntu 24.04 with the boot script as user_data and the firewall attached', async () => {
    stubFreshCreate()
    await hetznerDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip', credentials: TOKEN },
      (l) => logs.push(l),
    )
    expect(serverCreates()[0].body).toMatchObject({
      name: 'walnut-cloud',
      image: 'ubuntu-24.04',
      server_type: 'cpx22',
      location: 'fsn1',
      user_data: USER_DATA,
      firewalls: [{ firewall: 99 }],
      public_net: { enable_ipv4: true },
    })
  })

  it('honours an explicit region and instanceType', async () => {
    stubFreshCreate()
    await hetznerDriver.createVM!(
      {
        userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip',
        credentials: TOKEN, region: 'ash', instanceType: 'cpx21',
      },
      (l) => logs.push(l),
    )
    expect(serverCreates()[0].body).toMatchObject({ location: 'ash', server_type: 'cpx21' })
  })

  it('sends the token as a bearer header on every call', async () => {
    stubFreshCreate()
    await hetznerDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip', credentials: TOKEN },
      (l) => logs.push(l),
    )
    expect(calls.length).toBeGreaterThan(2)
    for (const call of calls) expect(call.auth).toBe(`Bearer ${TOKEN}`)
  })

  it('derives the sslip.io hostname from the assigned IP', async () => {
    stubFreshCreate()
    const result = await hetznerDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip', credentials: TOKEN },
      (l) => logs.push(l),
    )
    // Must match what the boot script derives on the box, or the claim targets
    // a hostname nothing serves.
    expect(result.domain).toBe('203-0-113-77.sslip.io')
  })
})

describe('hetznerDriver.createVM — resume safety', () => {
  const logs: string[] = []
  beforeEach(() => { logs.length = 0 })

  it('adopts an existing server by name and creates NOTHING', async () => {
    // The contract: a job that died after POST /servers must converge on the
    // box it already made. A second POST here would leave the operator paying
    // for two machines, only one of which Walnut tracks.
    route('GET', /^\/servers\?name=/, () => ({ body: { servers: [server()] } }))
    const result = await hetznerDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip', credentials: TOKEN },
      (l) => logs.push(l),
    )
    expect(serverCreates()).toHaveLength(0)
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
    expect(result).toMatchObject({ ip: '203.0.113.77', instanceRef: '4711', domain: '203-0-113-77.sslip.io' })
    expect(logs.join('\n')).toMatch(/adopting it instead of creating one/)
  })

  it('adopts a server that is still booting and waits for it', async () => {
    let polls = 0
    route('GET', /^\/servers\?name=/, () => ({ body: { servers: [server({ status: 'starting' })] } }))
    route('GET', /^\/servers\/4711$/, () => ({
      body: { server: server({ status: ++polls >= 2 ? 'running' : 'starting' }) },
    }))
    const result = await hetznerDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip', credentials: TOKEN },
      (l) => logs.push(l),
    )
    expect(serverCreates()).toHaveLength(0)
    expect(result.ip).toBe('203.0.113.77')
  })

  it('ignores a name that only prefix-matches (Hetzner name= is equality, but do not trust it)', async () => {
    route('GET', /^\/servers\?name=/, () => ({ body: { servers: [server({ name: 'walnut-cloud-old', id: 1 })] } }))
    route('GET', /^\/firewalls\?name=/, () => ({ body: { firewalls: [{ id: 99, name: 'walnut-cloud-fw' }] } }))
    route('POST', /^\/servers$/, () => ({ body: { server: server() } }))
    route('GET', /^\/servers\/4711$/, () => ({ body: { server: server() } }))
    await hetznerDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip', credentials: TOKEN },
      (l) => logs.push(l),
    )
    expect(serverCreates()).toHaveLength(1)
  })

  it('reuses an existing firewall rather than failing on the duplicate name', async () => {
    route('GET', /^\/servers\?name=/, () => ({ body: { servers: [] } }))
    route('GET', /^\/firewalls\?name=/, () => ({ body: { firewalls: [{ id: 42, name: 'walnut-cloud-fw' }] } }))
    route('POST', /^\/servers$/, () => ({ body: { server: server() } }))
    route('GET', /^\/servers\/4711$/, () => ({ body: { server: server() } }))
    await hetznerDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip', credentials: TOKEN },
      (l) => logs.push(l),
    )
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/firewalls')).toHaveLength(0)
    expect(serverCreates()[0].body).toMatchObject({ firewalls: [{ firewall: 42 }] })
  })
})

describe('hetznerDriver.createVM — input validation before any network call', () => {
  const logs: string[] = []
  beforeEach(() => { logs.length = 0 })

  it('rejects a user-data blob over the 32 KiB cloud-init limit, with no requests made', async () => {
    const oversized = 'x'.repeat(32 * 1024 + 1)
    await expect(hetznerDriver.createVM!(
      { userData: oversized, name: 'walnut-cloud', domainMode: 'sslip', credentials: TOKEN },
      (l) => logs.push(l),
    )).rejects.toThrow(/32768-byte/)
    expect(calls).toHaveLength(0)
  })

  it('accepts a blob exactly at the limit', async () => {
    stubFreshCreate()
    await hetznerDriver.createVM!(
      { userData: 'x'.repeat(32 * 1024), name: 'walnut-cloud', domainMode: 'sslip', credentials: TOKEN },
      (l) => logs.push(l),
    )
    expect(serverCreates()).toHaveLength(1)
  })

  it('measures BYTES, not characters (a multibyte blob under 32K chars can be over)', async () => {
    // 'é' is 2 bytes in UTF-8, so 20K chars is 40K bytes — the API would reject
    // it, and a .length check here would have let it through.
    await expect(hetznerDriver.createVM!(
      { userData: 'é'.repeat(20_000), name: 'walnut-cloud', domainMode: 'sslip', credentials: TOKEN },
      (l) => logs.push(l),
    )).rejects.toThrow(/cloud-init user-data limit/)
    expect(calls).toHaveLength(0)
  })

  it('requires a token', async () => {
    await expect(hetznerDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )).rejects.toThrow(/needs a Cloud API token/)
    expect(calls).toHaveLength(0)
  })

  it('requires a domain in own-domain mode', async () => {
    await expect(hetznerDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'own-domain', credentials: TOKEN },
      (l) => logs.push(l),
    )).rejects.toThrow(/requires a domain/)
    expect(calls).toHaveLength(0)
  })
})

describe('hetznerDriver.createVM — error paths', () => {
  const logs: string[] = []
  beforeEach(() => { logs.length = 0 })

  it('turns a 401 into an explanation of what to check about the token', async () => {
    route('GET', /^\/servers\?name=/, () => ({ status: 401, body: { error: { code: 'unauthorized', message: 'unable to authenticate' } } }))
    await expect(hetznerDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip', credentials: TOKEN },
      (l) => logs.push(l),
    )).rejects.toThrow(/rejected the API token.*READ & WRITE/s)
  })

  it('treats 403 the same way (a read-only token)', async () => {
    route('GET', /^\/servers\?name=/, () => ({ status: 403, body: { error: { code: 'forbidden' } } }))
    await expect(hetznerDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip', credentials: TOKEN },
      (l) => logs.push(l),
    )).rejects.toThrow(/rejected the API token/)
  })

  it('surfaces the API error message and code on other failures', async () => {
    route('GET', /^\/servers\?name=/, () => ({ body: { servers: [] } }))
    route('GET', /^\/firewalls\?name=/, () => ({ body: { firewalls: [] } }))
    route('POST', /^\/firewalls$/, () => ({ body: { firewall: { id: 99 } } }))
    route('POST', /^\/servers$/, () => ({
      status: 400,
      body: { error: { code: 'resource_unavailable', message: 'server type not available in this location' } },
    }))
    await expect(hetznerDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip', credentials: TOKEN },
      (l) => logs.push(l),
    )).rejects.toThrow(/server type not available in this location \[resource_unavailable\]/)
  })

  it('times out the poll with a message that says a retry adopts rather than recreates', async () => {
    // A server stuck in 'initializing' forever. The message must quote the REAL
    // budget the operator experienced, so restore it for the arithmetic while
    // keeping the loop itself fast.
    HETZNER_TIMINGS.pollBudgetMs = REAL_TIMINGS.pollBudgetMs
    stubFreshCreate({ statuses: ['initializing'] })
    // Deadline already passed, so the first poll trips it without any waiting.
    const nowSpy = vi.spyOn(Date, 'now')
    const t0 = Date.now()
    nowSpy.mockReturnValueOnce(t0).mockReturnValue(t0 + REAL_TIMINGS.pollBudgetMs + 1)
    try {
      const message = await hetznerDriver.createVM!(
        { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip', credentials: TOKEN },
        (l) => logs.push(l),
      ).then(() => 'resolved, but should have timed out', (e: Error) => e.message)
      expect(message).toMatch(/did not reach status "running" within 5 minutes/)
      expect(message).toMatch(/last status "initializing"/)
      // The operator must not be told to start over — a retry adopts this box.
      expect(message).toMatch(/adopts the existing server rather than creating another/)
    } finally {
      nowSpy.mockRestore()
      HETZNER_TIMINGS.pollBudgetMs = 200
    }
  })

  it('fails clearly when a running server has no public IPv4', async () => {
    route('GET', /^\/servers\?name=/, () => ({
      body: { servers: [server({ public_net: { ipv4: null } })] },
    }))
    await expect(hetznerDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip', credentials: TOKEN },
      (l) => logs.push(l),
    )).rejects.toThrow(/no public IPv4 address/)
  })

  it('fails fast on every non-running terminal status, not just "off"', async () => {
    // The API's enum is running/initializing/starting/stopping/off/deleting/
    // migrating/rebuilding/unknown. Only the first three lead to a usable box;
    // waiting out a 5-minute budget on a 'deleting' server wastes the operator's
    // time and hides the real problem.
    for (const status of ['off', 'stopping', 'deleting', 'migrating', 'rebuilding', 'unknown']) {
      routes = []
      calls.length = 0
      stubFreshCreate({ statuses: [status] })
      await expect(hetznerDriver.createVM!(
        { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip', credentials: TOKEN },
        (l) => logs.push(l),
      ), status).rejects.toThrow(new RegExp(`reached status "${status}" instead of running`))
    }
  })

  it('waits through the statuses that DO lead to a running box', async () => {
    stubFreshCreate({ statuses: ['initializing', 'starting', 'running'] })
    const result = await hetznerDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip', credentials: TOKEN },
      (l) => logs.push(l),
    )
    expect(result.ip).toBe('203.0.113.77')
  })
})

describe('hetznerDriver — the token never leaks', () => {
  /** Every operator-visible surface: onLog lines plus the thrown message. */
  async function surfaces(run: () => Promise<unknown>): Promise<string> {
    const logs: string[] = []
    let thrown = ''
    try {
      await run()
    } catch (err) {
      thrown = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
    }
    return [...logs, thrown].join('\n')
  }

  it('is absent from the log lines of a successful provision', async () => {
    const logs: string[] = []
    stubFreshCreate({ statuses: ['initializing', 'running'] })
    await hetznerDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip', credentials: TOKEN },
      (l) => logs.push(l),
    )
    expect(logs.length).toBeGreaterThan(0)
    expect(logs.join('\n')).not.toContain(TOKEN)
  })

  it('is absent from the 401 message (the error most likely to quote the credential)', async () => {
    route('GET', /^\/servers\?name=/, () => ({ status: 401, body: { error: { message: 'unable to authenticate' } } }))
    const text = await surfaces(() => hetznerDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip', credentials: TOKEN },
      () => {},
    ))
    expect(text).toMatch(/rejected the API token/)
    expect(text).not.toContain(TOKEN)
  })

  it('is redacted even when a transport error quotes the whole request', async () => {
    // undici/node can put request detail in the message; the driver scrubs it
    // rather than trusting fetch not to.
    route('GET', /^\/servers\?name=/, () => { throw new Error(`connect ECONNREFUSED (Bearer ${TOKEN})`) })
    const text = await surfaces(() => hetznerDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip', credentials: TOKEN },
      () => {},
    ))
    expect(text).toContain('<redacted>')
    expect(text).not.toContain(TOKEN)
  })

  it('is redacted when an API error body echoes it back', async () => {
    route('GET', /^\/servers\?name=/, () => ({
      status: 400,
      body: { error: { code: 'invalid_input', message: `token ${TOKEN} is malformed` } },
    }))
    const text = await surfaces(() => hetznerDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip', credentials: TOKEN },
      () => {},
    ))
    expect(text).not.toContain(TOKEN)
  })

  it('never logs the root_password Hetzner returns on create', async () => {
    const logs: string[] = []
    route('GET', /^\/servers\?name=/, () => ({ body: { servers: [] } }))
    route('GET', /^\/firewalls\?name=/, () => ({ body: { firewalls: [] } }))
    route('POST', /^\/firewalls$/, () => ({ body: { firewall: { id: 99 } } }))
    route('POST', /^\/servers$/, () => ({
      body: { server: server(), root_password: 'hunter2-root-password' },
    }))
    route('GET', /^\/servers\/4711$/, () => ({ body: { server: server() } }))
    await hetznerDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip', credentials: TOKEN },
      (l) => logs.push(l),
    )
    expect(logs.join('\n')).not.toContain('hunter2-root-password')
  })
})

describe('registration', () => {
  it('is registered under the hetzner id, so the wizard and POST /start can reach it', async () => {
    // A driver file nobody registered is invisible: getDriver() is how both the
    // provider picker and the job's every step resolve it.
    const { getDriver, listDrivers } = await import('../../../src/core/cloud-setup/providers/index.js')
    expect(getDriver('hetzner')).toBe(hetznerDriver)
    expect(listDrivers().map((d) => d.id)).toContain('hetzner')
  })

  it('advertises itself as one-click provisionable', () => {
    // canProvision in GET /providers is derived from createVM being present;
    // without it the wizard would silently route to the paste path.
    expect(hetznerDriver.createVM).toBeTypeOf('function')
  })
})

describe('hetznerDriver metadata + instructions', () => {
  it('declares the ubuntu user-data flavor, so the boot script reaches for apt', async () => {
    // Hetzner has no AL2023 image; a dnf-first script would still work (the
    // generator autodetects) but would try the wrong manager first.
    expect(hetznerDriver.userDataFlavor).toBe('ubuntu')
  })

  it('exposes no teardown — the contract cannot pass it the token it would need', () => {
    expect(hetznerDriver.teardown).toBeUndefined()
  })

  it('names a price and the plan it refers to', () => {
    expect(hetznerDriver.costHint).toMatch(/CPX22/)
    expect(hetznerDriver.costHint).toMatch(/€/)
  })

  it('never advertises or defaults to a retired plan name', async () => {
    // cx22 (and the whole cx11/cx21 Gen1 line) stopped being orderable, and
    // Hetzner's notice says that applies to usage "by name" too — so a default
    // of cx22 would fail every create, and a costHint quoting its old ~€4/mo
    // would promise a price nobody can get.
    const retired = /\b(cx11|cx21|cx31|cx41|cx51|cx22|cx32|cx42|cx52)\b/
    expect(hetznerDriver.costHint).not.toMatch(retired)
    expect(hetznerDriver.instructions({
      userData: USER_DATA, domain: '', domainMode: 'sslip',
    }).steps.join('\n').replace(/cx22 generation is no longer orderable/, '')).not.toMatch(retired)

    // And no location's default resolves to one.
    for (const loc of ['fsn1', 'nbg1', 'hel1', 'ash', 'hil', 'sin', 'some-future-slug']) {
      stubFreshCreate()
      calls.length = 0
      await hetznerDriver.createVM!(
        { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip', credentials: TOKEN, region: loc },
        () => {},
      )
      const type = (serverCreates()[0].body as { server_type: string }).server_type
      expect(type, loc).not.toMatch(retired)
    }
  })

  it('defaults to a plan the chosen location actually carries', async () => {
    // The CX line is EU-only and CPX split by generation: Gen1 (cpx11) is now
    // US-only, Gen2 (cpx22) is EU + Singapore. No single name covers all six,
    // so the default is per-location or every US setup fails at create.
    for (const [loc, want] of [['fsn1', 'cpx22'], ['hel1', 'cpx22'], ['sin', 'cpx22'], ['ash', 'cpx11'], ['hil', 'cpx11']] as const) {
      stubFreshCreate()
      calls.length = 0
      await hetznerDriver.createVM!(
        { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip', credentials: TOKEN, region: loc },
        () => {},
      )
      expect((serverCreates()[0].body as { server_type: string }).server_type, loc).toBe(want)
    }
  })

  it('own-domain instructions cover the A record, ports, image and user-data field', () => {
    const { steps, consoleUrl } = hetznerDriver.instructions({
      userData: USER_DATA, domain: 'wn.example.com', domainMode: 'own-domain',
    })
    const joined = steps.join('\n')
    expect(joined).toContain('A record for wn.example.com')
    expect(joined).toMatch(/Ubuntu 24\.04/)
    expect(joined).toMatch(/User data/)
    expect(joined).toMatch(/80 and 443/)
    expect(consoleUrl).toBe('https://console.hetzner.cloud/')
  })

  it('sslip instructions say there is no DNS record, and never print "undefined"', () => {
    const { steps } = hetznerDriver.instructions({
      userData: USER_DATA, domain: '', domainMode: 'sslip',
    })
    const joined = steps.join('\n')
    expect(joined).toMatch(/No DNS record/i)
    expect(joined).not.toContain('undefined')
  })

  it('echoes an overridden region/type into the manual steps', () => {
    const { steps } = hetznerDriver.instructions({
      userData: USER_DATA, domain: '', domainMode: 'sslip', region: 'ash', instanceType: 'cpx21',
    })
    const joined = steps.join('\n')
    expect(joined).toContain('ash')
    expect(joined).toContain('cpx21')
  })

  it('warns that plan names move around, since a stale name fails at create time', () => {
    const joined = hetznerDriver.instructions({
      userData: USER_DATA, domain: '', domainMode: 'sslip',
    }).steps.join('\n')
    expect(joined).toMatch(/CX line is EU-only/)
    expect(joined).toMatch(/no longer orderable/)
    expect(joined).toMatch(/cpx22.*EU|EU.*cpx22/)
  })

  it('hands back the boot script verbatim for the copy box', () => {
    expect(hetznerDriver.instructions({
      userData: USER_DATA, domain: '', domainMode: 'sslip',
    }).userData).toBe(USER_DATA)
  })
})
