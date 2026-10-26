/**
 * `walnut __selftest`: the compiled file checks the parts of itself that a
 * server boot does not reach on a fresh machine, without starting a server:
 * the unpacked tree, SQLite on bun, the worker threads that load code from that
 * tree by path, the daemon source a host without a daemon binary receives, and
 * which optional components are present. One JSON line per check; exit 1 when
 * any required check fails. The release rehearsal and a new host run it first.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RUNTIME_MARKER } from './runtime-tree.js'
import { singleFile } from '../lib/single-file.js'

type Check = { name: string; required: boolean; run: () => Promise<string> }

function expectFile(root: string, rel: string): void {
  if (!fs.existsSync(path.join(root, rel))) throw new Error(`missing ${rel}`)
}

export async function runSelftest(): Promise<number> {
  const info = singleFile()
  if (!info) throw new Error('__selftest runs only inside the compiled walnut file')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-selftest-'))
  const checks: Check[] = [
    {
      name: 'runtime-tree', required: true, run: async () => {
        for (const rel of [RUNTIME_MARKER, 'package.json', 'dist/build-info.json', 'dist/web/static/index.html', 'dist/data/skills', 'dist/integrations/local/manifest.json', 'dist/lib/sqlite.js', 'node_modules/diff/package.json', 'infra/cdk.json', 'infra/bun.lock']) expectFile(info.root, rel)
        return info.root
      },
    },
    {
      name: 'sqlite', required: true, run: async () => {
        const { default: Database, sqliteLibrary, sqliteLibraryProblem } = await import('../lib/sqlite.js')
        // On macOS the file carries its own upstream SQLite; Apple's build is the fallback that misbehaves.
        const problem = sqliteLibraryProblem()
        if (problem) throw new Error(problem)
        const db = new Database(path.join(tmp, 'check.db'))
        db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
        db.prepare('INSERT INTO t (v) VALUES (?)').run('caf\u00e9')
        const row = db.prepare('SELECT v FROM t').get() as { v: string } | undefined
        // backup() copies on a worker thread (an eval worker requiring bun:sqlite).
        await db.backup(path.join(tmp, 'check-copy.db'))
        db.close()
        if (row?.v !== 'caf\u00e9') throw new Error(`read back ${JSON.stringify(row)}`)
        const copy = new Database(path.join(tmp, 'check-copy.db'), { readonly: true })
        const copied = copy.prepare('SELECT v FROM t').get() as { v: string } | undefined
        copy.close()
        if (copied?.v !== 'caf\u00e9') throw new Error(`backup read back ${JSON.stringify(copied)}`)
        return `bun:sqlite, ${sqliteLibrary()}, backup off-thread`
      },
    },
    {
      name: 'plugin-database-worker', required: true, run: async () => {
        const { PluginDatabaseClient } = await import('../core/plugins/plugin-storage.js')
        const client = new PluginDatabaseClient(path.join(tmp, 'plugin', 'data.db'))
        try {
          await client.exec('CREATE TABLE t (v TEXT)')
          await client.run('INSERT INTO t (v) VALUES (?)', ['x'])
          const row = await client.get<{ n: number }>('SELECT COUNT(*) AS n FROM t')
          if (row?.n !== 1) throw new Error(`count ${JSON.stringify(row)}`)
        } finally {
          await client.dispose()
        }
        return 'worker thread over dist/lib/sqlite.js'
      },
    },
    {
      name: 'text-merge-worker', required: true, run: async () => {
        const { mergeTextOffLoop } = await import('../core/offline-merge/text-merge.js')
        // Long enough to take the worker path (TEXT_MERGE_INLINE_MAX).
        const base = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n')
        const mac = base.replace('line 10\n', 'line 10 mac\n')
        const replica = base.replace('line 1500\n', 'line 1500 replica\n')
        const result = await mergeTextOffLoop(base, mac, replica)
        const text = result.clean ? result.text : ''
        if (!text.includes('line 10 mac') || !text.includes('line 1500 replica')) throw new Error(JSON.stringify(result).slice(0, 200))
        return 'worker thread over node_modules/diff'
      },
    },
    {
      // Its encoder is a wasm file the package reads through __dirname (DIRNAME_PACKAGES in
      // scripts/build-binary.mjs); estimateTokens would hide a miss behind its length/4 fallback.
      name: 'tokenizer', required: true, run: async () => {
        const { getTokenizer } = await import('@anthropic-ai/tokenizer')
        const tokenizer = getTokenizer()
        try {
          const count = tokenizer.encode('hello world', 'all').length
          if (count < 1) throw new Error(`encoded to ${count} tokens`)
          return `wasm encoder, ${count} tokens`
        } finally {
          tokenizer.free()
        }
      },
    },
    {
      name: 'daemon-source', required: true, run: async () => {
        const { getDaemonSource } = await import('../providers/daemon-source.js')
        const source = getDaemonSource()
        const bun = (globalThis as { Bun?: { Transpiler: new (options: { loader: 'js' }) => { scan(code: string): unknown } } }).Bun
        new bun!.Transpiler({ loader: 'js' }).scan(source)
        return `${source.length} bytes, parses`
      },
    },
    // Downloaded components: where each feature loads from, and one real call
    // through its own load path once installed (src/core/components/selftest.ts).
    ...(['embedding', 'images', 'audio-capture'] as const).map((name): Check => ({
      name: `component ${name}`, required: false, run: async () => {
        const { componentSelftest } = await import('../core/components/selftest.js')
        return componentSelftest(name)
      },
    })),
  ]
  let failed = 0
  for (const check of checks) {
    const started = Date.now()
    try {
      const detail = await check.run()
      console.log(JSON.stringify({ check: check.name, ok: true, ms: Date.now() - started, detail }))
    } catch (err) {
      if (check.required) failed++
      const message = err instanceof Error ? err.message : String(err)
      console.log(JSON.stringify({ check: check.name, ok: false, required: check.required, ms: Date.now() - started, error: message.slice(0, 300) }))
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true })
  return failed === 0 ? 0 : 1
}
