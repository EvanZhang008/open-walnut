/**
 * Preparing a `web --ephemeral` snapshot so it can never act as the real Walnut.
 *
 * The snapshot is a copy of the user's data dir, automations included. Left as
 * copied, the test server's cron engine ran the user's real jobs a second time
 * (a Slack monitor, a daily digest, pipeline watches on shared hosts), and the
 * sessions those jobs started reached out to real services. Jobs the tester
 * creates inside the snapshot still run: cron and trigger features stay testable.
 * The same copy carries the phone's push tokens, so a test turn that finished
 * with no browser attached sent a notification to the user's real phone, and the
 * tunnel settings, so a test server took the user's tunnel address.
 */

import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import yaml from 'js-yaml'

/**
 * Top-level WALNUT_HOME entries the ephemeral snapshot does not copy because
 * their owners already treat them as regenerable. See the filter in
 * copyDataSnapshot() for the measured sizes and the anchoring rationale.
 * `health` and `places` are the exception: the Apple Health store and the
 * iPhone's place visits are not regenerable, they are PRIVATE, and a test server
 * must never carry a copy of them into $TMPDIR.
 */
export const SNAPSHOT_SKIP_TOP_LEVEL = new Set(['.git', '.smart-env', 'cache', 'health', 'places'])

/**
 * Copy the data dir `home` into the snapshot dir `dest`, leaving out what a test
 * server must not carry (the private health store, live locks, sockets and FIFOs)
 * or does not need (regenerable caches, streams, images, SQLite indexes). The task
 * and session stores are copied apart (snapshotStoreDatabases). This is the
 * launcher's one copy step, and the tests run this very function on a real tree.
 */
export function copyDataSnapshot(home: string, dest: string): void {
  fs.cpSync(home, dest, {
    recursive: true,
    // NOTE: do not bother passing mode: COPYFILE_FICLONE here hoping for a
    // copy-on-write snapshot. Measured on macOS 15 / APFS with Node 25: cloning
    // works on this volume (/bin/cp -c duplicates a 2G file for 0 bytes) but Node
    // never uses clonefile(2) — both fs.cpSync and fs.copyFileSync with
    // COPYFILE_FICLONE consumed the full 2G. Getting CoW here would mean shelling
    // out to `cp -Rc` (macOS) / `cp -R --reflink=auto` (Linux), which cannot honour
    // the filter below, so the snapshot stays a real copy and we keep it small by
    // excluding regenerable data instead.
    // Keep relative symlinks RELATIVE. The default rewrites them to absolute
    // paths into the LIVE data dir (measured: notes/CLAUDE.md -> AGENTS.md became
    // an absolute link back into ~/.open-walnut), so the "isolated" snapshot
    // silently read and wrote production notes through them.
    verbatimSymlinks: true,
    filter: (src: string) => {
      // Skip raw SQLite files (a copy of a live WAL file can be torn); the task
      // and session stores are copied consistently after this pass.
      if (/\.sqlite(-wal|-shm)?$/.test(src)) return false
      // Skip session stream files (large, not needed)
      if (src.includes(path.join('sessions', 'streams'))) return false
      // Skip the runtime tmp dir — since streams moved to ~/.open-walnut/tmp/
      // it holds live FIFO .pipe files, and cpSync on a FIFO dies with
      // ERR_INTERNAL_ASSERTION "Unreachable code" (cp-sync getStats).
      // Anchored to WALNUT_HOME/tmp: a substring test for "/tmp/" matched EVERY
      // path of a data dir that itself lives under /tmp (a sandbox home, a test
      // source dir), so that snapshot came out empty. Other FIFOs and sockets
      // are caught by the file-type check below.
      if (path.relative(home, src).split(path.sep)[0] === 'tmp') return false
      // Skip images dir (can be large)
      if (src.includes(path.join(path.sep, 'images', path.sep)) ||
          src.endsWith(path.join(path.sep, 'images'))) return false
      // Skip regenerable TOP-LEVEL dirs: .git (2.7G of data-dir history — git-sync
      // checks isRepo() and re-inits when absent, so the snapshot self-heals into
      // a fresh repo), .smart-env (1.2G embeddings store), cache (1.5G derived,
      // 1.4G of it cache/history). All three are already classified as
      // regenerable by their owners: backup/scan.ts excludes them and git-sync
      // gitignores them. Sizes measured against a 17G home on 2026-08-27.
      //
      // Anchored to the FIRST path segment under WALNUT_HOME on purpose. A
      // substring test like includes('/cache/') would also drop a note folder the
      // user happens to have named "cache", or a nested repo inside notes/ —
      // silently thinning the snapshot the tests then trust.
      const rel = path.relative(home, src)
      if (rel && SNAPSHOT_SKIP_TOP_LEVEL.has(rel.split(path.sep)[0])) return false
      // Skip lock files
      if (src.endsWith('.lock')) return false
      // Skip the single-instance lock — a snapshot carrying the LIVE server's
      // server.lock.json makes the child refuse its own fresh dir (the lock
      // names a pid that really is alive: the production server).
      if (src.endsWith('server.lock.json')) return false
      // Skip anything that isn't a plain file/dir/symlink — cpSync dies on
      // sockets and FIFOs (ERR_INTERNAL_ASSERTION "Unreachable code" during a
      // directory walk; typed ERR_FS_CP_SOCKET/ERR_FS_CP_FIFO_PIPE when hit
      // directly). The tmp/ rule above catches the known FIFOs by path; this
      // catches the rest by TYPE (e.g. code-server/data/code-server-ipc.sock,
      // which killed every `web --ephemeral` launch while an embedded VS Code
      // was running). Symlinks are safe to pass ONLY because cpSync runs with
      // the default dereference:false (it recreates the link, never stats the
      // target) — don't add dereference:true without revisiting this.
      try {
        const st = fs.lstatSync(src)
        if (!st.isFile() && !st.isDirectory() && !st.isSymbolicLink()) return false
      } catch (err) {
        // Excluding on lstat failure trades a loud cpSync abort for a quietly
        // incomplete snapshot (a directory here drops its whole subtree) — say so.
        process.stderr.write(`ephemeral: skipping unstatable ${src}: ${err instanceof Error ? err.message : String(err)}\n`)
        return false
      }
      return true
    },
  })
  snapshotStoreDatabases(home, dest)
}

