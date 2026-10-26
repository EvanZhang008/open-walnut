/**
 * Checks and staging steps of the compiled Walnut file's build
 * (scripts/build-binary.mjs) that need no bun, so the test suite runs them on
 * Node too (tests/binary/build-paths.test.ts).
 */
import fs from 'node:fs'
import path from 'node:path'

/** `source` with `__dirname` read as `rel` (a repo-relative dir) inside the runtime tree. */
export function runtimeDirname(source, rel) {
  if (!/\b__dirname\b/.test(source)) return source
  const dir = `globalThis.__WALNUT_SINGLE_FILE__.root + ${JSON.stringify(`/${rel}`)}`
  return `var __walnut_dirname = ${dir};\n${source.replace(/\b__dirname\b/g, '__walnut_dirname')}`
}

function readdirOrNone(dir) {
  try { return fs.readdirSync(dir) } catch { return [] }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

/**
 * Where the modules of `repo` resolve to, each mapped back to its place in the
 * runtime tree: `<repo>/node_modules` itself, and every top-level entry that is a
 * link, since a deploy clone (scripts/deploy-committed.sh,
 * src/core/host-server/host-file-build.ts) links each one to the checkout's and
 * bun hands the build the link's target. Longest first.
 */
export function moduleRoots(repo) {
  const nm = path.join(repo, 'node_modules')
  const out = []
  const add = (dir, rel) => { try { out.push({ real: fs.realpathSync(dir), rel }) } catch { /* gone */ } }
  add(nm, 'node_modules')
  const linked = (dir, rel) => { try { if (fs.lstatSync(dir).isSymbolicLink()) add(dir, rel) } catch { /* gone */ } }
  for (const e of readdirOrNone(nm)) {
    if (e.startsWith('@')) {
      linked(path.join(nm, e), `node_modules/${e}`)
      for (const sub of readdirOrNone(path.join(nm, e))) linked(path.join(nm, e, sub), `node_modules/${e}/${sub}`)
    } else {
      linked(path.join(nm, e), `node_modules/${e}`)
    }
  }
  return out.sort((a, b) => b.real.length - a.real.length)
}

/**
 * The dir of a package module inside the runtime tree, with every node_modules on
 * its way (`node_modules/b/node_modules/c/lib`), so a nested copy of a package
 * keeps its own files; null outside node_modules. Taken against `roots`
 * (moduleRoots): a module bun resolved through a linked entry lives outside the
 * repo, and a repo-relative path then named the checkout it links to (with the
 * builder's home in it). Without a matching root, the path from its FIRST
 * node_modules segment.
 */
export function treeDirOf(file, roots = []) {
  const dir = path.dirname(file)
  let parts = null
  for (const r of roots) {
    if (dir === r.real || dir.startsWith(r.real + path.sep)) {
      parts = [...r.rel.split('/'), ...path.relative(r.real, dir).split(path.sep).filter(Boolean)]
      break
    }
  }
  if (!parts) {
    const all = dir.split(/[\\/]+/)
    const at = all.indexOf('node_modules')
    if (at === -1) return null
    parts = all.slice(at)
  }
  return parts.length > 1 ? parts.join('/') : null
}

/**
 * Every installed copy of package `name` under `<repo>/node_modules`, as its path
 * in the runtime tree (`node_modules/name`, `node_modules/b/node_modules/name`),
 * so a file it reads through __dirname is copied beside each copy and a nested
 * one of another version never reads the top-level copy's file.
 */
export function packageCopies(repo, name) {
  const found = []
  const seen = new Set()
  const walk = (nmDir, rel) => {
    let real
    try { real = fs.realpathSync(nmDir) } catch { return }
    if (seen.has(real)) return
    seen.add(real)
    if (fs.existsSync(path.join(nmDir, name, 'package.json'))) found.push(`${rel}/${name}`)
    for (const e of readdirOrNone(nmDir)) {
      if (e.startsWith('.')) continue
      const pkgs = e.startsWith('@') ? readdirOrNone(path.join(nmDir, e)).map((sub) => `${e}/${sub}`) : [e]
      for (const pkg of pkgs) {
        const sub = path.join(nmDir, pkg, 'node_modules')
        if (isDir(sub)) walk(sub, `${rel}/${pkg}/node_modules`)
      }
    }
  }
  walk(path.join(repo, 'node_modules'), 'node_modules')
  return found.sort()
}

/**
 * Fail the build when the file carries a path of the machine that built it: such a
 * path exists nowhere else, so whatever reads it works only where it was built.
 */
export function assertNoBuildPaths(outfile, roots) {
  const bytes = fs.readFileSync(outfile)
  const needles = [...new Set(roots.filter((p) => p.length > 1).map((p) => p + path.sep))]
  const hits = new Map()
  for (const needle of needles) {
    const n = Buffer.from(needle)
    for (let at = bytes.indexOf(n); at !== -1 && hits.size < 20; at = bytes.indexOf(n, at + n.length)) {
      const tail = bytes.subarray(at, Math.min(bytes.length, at + 160)).toString('latin1').split(/["'`\s,;)]/)[0]
      hits.set(tail, (hits.get(tail) ?? 0) + 1)
    }
  }
  if (hits.size > 0) {
    const list = [...hits].map(([p, count]) => `  ${p}${count > 1 ? ` (x${count})` : ''}`).join('\n')
    throw new Error(`${path.basename(outfile)} carries paths of the build machine; give the module that names them its runtime-tree path (DIRNAME_PACKAGES):\n${list}`)
  }
}

/**
 * The AWS CDK app into the runtime tree at `root`, as an npm install of the
 * source package ships it: the package.json `files` entries under infra/,
 * without built .js or .d.ts. The cloud setup deploys from a copy of it
 * (src/core/cloud-setup/providers/aws.ts), so a compiled install deploys the AWS
 * companion too. Returns the entries copied.
 */
export function copyInfraApp(repo, root) {
  const files = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).files ?? []
  const entries = files.filter((f) => f.startsWith('infra/'))
  if (!entries.length) throw new Error('package.json files lists no infra/ entry')
  for (const rel of entries) {
    const from = path.join(repo, rel)
    if (!fs.existsSync(from)) throw new Error(`${rel} (package.json files) is missing`)
    fs.cpSync(from, path.join(root, rel), { recursive: true, dereference: true, filter: (src) => !/\.(js|d\.ts)$/.test(src) })
  }
  return entries
}
