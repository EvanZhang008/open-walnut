/**
 * The repo's source, read once per test file, for guards that scan it ("every caller of X
 * does Y"). Each file is read in parallel and kept with its comments stripped, so a guard
 * asks any number of questions of it for the price of one read.
 *
 * Why not a loop of readFileSync per question: a scan of src/ and web/src/ is about 4,500
 * files, and on a loaded machine each synchronous read waits its turn (2026-11-15, load 110:
 * 28 s for one sequential pass, 2.6 s for the same files read in parallel). A guard that scanned
 * five times read them five times and ran out its 15 s.
 */
import fs from 'node:fs'
import path from 'node:path'

export interface SourceSet {
  /** Every .ts/.tsx file under the dirs, repo-relative with forward slashes, sorted. */
  readonly files: readonly string[]
  /** A file's text with block and line comments removed. */
  code(rel: string): string
  /** The files whose comment-free text matches `re`, sorted. */
  filesWith(re: RegExp): string[]
}

async function walk(root: string, dir: string): Promise<string[]> {
  const entries = await fs.promises.readdir(path.join(root, dir), { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (e) => {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) return walk(root, rel)
    return /\.(ts|tsx)$/.test(e.name) ? [rel] : []
  }))
  return nested.flat()
}

/** Comments out, as the guards read the source: a word in a comment is no call. */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** Read `dirs` under `root` once, in parallel. A file asked for outside them is read (once) on demand. */
export async function loadSources(root: string, dirs: readonly string[]): Promise<SourceSet> {
  const files = (await Promise.all(dirs.map((d) => walk(root, d)))).flat().sort()
  const texts = new Map<string, string>()
  // At most READERS files open at once: a box whose open-file limit is 256 or 1024 never sees EMFILE.
  const READERS = 64
  let next = 0
  await Promise.all(Array.from({ length: Math.min(READERS, files.length) }, async () => {
    while (next < files.length) {
      const rel = files[next++]!
      texts.set(rel, stripComments(await fs.promises.readFile(path.join(root, rel), 'utf8')))
    }
  }))
  const code = (rel: string): string => {
    let text = texts.get(rel)
    if (text === undefined) texts.set(rel, text = stripComments(fs.readFileSync(path.join(root, rel), 'utf8')))
    return text
  }
  return { files, code, filesWith: (re) => files.filter((f) => re.test(code(f))) }
}