/**
 * The stores a test server needs to look like the real Walnut. The copy filter
 * skips every SQLite file (a raw copy of a live WAL database can be torn), so
 * without this step the snapshot fell back to a months-old tasks.json and had
 * no sessions at all. Indexes (search, notes) stay out: they are regenerable
 * and large.
 */
export const SNAPSHOT_SQLITE_STORES = [path.join('tasks', 'tasks.sqlite'), 'sessions.sqlite']

/**
 * Copy each store with VACUUM INTO over a read-only connection: one consistent
 * snapshot that includes the WAL, and the live file is never written. A store
 * that is missing or fails to copy is left out (the test server then starts it
 * empty), and the failure is said on stderr.
 */
export function snapshotStoreDatabases(home: string, dest: string, stores: readonly string[] = SNAPSHOT_SQLITE_STORES): string[] {
  const copied: string[] = []
  for (const rel of stores) {
    const src = path.join(home, rel)
    if (!fs.existsSync(src)) continue
    const out = path.join(dest, rel)
    let db: Database.Database | null = null
    try {
      fs.mkdirSync(path.dirname(out), { recursive: true })
      fs.rmSync(out, { force: true })
      db = new Database(src, { readonly: true, fileMustExist: true, timeout: 10_000 })
      db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`)
      copied.push(rel)
    } catch (err) {
      try { fs.rmSync(out, { force: true }) } catch { /* best-effort */ }
      process.stderr.write(`ephemeral: could not copy ${rel}: ${err instanceof Error ? err.message : String(err)}\n`)
    } finally {
      try { db?.close() } catch { /* best-effort */ }
    }
  }
  return copied
}

/** Cron store file name inside a data dir (CRON_FILE in constants.ts). */
const CRON_STORE_FILE = 'cron-jobs.json'

/**
 * Disable every enabled job in the snapshot's cron store. Returns how many were
 * paused. A missing or unreadable store pauses nothing and never throws: the
 * launcher must still start, and a store the cron engine cannot parse is one it
 * will not run either.
 */
export function pauseSnapshotCronJobs(snapshotDir: string): number {
  const file = path.join(snapshotDir, CRON_STORE_FILE)
  let store: { jobs?: unknown }
  try {
    store = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return 0
  }
  if (!store || typeof store !== 'object' || !Array.isArray(store.jobs)) return 0
  let paused = 0
  for (const job of store.jobs as Array<Record<string, unknown>>) {
    if (job && typeof job === 'object' && job.enabled !== false) {
      job.enabled = false
      paused++
    }
  }
  if (paused === 0) return 0
  try {
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2))
    fs.renameSync(tmp, file)
  } catch {
    // Could not rewrite the copy: fail closed by removing it, so the test
    // server starts with no jobs rather than with the user's live ones.
    try { fs.rmSync(file, { force: true }) } catch { /* best-effort */ }
  }
  return paused
}

/** Session message queue file inside a data dir (SESSION_QUEUE_FILE in constants.ts). */
const SESSION_QUEUE_STORE_FILE = 'session-message-queue.json'

/**
 * Empty every session's queue in the snapshot. Returns how many rows were
 * dropped. The copied queue holds messages for the user's REAL sessions, and a
 * test server delivers pending rows at boot and on every daemon connect: on
 * 2026-10-24 one did, resuming seven of the user's sessions under their own ids,
 * so seven duplicate agents wrote into the real transcripts and ran real tool
 * calls. Parked rows go too: Retry on one is a resume as well. The `settled`
 * and `relay` records stay; they are bookkeeping and deliver nothing.
 * A missing store drops nothing. A store that cannot be read, parsed or
 * rewritten is removed (fail closed), and that is said on stderr.
 */
export function dropSnapshotQueuedMessages(snapshotDir: string): number {
  const file = path.join(snapshotDir, SESSION_QUEUE_STORE_FILE)
  if (!fs.existsSync(file)) return 0
  const failClosed = (why: string): number => {
    process.stderr.write(`ephemeral: removing the copied session queue (${why})\n`)
    try { fs.rmSync(file, { force: true }) } catch { /* best-effort */ }
    // A queue that is still there after this would be replayed: refuse to go on.
    if (fs.existsSync(file)) throw new Error(`could not remove the copied session queue ${file}`)
    return 0
  }
  let store: { queues?: unknown }
  try {
    store = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch (err) {
    return failClosed(`unreadable: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!store || typeof store !== 'object' || Array.isArray(store)) return failClosed('not a queue store')
  const queues = store.queues
  if (queues === undefined) return 0
  if (!queues || typeof queues !== 'object' || Array.isArray(queues)) return failClosed('queues is not a map')
  let dropped = 0
  for (const rows of Object.values(queues as Record<string, unknown>)) {
    dropped += Array.isArray(rows) ? rows.length : 1
  }
  if (dropped === 0) return 0
  store.queues = {}
  try {
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2))
    fs.renameSync(tmp, file)
  } catch (err) {
    failClosed(`could not rewrite: ${err instanceof Error ? err.message : String(err)}`)
  }
  return dropped
}

