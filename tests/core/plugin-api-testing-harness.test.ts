/**
 * The fake `walnut` that plugin authors write their own unit tests against
 * (`@open-walnut/plugin-api/testing`).
 *
 * Imported from SOURCE, not through the package name: the package's exports map
 * points at `dist/`, which is only rebuilt by `bun run build:plugins`, so a test
 * going through the package name would grade a stale build.
 */
import { describe, expect, it, vi } from 'vitest'
import type { WalnutServerApi } from '../../packages/plugin-api/src/server.js'
import { createFakeWalnut } from '../../packages/plugin-api/src/testing.js'

function activate(walnut: WalnutServerApi) {
  return walnut.registry.op({
    name: 'ping',
    title: 'Ping',
    description: 'Answer with a greeting.',
    inputSchema: { type: 'object', properties: { who: { type: 'string' } }, required: ['who'] },
    readonly: true,
    async handler(args) {
      return { greeting: `hello ${String(args.who)}` }
    },
  })
}

describe('createFakeWalnut registry.op', () => {
  it('records what activate declared, schema included', async () => {
    const fake = createFakeWalnut({ pluginId: 'sample' })
    activate(fake.api)

    expect(fake.registeredOps).toHaveLength(1)
    const [op] = fake.registeredOps
    expect(op.name).toBe('ping')
    expect(op.readonly).toBe(true)
    expect(op.inputSchema).toEqual({ type: 'object', properties: { who: { type: 'string' } }, required: ['who'] })
    // The handler is the real one, so a plugin test can exercise it without the host.
    await expect(op.handler({ who: 'ada' }, { call: async () => undefined })).resolves.toEqual({ greeting: 'hello ada' })
  })

  it('forgets an op once its Disposable is disposed', () => {
    const fake = createFakeWalnut({ pluginId: 'sample' })
    const registration = activate(fake.api)

    registration.dispose()
    expect(fake.registeredOps).toEqual([])
  })
})

describe('createFakeWalnut services', () => {
  it('lets a test stand in for the plugin this one depends on', () => {
    const fake = createFakeWalnut({ pluginId: 'sample' })
    fake.services.set('greeter-plugin:greeter', { greet: (who: string) => `hi ${who}` })

    // What the plugin under test would write in its own activate.
    const greeter = fake.api.services.require<{ greet(who: string): string }>('greeter-plugin:greeter')

    expect(greeter.greet('ada')).toBe('hi ada')
    // Seeding a replacement is enough: the fake resolves at call time, like the host.
    fake.services.set('greeter-plugin:greeter', { greet: (who: string) => `hello ${who}` })
    expect(greeter.greet('ada')).toBe('hello ada')
  })

  it('splits eager require from lazy get, the way the host does', () => {
    const fake = createFakeWalnut({ pluginId: 'sample' })

    expect(() => fake.api.services.require('absent:thing')).toThrow(/No fake service published/)
    const lazy = fake.api.services.get<{ ping(): string }>('absent:thing')
    fake.services.set('absent:thing', { ping: () => 'pong' })

    expect(lazy.ping()).toBe('pong')
  })

  it('applies the host\'s method-bag rule, so a test cannot pass against a laxer contract', () => {
    const fake = createFakeWalnut({ pluginId: 'sample' })
    class Clock { now() { return 1 } }

    expect(() => fake.api.services.publish('clock', new Clock()))
      .toThrow(/plain object whose own enumerable properties are all functions/)
    expect(() => fake.api.services.publish('clock', { now: () => 1, tz: 'utc' } as never))
      .toThrow(/"tz" is string/)
    expect(() => fake.api.services.publish('clock', { then: () => undefined }))
      .toThrow(/may not have a method named "then"/)
    expect([...fake.services.keys()]).toEqual([])
  })

  it('records what the plugin published, keyed by its own id, and tells onChange', () => {
    const fake = createFakeWalnut({ pluginId: 'sample' })
    const changes: Array<{ key: string; action: string }> = []
    fake.api.services.onChange((change) => { changes.push({ key: change.key, action: change.action }) })

    const registration = fake.api.services.publish('clock', { now: () => 1 })
    expect([...fake.services.keys()]).toEqual(['sample:clock'])

    fake.api.services.publish('clock', { now: () => 2 })
    registration.dispose()

    // The replaced registration's Disposable is a no-op, same as the host's.
    expect(fake.services.get('sample:clock')?.now()).toBe(2)
    expect(changes).toEqual([
      { key: 'sample:clock', action: 'published' },
      { key: 'sample:clock', action: 'replaced' },
    ])
  })
})

