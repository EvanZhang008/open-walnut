/**
 * Check that replay fixtures are shape-only (shape.mjs validateStream) and that no two are the
 * same recording twice. A directory means every `*.jsonl` in it at any depth, whatever its name
 * (a private stream hidden under an ordinary name is exactly what this must catch); a symlink or any
 * other file there except README.md is a problem too.
 *
 *   bun scripts/incident-replay/validate.ts                # tests/fixtures/incident-replays
 *   bun scripts/incident-replay/validate.ts <file|dir>...
 *
 * Exit 0 clean, 1 problems, 2 usage. Output names files, lines, masked paths and reasons only.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findDuplicateFixtures, validateStream } from './shape.mjs'

export const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', 'incident-replays')

export interface FixtureProblem { file: string; line: number; path: string; reason: string }

/** Files a fixture directory may hold besides replays, directly inside it (never nested). */
const DOC_FILES = new Set(['README.md'])

/**
 * Every `*.jsonl` under the given files and directories, at any depth. Never follows a symlink:
 * a symlink, or a file that is neither a replay nor a doc, is a problem (a private log under
 * another name or extension must not slip past the guard).
 */
export function fixtureFiles(targets: string[]): { files: string[]; problems: FixtureProblem[] } {
  const files: string[] = []
  const problems: FixtureProblem[] = []
  const visit = (p: string, depth: number): void => {
    const st = fs.lstatSync(p)
    if (st.isSymbolicLink()) problems.push({ file: p, line: 0, path: '<file>', reason: 'symlink (never followed)' })
    else if (st.isDirectory()) for (const name of fs.readdirSync(p).sort()) visit(path.join(p, name), depth + 1)
    else if (!st.isFile()) problems.push({ file: p, line: 0, path: '<file>', reason: 'not a regular file' })
    else if (p.endsWith('.jsonl') || depth === 0) files.push(p)
    else if (!(depth === 1 && DOC_FILES.has(path.basename(p)))) problems.push({ file: p, line: 0, path: '<file>', reason: 'unexpected file in a replay fixture directory' })
  }
  for (const t of targets) visit(t, 0)
  return { files, problems }
}

/** Validate each file, then report byte-identical fixtures as duplicates. */
export function validateFixtures(targets: string[] = [FIXTURE_DIR]): { files: string[]; problems: FixtureProblem[] } {
  const { files, problems } = fixtureFiles(targets)
  const seen: { name: string; content: string }[] = []
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8')
    for (const e of validateStream(content).errors) problems.push({ file, ...e })
    seen.push({ name: file, content })
  }
  for (const group of findDuplicateFixtures(seen)) {
    for (const file of group.slice(1)) problems.push({ file, line: 0, path: '<file>', reason: `same recording as ${path.basename(group[0])}` })
  }
  return { files, problems }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.some((a) => a.startsWith('-'))) { console.error('usage: bun scripts/incident-replay/validate.ts [file|dir]...'); process.exit(2) }
  const { files, problems } = validateFixtures(args.length ? args : [FIXTURE_DIR])
  for (const p of problems) console.log(`${path.relative(process.cwd(), p.file)}:${p.line} ${p.path}: ${p.reason}`)
  console.log(`${files.length} fixture file(s), ${problems.length} problem(s)`)
  process.exit(problems.length ? 1 : 0)
}