/**
 * Config files the server reads: config.yaml, and config.yaml.bak, which
 * config-manager restores from when config.yaml is missing or unreadable.
 */
const CONFIG_FILES = ['config.yaml', 'config.yaml.bak']

/**
 * Drop `push_tokens` from the snapshot's config files. Returns how many tokens
 * were removed. Every push sender reads its devices from that list, so an
 * empty list means the test server has no phone to notify. A file that holds
 * tokens but cannot be parsed or rewritten is removed (fail closed): the server
 * then starts on its defaults rather than with the user's devices.
 */
export function stripSnapshotPushTokens(snapshotDir: string): number {
  let removed = 0
  for (const name of CONFIG_FILES) {
    const file = path.join(snapshotDir, name)
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf-8')
    } catch {
      continue
    }
    if (!raw.includes('push_tokens')) continue
    try {
      const doc = yaml.load(raw) as Record<string, unknown> | null
      if (!doc || typeof doc !== 'object' || !('push_tokens' in doc)) continue
      const tokens = doc.push_tokens
      delete doc.push_tokens
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, yaml.dump(doc, { indent: 2, lineWidth: 120 }))
      fs.renameSync(tmp, file)
      removed += Array.isArray(tokens) ? tokens.length : 0
    } catch {
      try { fs.rmSync(file, { force: true }) } catch { /* best-effort */ }
    }
  }
  return removed
}

