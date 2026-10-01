#!/usr/bin/env node
/**
 * The notes of one release: its CHANGELOG.md section body, for the GitHub Release
 * the workflow opens after publishing. `node scripts/release-notes.mjs 0.6.0`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The body under `## [version]`, up to the next `## [` heading; null when absent or empty. */
export function releaseNotes(text, version) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`))
  if (start < 0) return null
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## ['))
  if (end < 0) end = lines.length
  const body = lines.slice(start + 1, end).join('\n').trim()
  return body || null
}

function main() {
  const version = (process.argv[2] ?? '').replace(/^v/, '')
  if (!version) {
    process.stderr.write('usage: release-notes.mjs <version>\n')
    process.exit(2)
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const notes = releaseNotes(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), version)
  process.stdout.write(`${notes ?? 'See CHANGELOG.md.'}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
