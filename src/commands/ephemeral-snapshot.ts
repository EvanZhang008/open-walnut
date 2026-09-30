/**
 * Preparing a `web --ephemeral` snapshot so it can never act as the real Walnut.
 *
 * The snapshot is a copy of the user's data dir, automations included. Left as
 * copied, the test server's cron engine ran the user's real jobs a second time
 * (a Slack monitor, a daily digest, pipeline watches on shared hosts), and the
 * sessions those jobs started reached out to real services. Jobs the tester
 * creates inside the snapshot still run: cron and trigger features stay testable.
 * The same copy carries the phone's push tokens, so a test turn that finished
 * with no browser attached sent a notification to the user's real phone.
 */

import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

/**
 * Top-level WALNUT_HOME entries the ephemeral snapshot does not copy because
 * their owners already treat them as regenerable. See the filter in
 * copyDataSnapshot() for the measured sizes and the anchoring rationale.
 * `health` is the exception: the Apple Health store is not regenerable, it is
 * PRIVATE, and a test server must never carry a copy of it into $TMPDIR.
 */
export const SNAPSHOT_SKIP_TOP_LEVEL = new Set(['.git', '.smart-env', 'cache', 'health'])

/**
 * Copy the data dir `home` into the snapshot dir `dest`, leaving out what a test
 * server must not carry (the private health store, live locks, sockets and FIFOs)
 * or does not need (regenerable caches, streams, images, SQLite files). This is
 * the launcher's one copy step, and the tests run this very function on a real tree.
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
      // Skip SQLite files (WAL-locked, ephemeral creates fresh ones)
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
  const env: NodeJS.ProcessEnv = { ...parentEnv, OPEN_WALNUT_HOME: snapshotDir, WALNUT_DAEMON_DIR: runtimeDir }
  for (const key of [
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
