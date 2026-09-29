#!/usr/bin/env node
/**
 * Remove stored addresses and Wi-Fi names from monitor records in place:
 * the same scrub the collector runs once on its first start of a new
 * version (lib/privacy.mjs), for copies of the store kept elsewhere.
 *
 *   node scripts/bridge-monitor/scrub.mjs <dir | file.ndjson | collector.json>...
 *
 * A directory means its `*.ndjson` files. The live store is refused while a
 * collector holds the lock: it is the only writer there, and it scrubs its
 * own store on start.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { loadConfig } from './lib/config.mjs'
import { psCommand } from './lib/lifecycle.mjs'
import { loadKey, scrubFile, scrubState, scrubStoreDir } from './lib/privacy.mjs'

async function collectorRunning(stateDir) {
  try {
    const pid = Number(JSON.parse(fs.readFileSync(path.join(stateDir, 'collector.lock'), 'utf-8')).pid)
    process.kill(pid, 0)
    const command = await psCommand(pid)
    return command === null || command.includes('collector.mjs') ? pid : null // unknown counts as running
  } catch { return null }
}

async function main() {
  const targets = process.argv.slice(2)
  if (!targets.length) {
    process.stderr.write('usage: scrub.mjs <dir | file.ndjson | collector.json>...\n')
    process.exit(2)
  }
  const { cfg } = loadConfig()
  const key = loadKey(cfg.stateDir)
  const totals = { files: 0, records: 0, fields: {} }
  const stateFields = {}
  for (const t of targets.map((x) => path.resolve(x))) {
    if (t === path.resolve(cfg.logDir) || t.startsWith(`${path.resolve(cfg.logDir)}/`) || t === path.resolve(cfg.stateDir, 'collector.json')) {
      const pid = await collectorRunning(cfg.stateDir)
      if (pid) { process.stderr.write(`refusing ${t}: the collector (pid ${pid}) is running and scrubs it itself\n`); process.exit(1) }
    }
    const st = await fsp.stat(t)
    if (st.isDirectory()) await scrubStoreDir(t, key, totals)
    else if (path.basename(t) === 'collector.json') {
      const state = JSON.parse(await fsp.readFile(t, 'utf-8'))
      const removed = scrubState(state, key)
      if (removed.length) {
        await fsp.writeFile(`${t}.scrub-tmp`, JSON.stringify(state), { mode: 0o600 })
        await fsp.rename(`${t}.scrub-tmp`, t)
      }
      for (const f of removed) stateFields[f] = (stateFields[f] ?? 0) + 1
    } else if (t.endsWith('.ndjson')) await scrubFile(t, key, totals)
  }
  process.stdout.write(`${JSON.stringify({ ...totals, stateFields })}\n`)
}

await main()
