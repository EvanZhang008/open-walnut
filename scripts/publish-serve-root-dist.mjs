#!/usr/bin/env node
// Publish the build that now serves production into the checkout's own dist/.
//
//   node scripts/publish-serve-root-dist.mjs <from-dist> <to-dist>
//
// The `walnut` CLI on this machine is bin/open-walnut.js, which imports the
// checkout's dist/cli-fast.js and runs the op registry IN PROCESS: every op's
// description, input schema and outcome text comes from that bundle, not from
// the server it talks to. scripts/deploy-committed.sh builds in a clean clone
// and never writes there, so after it the CLI kept whatever the last
// working-tree build was (2026-10-05: sessions read a trigger_create
// description, and missed its new outcome, two deploys after both shipped).
// dev-prod.sh runs this after a successful deploy from a clone.
//
// Same shape as a build: files are written over, files the new build lacks are
// left alone (tsup runs with `clean: false`), except under the two directories
// a build empties first: web/static (vite's emptyOutDir; it would otherwise grow
// by one bundle per deploy) and data (`rm -rf dist/data` in the build script). Every file lands by rename, never half-written, and the two CLI
// entries land last, so a CLI started meanwhile runs either the old entry or
// the new one with its files already in place. Copies are clonefile where the
// filesystem has it (metadata only, nothing for an on-access scanner to read).
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const ENTRIES = ['cli.js', 'cli-fast.js']
export const MIRRORED = ['web/static', 'data']

function walk(root, rel = '', out = []) {
  for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name
    if (ent.isDirectory()) { out.push({ rel: r, kind: 'dir' }); walk(root, r, out) }
    else if (ent.isSymbolicLink()) out.push({ rel: r, kind: 'link' })
    else if (ent.isFile()) out.push({ rel: r, kind: 'file' })
  }
  return out
}

function lstatOrNull(p) {
  try { return fs.lstatSync(p) } catch { return null }
}

/** Write one file or link at `dst` by rename, replacing whatever is there. */
function place(src, dst, kind, tmpTag) {
  const tmp = `${dst}.${tmpTag}`
  try {
    if (kind === 'link') fs.symlinkSync(fs.readlinkSync(src), tmp)
    else {
      fs.copyFileSync(src, tmp, fs.constants.COPYFILE_FICLONE)
      fs.chmodSync(tmp, fs.statSync(src).mode & 0o7777)
    }
    const cur = lstatOrNull(dst)
    if (cur?.isDirectory()) fs.rmSync(dst, { recursive: true, force: true })
    fs.renameSync(tmp, dst)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
}

/** Copy `from` over `to` (see the header). Returns what it did, in order. */
export function publishDist(from, to, { tmpTag = `publish-${process.pid}.tmp` } = {}) {
  const src = path.resolve(from)
  const dst = path.resolve(to)
  if (src === dst) throw new Error(`refusing to publish ${src} onto itself`)
  for (const entry of ENTRIES) {
    const st = lstatOrNull(path.join(src, entry))
    if (!st?.isFile() || st.size === 0) throw new Error(`${path.join(src, entry)} is missing or empty: not a finished build`)
  }
  if (!fs.existsSync(path.join(path.dirname(dst), 'package.json'))) {
    throw new Error(`${path.dirname(dst)} is not a checkout (no package.json)`)
  }

  const items = walk(src)
  const isEntry = (rel) => ENTRIES.includes(rel)
  const order = []
  fs.mkdirSync(dst, { recursive: true })
  for (const it of items.filter((i) => i.kind === 'dir')) {
    const d = path.join(dst, it.rel)
    const cur = lstatOrNull(d)
    if (cur && !cur.isDirectory()) fs.rmSync(d, { force: true })
    fs.mkdirSync(d, { recursive: true })
  }
  const leaves = items.filter((i) => i.kind !== 'dir')
  for (const it of [...leaves.filter((i) => !isEntry(i.rel)), ...leaves.filter((i) => isEntry(i.rel))]) {
    place(path.join(src, it.rel), path.join(dst, it.rel), it.kind, tmpTag)
    order.push(it.rel)
  }

  // The directories a build empties first mirror the new build exactly.
  const pruned = []
  const keep = new Set(items.map((i) => i.rel))
  for (const dir of MIRRORED) {
    if (!fs.existsSync(path.join(src, dir)) || !lstatOrNull(path.join(dst, dir))?.isDirectory()) continue
    // Deepest first; a stale directory goes with everything under it.
    for (const it of walk(dst, dir).filter((i) => !keep.has(i.rel)).sort((a, b) => b.rel.length - a.rel.length)) {
      fs.rmSync(path.join(dst, it.rel), { recursive: true, force: true })
      pruned.push(it.rel)
    }
  }
  return { order, pruned }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [from, to] = process.argv.slice(2)
  if (!from || !to) {
    process.stderr.write('usage: publish-serve-root-dist.mjs <from-dist> <to-dist>\n')
    process.exit(2)
  }
  try {
    const t0 = Date.now()
    const { order, pruned } = publishDist(from, to)
    process.stdout.write(`Published the serving build to ${path.resolve(to)}: ${order.length} files, ${pruned.length} stale files removed, ${Date.now() - t0}ms.\n`)
  } catch (err) {
    process.stderr.write(`publish-serve-root-dist: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}
