/**
 * walnut.passwords for web plugins (web/src/plugins/plugin-passwords.ts): a plugin keeps a secret
 * the person typed. One item per title is created (tagged as the plugin's) or updated through this
 * window's own unlock; a locked window (never joined to another unlock), two items of the title, an
 * item the plugin may not change, a bad input or a refusal write nothing, and no answer ever carries
 * a stored value. state() reads without unlocking, and unlock() shares an unlock made on this
 * computer or shows Walnut's own unlock sheet, and answers only whether this window is unlocked.
 */
import { describe, expect, it, vi } from 'vitest'
import { createWebPasswords } from '../../web/src/plugins/plugin-passwords'
import { VaultApiError, type VaultItem, type VaultItemSummary, type VaultStatus } from '../../web/src/api/vault'

const summary = (item: VaultItem): VaultItemSummary => ({
  id: item.id, type: item.type, title: item.title, hasPassword: !!item.password, hasTotp: false, agentAccess: 'ask',
  createdAt: item.createdAt, updatedAt: item.updatedAt, ...(item.trashedAt ? { trashedAt: item.trashedAt } : {}),
})

const STATUS = { setUp: true, open: true, unlocked: true, agentsWhileAway: false, hasSecretKey: true }
function fakeVault(items: VaultItem[], opts: { session?: string | null; status?: Partial<VaultStatus> } = {}) {
  let token = opts.session === undefined ? 'window-token' : opts.session
  return {
    session: vi.fn(() => token),
    setSession(next: string | null) { token = next },
    status: vi.fn(async (): Promise<VaultStatus> => ({ ...STATUS, unlocked: !!token, ...opts.status })),
    join: vi.fn(async () => { token = 'joined-token'; return true }),
    ask: vi.fn(async (_name: string, _reason: string, _status: VaultStatus) => false),
    list: vi.fn(async () => items.map(summary)),
    get: vi.fn(async (id: string) => structuredClone(items.find((item) => item.id === id)!)),
    create: vi.fn(async (input: never) => ({ id: 'new', ...(input as object) }) as never),
    update: vi.fn(async (id: string, input: never) => ({ id, ...(input as object) }) as never),
  }
}

const item = (id: string, title: string, password: string, extra: Partial<VaultItem> = {}): VaultItem => ({
  id, type: 'login', title, password, username: 'me', notes: 'mine', agentAccess: 'allow', tags: ['plugin:example'],
  passwordHistory: [{ password: 'older', replacedAt: '2026-10-01T00:00:00.000Z' }],
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z', ...extra,
})
const save = (client: ReturnType<typeof fakeVault>, password = 'new1', title = 'Example PIN') =>
  createWebPasswords('example', 'Example', client).save({ title, password })