/**
 * Turn off every tunnel in the snapshot's config files: this computer's
 * (`expose.enabled`) and each host server's (`hosts.<key>.server.expose.enabled`).
 * Returns how many were on. A tunnel service gives a name to whoever connected
 * last, so a test server starting the copied tunnel took the user's real address
 * for as long as it ran, and left it answering nothing when it stopped. A tester
 * who turns one on inside the snapshot gets it, under whatever name they give it.
 * A file that has tunnels on but cannot be rewritten is removed (fail closed).
 */
export function stopSnapshotTunnels(snapshotDir: string): number {
  let stopped = 0
  for (const name of CONFIG_FILES) {
    const file = path.join(snapshotDir, name)
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf-8')
    } catch {
      continue
    }
    if (!raw.includes('expose')) continue
    try {
      const doc = yaml.load(raw) as Record<string, unknown> | null
      if (!doc || typeof doc !== 'object') continue
      let here = 0
      const turnOff = (section: unknown) => {
        const e = section as { enabled?: unknown } | null
        if (e && typeof e === 'object' && e.enabled === true) { e.enabled = false; here++ }
      }
      turnOff(doc.expose)
      const hosts = doc.hosts && typeof doc.hosts === 'object' ? doc.hosts as Record<string, { server?: { expose?: unknown } } | null> : {}
      for (const host of Object.values(hosts)) turnOff(host?.server?.expose)
      if (here === 0) continue
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, yaml.dump(doc, { indent: 2, lineWidth: 120 }))
      fs.renameSync(tmp, file)
      // The two files are copies of one config: count one of them.
      stopped = Math.max(stopped, here)
    } catch {
      try { fs.rmSync(file, { force: true }) } catch { /* best-effort */ }
    }
  }
  return stopped
}

/**
 * Turn off Inbox Triage in the snapshot's config files (`triage.enabled`).
 * Returns 1 when it was on. Pausing the copied routines is not enough: at boot
 * the triage bootstrap brings its routine back in line with the config, and a
 * paused routine reads as out of line, so it was enabled again and ran an AI
 * session every hour against the user's live mail (2026-10-27: two runs in one
 * test server). A tester who turns triage on inside the snapshot gets it.
 * A file that has it on but cannot be rewritten is removed (fail closed).
 */
export function stopSnapshotTriage(snapshotDir: string): number {
  let stopped = 0
  for (const name of CONFIG_FILES) {
    const file = path.join(snapshotDir, name)
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf-8')
    } catch {
      continue
    }
    if (!raw.includes('triage')) continue
    try {
      const doc = yaml.load(raw) as Record<string, unknown> | null
      const triage = doc && typeof doc === 'object' ? doc.triage as { enabled?: unknown } | null : null
      if (!triage || typeof triage !== 'object' || triage.enabled !== true) continue
      triage.enabled = false
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, yaml.dump(doc, { indent: 2, lineWidth: 120 }))
      fs.renameSync(tmp, file)
      stopped = 1
    } catch {
      try { fs.rmSync(file, { force: true }) } catch { /* best-effort */ }
    }
  }
  return stopped
}

/**
 * Environment for the ephemeral child. It gets its own data dir and its own
 * runtime (daemon) dir; every variable that could point it, its daemon, or its
 * sessions back at the launching Walnut is dropped. The launcher usually runs
 * inside a session of the REAL Walnut, whose env carries that session's agent
 * socket, session id and API URL.
 */
export function ephemeralChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  snapshotDir: string,
  runtimeDir: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...parentEnv, OPEN_WALNUT_HOME: snapshotDir, WALNUT_DAEMON_DIR: runtimeDir,
    // Its sessions' task directories stay inside its own runtime dir, removed with it,
    // so a test never writes into the real ones (src/lib/task-dir.ts).
    WALNUT_TASK_DIR_ROOT: path.join(runtimeDir, 'task-dirs'),
  }
  for (const key of [
    'WALNUT_TASK_DIR',
    'WALNUT_STREAMS_DIR',
    'WALNUT_LEGACY_STREAMS_DIR',
    'WALNUT_FORCE_STREAMS_MIGRATION',
    'WALNUT_DAEMON_PARENT_PID',
    'WALNUT_AGENT_SOCKET',
    'WALNUT_SESSION_ID',
    'OPEN_WALNUT_API_URL',
    'WALNUT_SERVER_URL',
  ]) delete env[key]
  return env
}
