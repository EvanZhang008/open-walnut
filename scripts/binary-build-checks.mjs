/**
 * Checks of the compiled Walnut file's build (scripts/build-binary.mjs) that
 * need no bun, so the test suite runs them on Node too
 * (tests/binary/build-paths.test.ts).
 */
import fs from 'node:fs'
import path from 'node:path'

/** `source` with `__dirname` read as `rel` (a repo-relative dir) inside the runtime tree. */
export function runtimeDirname(source, rel) {
  if (!/\b__dirname\b/.test(source)) return source
  const dir = `globalThis.__WALNUT_SINGLE_FILE__.root + ${JSON.stringify(`/${rel}`)}`
  return `var __walnut_dirname = ${dir};\n${source.replace(/\b__dirname\b/g, '__walnut_dirname')}`
}

/**
 * The dir of a package module inside the runtime tree, `node_modules/<pkg>/<sub>`,
 * from the LAST node_modules of its path; null outside node_modules. Read from the
 * path, never relative to the repo: a build whose node_modules entries are links
 * (scripts/deploy-committed.sh, src/core/host-server/host-file-build.ts) resolves
 * modules to the linked checkout, outside the repo, and a repo-relative path then
 * names that checkout (`../../walnut/node_modules/...`, the builder's home inside).
 */
export function treeDirOf(file) {
  const parts = path.dirname(file).split(/[\\/]+/)
  const at = parts.lastIndexOf('node_modules')
  if (at === -1 || at === parts.length - 1) return null
  return parts.slice(at).join('/')
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
