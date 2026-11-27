#!/usr/bin/env bun
/**
 * Swap a freshly built web app (dist/web/static) under the RUNNING server, with no restart
 * (scripts/deploy-web.sh runs it; 2026-11-27: 22% of the deploys that restarted production changed
 * only web/, and every restart drops every window's socket and every host's link for seconds).
 *
 *   bun scripts/web-swap.mjs --from <dist/web/static> --expect-commit <sha> --web-commit <sha>
 *        [--config-url <url>] [--out <file>] [--wait <s>]
 *   bun scripts/web-swap.mjs --check --expect-commit <sha> [--config-url <url>]
 *
 * The server reads its static files from disk on every request and re-reads index.html's entry
 * bundle on a 60 s timer (src/web/server.ts refreshBundle), which /api/config reports as
 * webAssets.bundle and pushes to open windows (web:bundle), whose stale-assets check then moves
 * them to it when it can (web/src/utils/stale-assets.ts). So the swap copies every changed file of
 * the new build into the served dir ADDITIVELY (a window still on the old build keeps fetching its
 * old chunks), each through a temp file and a rename (no reader sees half a file), and index.html
 * LAST, then leaves a marker naming the web app's commit (.walnut-web-swap: a dotfile, never served)
 * and adds the build to the static mirror, so its chunks outlive the next deploy's stage sweep.
 *
 * It only swaps under the server it was asked for (--expect-commit, a clean build), in a deploy's
 * own stage tree (<stage>/runtime/<build>/dist/web/static) whose index.html is the bundle the
 * server says it serves; it checks the server again right before index.html moves. Anything else
 * exits 75 with a line starting "Web swap refused", and the deploy goes out with a restart instead.
 * --check makes the same checks and changes nothing (run before the build, so a refusal is cheap).
 *
 * The web app production serves is named by its "web id" (deploy-queue.sh dq_config_line): the
 * entry bundle, and "@<commit>" when a swap left its marker. --out gets the new web id.
 * Exit: 0 swapped (or nothing changed), 75 refused, 1 failed. Tested by tests/scripts/web-swap.test.ts.
 */
import fs from 'node:fs'
import path from 'node:path'

const REFUSED = 75
export const MARKER = '.walnut-web-swap'

function args(argv) {
  const out = { from: '', configUrl: 'http://127.0.0.1:3456/api/config', out: '', wait: 150, expect: '', webCommit: '', check: false }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const v = argv[i + 1]
    if (k === '--check') { out.check = true; continue }
    if (!['--from', '--config-url', '--out', '--wait', '--expect-commit', '--web-commit'].includes(k)) throw new Error(`unknown argument ${k}`)
    i++
    if (k === '--from') out.from = v
    else if (k === '--config-url') out.configUrl = v
    else if (k === '--out') out.out = v
    else if (k === '--wait') out.wait = Number(v)
    else if (k === '--expect-commit') out.expect = v
    else out.webCommit = v
  }
  if (!/^[0-9a-f]{7,40}$/.test(out.expect)) throw new Error('--expect-commit <sha of the build production serves> is required')
  if (!out.check && !out.from) throw new Error('--from <dist/web/static> is required')
  if (!out.check && !/^[0-9a-f]{7,40}$/.test(out.webCommit)) throw new Error('--web-commit <sha of the web app> is required')
  if (!Number.isFinite(out.wait) || out.wait < 0) out.wait = 150
  return out
}

/** The entry hash index.html loads (the same rule as src/web/static-mirror.ts bundleIdInHtml). */
export function bundleIdInHtml(html) {
  const script = /<script[^>]+src=["'][^"']*assets\/index-([A-Za-z0-9_-]+)\.js/.exec(html)
  return script ? script[1] : null
}

/** A deploy's stage tree, the only kind of dir this swaps into. */
export function isStageStaticDir(dir) {
  return path.isAbsolute(dir) && /\/open-walnut-stage\.[^/]+\/runtime\/[^/]+\/dist\/web\/static$/.test(dir)
}

function* files(root, rel = '') {
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) yield* files(root, r)
    else if (e.isFile()) yield r
  }
}

function same(a, b) {
  try {
    const sa = fs.statSync(a)
    const sb = fs.statSync(b)
    if (!sb.isFile() || sa.size !== sb.size) return false
    return fs.readFileSync(a).equals(fs.readFileSync(b))
  } catch {
    return false
  }
}

/** Copy one file into place through a temp file and a rename. */
function put(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  const tmp = `${dst}.swap-${process.pid}`
  fs.copyFileSync(src, tmp)
  fs.renameSync(tmp, dst)
}

function writeAtomic(dst, text) {
  const tmp = `${dst}.swap-${process.pid}`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, dst)
}