describe('walnut.passwords.save', () => {
  it('creates a login tagged as the plugin\'s when no item has the title, and returns no value', async () => {
    const client = fakeVault([item('a', 'Other', 'x')])
    const result = await save(client, '4321')
    expect(result).toEqual({ saved: true, action: 'created' })
    expect(client.create).toHaveBeenCalledWith({ type: 'login', title: 'Example PIN', password: '4321', notes: 'Saved by Example after it worked.', tags: ['plugin:example'] })
    expect(JSON.stringify(result)).not.toContain('4321')
  })

  it('sets the password of the plugin\'s own item, keeping its other fields and reading it as it was', async () => {
    const client = fakeVault([item('a', 'Example PIN', 'old')])
    expect(await save(client)).toEqual({ saved: true, action: 'updated' })
    expect(client.update).toHaveBeenCalledWith('a', {
      type: 'login', title: 'Example PIN', password: 'new1', username: 'me', notes: 'mine', agentAccess: 'allow', tags: ['plugin:example'],
    }, '2026-11-02T00:00:00.000Z')
    expect(client.create).not.toHaveBeenCalled()
  })

  it('updates a login the person made by hand with no website, and tags it as the plugin\'s', async () => {
    const client = fakeVault([item('a', 'Example PIN', 'old', { tags: ['mine'] })])
    expect(await save(client)).toEqual({ saved: true, action: 'updated' })
    expect(client.update.mock.calls[0][1]).toMatchObject({ password: 'new1', tags: ['mine', 'plugin:example'] })
  })

  it('leaves alone an item with the title it may not change: a website login, a key, another plugin\'s card', async () => {
    for (const other of [
      item('a', 'Example PIN', 'site', { tags: undefined, urls: ['https://example.test'] }),
      item('a', 'Example PIN', 'key', { type: 'api_key', tags: undefined }),
      item('a', 'Example PIN', 'key', { type: 'note', tags: ['plugin:example'] }),
    ]) {
      const client = fakeVault([other])
      expect(await save(client)).toEqual({ saved: false, reason: 'exists' })
      expect(client.update).not.toHaveBeenCalled()
      expect(client.create).not.toHaveBeenCalled()
    }
    // A website login the plugin saved itself stays its own.
    const own = fakeVault([item('a', 'Example PIN', 'old', { urls: ['https://example.test'] })])
    expect(await save(own)).toEqual({ saved: true, action: 'updated' })
  })

  it('writes nothing when the item already holds that password', async () => {
    const client = fakeVault([item('a', 'Example PIN', 'same')])
    expect(await save(client, 'same')).toEqual({ saved: true, action: 'unchanged' })
    expect(client.update).not.toHaveBeenCalled()
  })

  it('changes none of two items with the title, and ignores one in the trash', async () => {
    const two = fakeVault([item('a', 'Example PIN', 'x'), item('b', 'Example PIN', 'y')])
    expect(await save(two, 'z')).toEqual({ saved: false, reason: 'ambiguous' })
    expect(two.update).not.toHaveBeenCalled()
    expect(two.create).not.toHaveBeenCalled()
    const trashed = fakeVault([item('a', 'Example PIN', 'x', { trashedAt: '2026-11-03T00:00:00.000Z' }), item('b', 'Example PIN', 'y')])
    expect(await save(trashed, 'z')).toEqual({ saved: true, action: 'updated' })
    expect(trashed.update.mock.calls[0][0]).toBe('b')
  })

  it('a window with no unlock of its own saves nothing and asks the vault nothing (never joins one)', async () => {
    const client = fakeVault([], { session: null })
    expect(await save(client)).toEqual({ saved: false, reason: 'locked' })
    expect(client.list).not.toHaveBeenCalled()
    expect(client.status).not.toHaveBeenCalled()
    expect(client.join).not.toHaveBeenCalled()
    const lapsed = fakeVault([])
    lapsed.create.mockRejectedValueOnce(new VaultApiError(401, 'Unlock Passwords', 'vault_session_needed'))
    expect(await save(lapsed)).toEqual({ saved: false, reason: 'locked' })
  })

  it('an item changed between the read and the write is read again once, then reported as a conflict', async () => {
    const stale = () => new VaultApiError(409, 'This item changed since you opened it', 'stale_item')
    const once = fakeVault([item('a', 'Example PIN', 'old')])
    once.update.mockRejectedValueOnce(stale())
    expect(await save(once)).toEqual({ saved: true, action: 'updated' })
    expect(once.get).toHaveBeenCalledTimes(2)
    const always = fakeVault([item('a', 'Example PIN', 'old')])
    always.update.mockRejectedValue(stale())
    expect(await save(always)).toEqual({ saved: false, reason: 'conflict' })
    expect(always.update).toHaveBeenCalledTimes(2)
  })

  it('two saves at once in this browser create one item', async () => {
    const items: VaultItem[] = []
    const client = fakeVault(items)
    client.create.mockImplementation(async (input: never) => {
      await new Promise((r) => setTimeout(r, 5))
      const made = { ...item('n', 'Example PIN', ''), ...(input as object), id: `n${items.length}` } as VaultItem
      items.push(made)
      return made as never
    })
    const results = await Promise.all([save(client, 'p1'), save(client, 'p2')])
    expect(items).toHaveLength(1)
    expect(results.map((r) => r.saved && r.action).sort()).toEqual(['created', 'updated'])
  })

  it('a refusal or a lost answer reads as unavailable, with no value in it', async () => {
    const client = fakeVault([])
    client.create.mockRejectedValueOnce(new VaultApiError(403, 'A test run cannot open the vault', 'test_run'))
    expect(await save(client, '9876')).toEqual({ saved: false, reason: 'unavailable' })
    client.list.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect(await save(client, '9876')).toEqual({ saved: false, reason: 'unavailable' })
  })

  it('refuses a missing title or password before reading the vault', async () => {
    const client = fakeVault([])
    const { save: bare } = createWebPasswords('example', 'Example', client)
    for (const input of [{ title: '', password: '1' }, { title: '  ', password: '1' }, { title: 'T', password: '' },
      { title: 'T', password: 5 }, { title: 'x'.repeat(201), password: '1' }, { title: 'T', password: 'p'.repeat(4001) }, null]) {
      expect(await bare(input as never)).toEqual({ saved: false, reason: 'invalid' })
    }
    expect(client.session).not.toHaveBeenCalled()
  })
})