describe('createFakeWalnut storage.updateJson', () => {
  it('serializes concurrent updates on one name, so a passing concurrency test means something', async () => {
    const fake = createFakeWalnut({ pluginId: 'sample' })

    // The real `updateJson` holds a file lock across read + mutate + write. An `await`
    // inside the mutation is what a plugin actually does (an HTTP call, a db read); an
    // unserialized fake lets both mutations read 0 and the second write drops the first,
    // so the counter lands on 1 and the plugin author ships a lost update.
    const order: string[] = []
    const bump = (tag: string) => fake.api.storage.updateJson('counter.json', { count: 0 }, async (current) => {
      order.push(`read:${tag}:${current.count}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push(`write:${tag}:${current.count + 1}`)
      return { count: current.count + 1 }
    })

    const [first, second] = await Promise.all([bump('a'), bump('b')])

    expect(first).toEqual({ count: 1 })
    expect(second).toEqual({ count: 2 })
    expect(await fake.api.storage.readJson('counter.json', { count: -1 })).toEqual({ count: 2 })
    // Submission order is preserved: the second caller never starts before the first ends.
    expect(order).toEqual(['read:a:0', 'write:a:1', 'read:b:1', 'write:b:2'])
  })

  it('lets the next update run after one throws', async () => {
    const fake = createFakeWalnut({ pluginId: 'sample' })

    const failing = fake.api.storage.updateJson('counter.json', { count: 0 }, async () => {
      throw new Error('the remote said no')
    })
    const following = fake.api.storage.updateJson('counter.json', { count: 0 }, async (current) => ({
      count: current.count + 1,
    }))

    // The failure reaches ITS caller and nobody else's: a shared chain that forwarded the
    // rejection would fail every later update in the test for someone else's reason.
    await expect(failing).rejects.toThrow('the remote said no')
    await expect(following).resolves.toEqual({ count: 1 })
  })
})

describe('createFakeWalnut tasks.fileIntoProject pin tiers', () => {
  it('accepts the retired backlog tier and files the task in Parked, as the host does', async () => {
    const fake = createFakeWalnut({
      pluginId: 'sample',
      tasks: [{ id: 't1', title: 'someday', phase: 'TODO', status: 'todo', project: 'Work' }] as never,
    })

    const result = await fake.api.tasks.fileIntoProject('Work', [{ id: 't1', pinTier: 'backlog' }])

    expect(result.filed).toEqual(['t1'])
    const task = await fake.api.tasks.get('t1')
    expect(task?.pinned).toBe(true)
    expect(task?.focusTier).toBe('wait')
    await expect(fake.api.tasks.fileIntoProject('Work', [{ id: 't1', pinTier: 'icebox' }])).rejects.toThrow(/unknown pin tier/)
  })
})

describe('createFakeWalnut storage.database', () => {
  it('is one database per fake, the same object on every access', async () => {
    const fake = createFakeWalnut()
    const first = fake.api.storage.database
    expect(fake.api.storage.database).toBe(first)

    await first.exec('CREATE TABLE seen (id INTEGER PRIMARY KEY)')
    await fake.api.storage.database.run('INSERT INTO seen DEFAULT VALUES')
    expect(await first.get('SELECT COUNT(*) AS n FROM seen')).toEqual({ n: 1 })
  })

  it('keeps two fakes apart', async () => {
    const one = createFakeWalnut().api.storage.database
    const two = createFakeWalnut().api.storage.database
    await one.exec('CREATE TABLE only_here (id INTEGER PRIMARY KEY)')

    await expect(two.get('SELECT * FROM only_here')).rejects.toThrow('no such table: only_here')
    expect(await one.all('SELECT * FROM only_here')).toEqual([])
  })

  it('round trips rows as plain objects', async () => {
    const db = createFakeWalnut().api.storage.database
    await db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body BLOB, score REAL, missing TEXT)')
    // Unicode title as escapes: CJK text and an astral emoji survive the round trip.
    const title = '\u4f60\u597d \u{1F600}'

    expect(await db.run('INSERT INTO notes (title, body, score) VALUES (?, ?, ?)', [title, new Uint8Array([1, 2, 3]), 1.5]))
      .toEqual({ changes: 1, lastInsertRowid: 1 })
    expect(await db.run('INSERT INTO notes (title) VALUES (?)', ['second'])).toEqual({ changes: 1, lastInsertRowid: 2 })
    // A statement that changes nothing reports 0, not the previous write's count.
    expect(await db.run('CREATE INDEX notes_title ON notes (title)')).toEqual({ changes: 0, lastInsertRowid: 2 })

    const row = await db.get('SELECT * FROM notes WHERE id = ?', [1])
    expect(row).toEqual({ id: 1, title, body: new Uint8Array([1, 2, 3]), score: 1.5, missing: null })
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype)
    expect(await db.get('SELECT * FROM notes WHERE id = ?', [99])).toBeUndefined()
    expect(await db.all<{ title: string }>('SELECT title FROM notes ORDER BY id')).toEqual([{ title }, { title: 'second' }])
    await expect(db.all('INSERT INTO notes (title) VALUES (1)')).rejects.toThrow('This statement does not return data. Use run() instead')
  })

  it('binds bare named keys and positional arrays the way the host does', async () => {
    const db = createFakeWalnut().api.storage.database
    await db.exec('CREATE TABLE pairs (id INTEGER PRIMARY KEY, a TEXT, b TEXT)')

    await db.run('INSERT INTO pairs (a, b) VALUES (:a, @b)', { a: 'colon', b: 'at' })
    await db.run('INSERT INTO pairs (a, b) VALUES ($a, $a)', { a: 'dollar', unused: 'ignored' })
    await db.run('INSERT INTO pairs (a, b) VALUES (?, ?)', ['first', 'second'])
    await db.run("INSERT INTO pairs (a, b) VALUES ('12:30 ? @x', :b)", { b: 'literal' })
    expect(await db.all('SELECT a, b FROM pairs ORDER BY id')).toEqual([
      { a: 'colon', b: 'at' },
      { a: 'dollar', b: 'dollar' },
      { a: 'first', b: 'second' },
      { a: '12:30 ? @x', b: 'literal' },
    ])

    // The host refuses these, so the fake does too, with the host's words.
    await expect(db.run('INSERT INTO pairs (a) VALUES (:a)', {})).rejects.toThrow('Missing named parameter "a"')
    await expect(db.run('INSERT INTO pairs (a) VALUES (:a)', { ':a': 'prefixed' })).rejects.toThrow('Missing named parameter "a"')
    await expect(db.run('INSERT INTO pairs (a) VALUES (:a)')).rejects.toThrow('Missing named parameters')
    await expect(db.run('INSERT INTO pairs (a, b) VALUES (?, ?)', ['only one'])).rejects.toThrow('Too few parameter values were provided')
    await expect(db.run('INSERT INTO pairs (a) VALUES (?)', ['one', 'two'])).rejects.toThrow('Too many parameter values were provided')
    await expect(db.run('INSERT INTO pairs (a) VALUES (?)', [true as never])).rejects.toThrow('SQLite3 can only bind numbers, strings, bigints, buffers, and null')
    await expect(db.run('SELECT 1; SELECT 2')).rejects.toThrow('The supplied SQL string contains more than one statement')
    expect(await db.get('SELECT COUNT(*) AS n FROM pairs')).toEqual({ n: 4 })
  })

  it('migrates each version once, in ascending order, inside one transaction', async () => {
    const db = createFakeWalnut().api.storage.database
    const migrations = [
      { version: 2, sql: 'ALTER TABLE items ADD COLUMN note TEXT' },
      { version: 1, sql: 'CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL)' },
    ]

    expect(await db.migrate(migrations)).toBe(2)
    // Applied versions never run again: re-running v1 would fail on the existing table.
    expect(await db.migrate(migrations)).toBe(2)
    expect(await db.migrate([])).toBe(2)
    expect(await db.all('SELECT version FROM _walnut_plugin_migrations ORDER BY version')).toEqual([{ version: 1 }, { version: 2 }])
    await db.run('INSERT INTO items (value, note) VALUES (?, ?)', ['v', 'n'])

    await expect(db.migrate([
      { version: 3, sql: 'CREATE TABLE more (id INTEGER)' },
      { version: 4, sql: 'NOT SQL' },
    ])).rejects.toThrow('syntax error')
    expect(await db.get("SELECT name FROM sqlite_master WHERE name = 'more'")).toBeUndefined()
    expect(await db.get('SELECT MAX(version) AS version FROM _walnut_plugin_migrations')).toEqual({ version: 2 })

    await expect(db.migrate([{ version: 0, sql: 'SELECT 1' }])).rejects.toThrow('Migration versions must be positive integers')
    await expect(db.migrate([{ version: 5, sql: 'SELECT 1' }, { version: 5, sql: 'SELECT 1' }])).rejects.toThrow('Duplicate migration version 5')
  })

  it('commits a batch, or rolls all of it back naming the failing statement', async () => {
    const db = createFakeWalnut().api.storage.database
    await db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL UNIQUE)')
    await db.exec('CREATE TABLE tags (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL, tag TEXT NOT NULL)')
    const values = async () => (await db.all<{ value: string }>('SELECT value FROM items ORDER BY id')).map((row) => row.value)

    expect(await db.batch([
      { sql: 'INSERT INTO items (value) VALUES (?)', params: ['parent'] },
      { sql: 'INSERT INTO tags (item_id, tag) VALUES (last_insert_rowid(), :tag)', params: { tag: 'first' } },
    ])).toEqual([{ changes: 1, lastInsertRowid: 1 }, { changes: 1, lastInsertRowid: 1 }])
    expect(await db.get('SELECT items.value, tags.tag FROM tags JOIN items ON items.id = tags.item_id')).toEqual({ value: 'parent', tag: 'first' })

    await expect(db.batch([
      { sql: 'INSERT INTO items (value) VALUES (?)', params: ['kept out'] },
      { sql: 'INSERT INTO items (value) VALUES (?)', params: ['parent'] },
    ])).rejects.toThrow('Plugin database batch failed at statement 1, nothing was written: UNIQUE constraint failed: items.value')
    expect(await values()).toEqual(['parent'])

    expect(await db.batch([])).toEqual([])
    await expect(db.batch('INSERT' as never)).rejects.toThrow('Plugin database batch takes an array of { sql, params } statements')
    await expect(db.batch([{ sql: 'SELECT 1' }, { params: [] } as never])).rejects.toThrow('Plugin database batch statement 1 must be an object with a string sql')
  })

  it('rejects every call with the Node version it needs when node:sqlite is missing', async () => {
    const original = process.getBuiltinModule.bind(process)
    const lookup = vi.spyOn(process, 'getBuiltinModule').mockImplementation(((id: string) =>
      id === 'node:sqlite' ? undefined : original(id)) as typeof process.getBuiltinModule)
    try {
      const fake = createFakeWalnut()
      // Reaching the property never throws; only the calls refuse.
      const db = fake.api.storage.database
      await expect(db.exec('SELECT 1')).rejects.toThrow(/needs node:sqlite, built into Node\.js 22\.13 or later.*Node\.js \d+\.\d+\.\d+ does not provide it/)
      await expect(db.get('SELECT 1')).rejects.toThrow('Node.js 22.13 or later')
      // The rest of the fake keeps working.
      await fake.api.storage.writeJson('state.json', { ok: true })
      expect(await fake.api.storage.readJson('state.json', { ok: false })).toEqual({ ok: true })
    } finally {
      lookup.mockRestore()
    }
  })
})

describe('createFakeWalnut storage areas', () => {
  it('files and tmp keep what was written, and files refuses what Walnut refuses', async () => {
    const fake = createFakeWalnut({ pluginId: 'sample' })
    const { files, tmp } = fake.api.storage
    await files.writeText('reviews/a.md', '# a')
    await files.writeJson('state.json', { n: 1 })
    expect(await files.readText('reviews/a.md')).toBe('# a')
    expect(await files.readJson('state.json', { n: 0 })).toEqual({ n: 1 })
    expect(await files.list('reviews')).toEqual(['reviews/a.md'])
    await files.flush()
    await expect(files.writeText('../x.md', 'x')).rejects.toThrow('Invalid plugin file path')
    await expect(files.writeText('.hidden.md', 'x')).rejects.toThrow('Invalid plugin file path')
    await expect(files.writeText('photo.png', 'x')).rejects.toThrow('is text')
    await expect(files.writeText('a.txt', 'a\0b')).rejects.toThrow('not binary data')
    await expect(files.writeText('big.txt', 'x'.repeat(1024 * 1024 + 1))).rejects.toThrow(RangeError)
    // tmp takes any name inside it, binary included; the two areas are separate.
    await tmp.writeText('scratch.bin', 'a\0b')
    expect(await tmp.list()).toEqual(['scratch.bin'])
    await files.delete('reviews/a.md')
    expect(await files.list()).toEqual(['state.json'])
    expect(typeof files.dir).toBe('string')
  })
})

describe('createFakeWalnut appState', () => {
  it('keeps the latest state per task with its options, and refuses what the host refuses', async () => {
    const fake = createFakeWalnut({ pluginId: 'sample' })
    await fake.api.appState.publish('t1', { level: 1 })
    const second = await fake.api.appState.publish('t1', { level: 2 }, { mode: 'proactive', label: 'Sample' })
    expect(second).toEqual({ version: 2, kept: true })
    expect(fake.appStates.get('t1')).toEqual({ state: { level: 2 }, options: { mode: 'proactive', label: 'Sample' }, version: 2 })

    await expect(fake.api.appState.publish('', { a: 1 })).rejects.toThrow(TypeError)
    await expect(fake.api.appState.publish('t1', [] as unknown as Record<string, unknown>)).rejects.toThrow('plain object')
    await expect(fake.api.appState.publish('t1', { a: 1 }, { mode: 'loud' as 'passive' })).rejects.toThrow('passive or proactive')
    await expect(fake.api.appState.publish('t1', { big: 'x'.repeat(64 * 1024) })).rejects.toThrow(RangeError)

    await fake.api.appState.clear('t1')
    expect(fake.appStates.has('t1')).toBe(false)
  })
})