/** Copies every changed file of `from` but index.html into `to`. Returns how many it wrote. */
export function copyAssets(from, to) {
  let wrote = 0
  for (const rel of files(from)) {
    if (rel === 'index.html') continue
    if (same(path.join(from, rel), path.join(to, rel))) continue
    put(path.join(from, rel), path.join(to, rel))
    wrote++
  }
  return wrote
}

/** Moves index.html into place when it changed. True when it did. */
export function putIndex(from, to) {
  if (same(path.join(from, 'index.html'), path.join(to, 'index.html'))) return false
  put(path.join(from, 'index.html'), path.join(to, 'index.html'))
  return true
}

/** The whole swap, synchronously (tests; main checks the server between the two steps). */
export function swapInto(from, to) {
  return copyAssets(from, to) + (putIndex(from, to) ? 1 : 0)
}

async function served(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
  const c = await res.json()
  return {
    staticDir: c?.webAssets?.staticDir ?? null, mirrorDir: c?.webAssets?.mirrorDir ?? null, bundle: c?.webAssets?.bundle ?? null,
    commit: typeof c?.build?.commit === 'string' ? c.build.commit : '', dirty: c?.build?.dirty,
  }
}

const sameCommit = (a, b) => a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a))

async function main() {
  const o = args(process.argv.slice(2))
  const refuse = (why) => { console.log(`Web swap refused: ${why}`); process.exit(REFUSED) }
  /** The server as it must be for a swap: the one asked for, on a deploy's stage tree. */
  const verified = async () => {
    let now
    try { now = await served(o.configUrl) } catch (err) { refuse(`the server did not answer ${o.configUrl} (${err?.message ?? err})`) }
    if (!sameCommit(now.commit, o.expect) || now.dirty !== false) refuse(`the server runs ${now.commit || 'an unknown build'}${now.dirty === false ? '' : ' (not a clean build)'}, not ${o.expect.slice(0, 12)}`)
    if (!now.staticDir || !now.bundle) refuse('the server reports no web assets of its own (webAssets.staticDir and bundle)')
    if (!isStageStaticDir(now.staticDir)) refuse(`the server serves ${now.staticDir}, not a deploy's stage tree`)
    let html
    try { html = fs.readFileSync(path.join(now.staticDir, 'index.html'), 'utf8') } catch { refuse(`${now.staticDir}/index.html cannot be read`) }
    if (bundleIdInHtml(html) !== now.bundle) refuse(`${now.staticDir}/index.html is not the bundle the server serves (${now.bundle})`)
    return now
  }
  const now = await verified()
  if (o.check) { console.log(`The web app can be swapped under the running server (${now.staticDir}).`); return }
  const fresh = bundleIdInHtml(fs.readFileSync(path.join(o.from, 'index.html'), 'utf8'))
  if (!fresh) throw new Error(`${o.from}/index.html names no entry bundle`)
  const n = copyAssets(o.from, now.staticDir)
  // The server again, right before what clients load changes: a deploy outside the queue may have
  // replaced it while this built.
  await verified()
  const moved = putIndex(o.from, now.staticDir)
  const webCommit = o.webCommit.slice(0, 12)
  writeAtomic(path.join(now.staticDir, MARKER), `${webCommit}\n`)
  console.log(`Swapped the web app under the running server: bundle ${now.bundle} -> ${fresh}, ${n + (moved ? 1 : 0)} file(s) written into ${now.staticDir}`)
  if (fresh !== now.bundle) {
    const end = Date.now() + o.wait * 1000
    for (;;) {
      let b = null
      try { b = (await served(o.configUrl)).bundle } catch { /* keep waiting */ }
      if (b === fresh) break
      if (Date.now() >= end) {
        console.error(`The server still names bundle ${b} ${o.wait}s after the swap (it re-reads index.html every 60 s); the files are in place.`)
        process.exit(1)
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
    console.log(`The server serves bundle ${fresh}.`)
  }
  // The build's own generation in the static mirror, so a window on it keeps its chunks after the
  // next full deploy sweeps this stage (src/web/static-mirror.ts; the server adds one only at boot).
  if (now.mirrorDir) {
    try {
      const { refreshStaticMirror } = await import('../src/web/static-mirror.ts')
      const r = refreshStaticMirror({ staticDir: now.staticDir, mirrorDir: now.mirrorDir })
      for (const w of r.warnings ?? []) console.error(`static mirror: ${w}`)
    } catch (err) {
      console.error(`Could not add the build to the static mirror (${err?.message ?? err}); its chunks go with this stage.`)
    }
  }
  if (o.out) fs.writeFileSync(o.out, `${fresh}@${webCommit}\n`)
}

if (import.meta.main) {
  main().catch((err) => { console.error(`Web swap failed: ${err?.stack ?? err}`); process.exit(1) })
}