describe('walnut.passwords.state and unlock', () => {
  const api = (client: ReturnType<typeof fakeVault>) => createWebPasswords('example', 'Example', client)

  it('state() reads this window\'s state and never joins or asks', async () => {
    expect(await api(fakeVault([])).state!()).toBe('unlocked')
    const locked = fakeVault([], { session: null, status: { canJoin: true } })
    expect(await api(locked).state!()).toBe('locked')
    expect(locked.join).not.toHaveBeenCalled()
    expect(locked.ask).not.toHaveBeenCalled()
    // A status that says unlocked for a window with no token of its own is still locked here.
    expect(await api(fakeVault([], { session: null, status: { unlocked: true } })).state!()).toBe('locked')
    expect(await api(fakeVault([], { session: null, status: { setUp: false } })).state!()).toBe('not_set_up')
    const down = fakeVault([])
    down.status.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect(await api(down).state!()).toBe('unavailable')
  })

  it('unlock() answers true at once for an unlocked window, false with no Passwords set up', async () => {
    const open = fakeVault([])
    expect(await api(open).unlock!()).toBe(true)
    expect(open.ask).not.toHaveBeenCalled()
    const none = fakeVault([], { session: null, status: { setUp: false } })
    expect(await api(none).unlock!()).toBe(false)
    expect(none.ask).not.toHaveBeenCalled()
  })

  it('unlock() shares an unlock made on this computer with no sheet', async () => {
    const client = fakeVault([], { session: null, status: { canJoin: true } })
    expect(await api(client).unlock!({ reason: 'to save your PIN' })).toBe(true)
    expect(client.join).toHaveBeenCalledTimes(1)
    expect(client.ask).not.toHaveBeenCalled()
  })

  it('unlock() shows the sheet naming the plugin and reason, and answers what the person did', async () => {
    const client = fakeVault([], { session: null })
    expect(await api(client).unlock!({ reason: `  to save your PIN${'x'.repeat(300)}` })).toBe(false)
    const [name, reason, status] = client.ask.mock.calls[0]
    expect(name).toBe('Example')
    expect(reason.startsWith('to save your PIN')).toBe(true)
    expect(reason).toHaveLength(200)
    expect(status.unlocked).toBe(false)
    // The person unlocked in the sheet: true, and the next save writes.
    client.ask.mockImplementationOnce(async () => { client.setSession('sheet-token'); return true })
    expect(await api(client).unlock!()).toBe(true)
    expect(await api(client).save({ title: 'Example PIN', password: '4321' })).toEqual({ saved: true, action: 'created' })
    // A sheet that says unlocked while this window holds no token is not believed.
    const liar = fakeVault([], { session: null })
    liar.ask.mockResolvedValueOnce(true)
    expect(await api(liar).unlock!()).toBe(false)
  })

  it('a join that fails falls back to the sheet', async () => {
    const client = fakeVault([], { session: null, status: { canJoin: true } })
    client.join.mockResolvedValueOnce(false)
    await api(client).unlock!()
    expect(client.ask).toHaveBeenCalledTimes(1)
  })
})
