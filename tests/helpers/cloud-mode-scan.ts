/**
 * Counts the raw cloud mode reads in a TypeScript source: the `CLOUD_MODE`
 * constant, and the env key itself (`process.env.WALNUT_CLOUD_MODE`,
 * `env['WALNUT_CLOUD_MODE']`, an env object key). Comments, other string text
 * and import declarations do not count; an expression inside a template
 * literal does. Used by tests/core/companion-is-a-replica-ratchet.test.ts.
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * A string literal with exactly this text is kept: the env key read by name, and the two
 * values a "this is the companion" comparison names (followerKind() === 'companion',
 * placement() === 'cloud').
 */
const KEPT_STRINGS = new Set(['WALNUT_CLOUD_MODE', 'WALNUT_PLACEMENT', 'companion', 'cloud'])

/** The source with comments removed and string text blanked (quotes and `${}` expressions kept). */
export function codeOnly(src: string): string {
  let out = ''
  let i = 0
  // Each entry: the brace depth at which a template's `${` was opened.
  const templates: number[] = []
  let depth = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const next = src[i + 1]
    if (c === '/' && next === '/') { while (i < n && src[i] !== '\n') i++; continue }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end < 0 ? n : end + 2
      for (const ch of src.slice(i, stop)) out += ch === '\n' ? '\n' : ' '
      i = stop
      continue
    }
    if (c === "'" || c === '"') {
      const close = src.indexOf(c, i + 1)
      if (close > i && KEPT_STRINGS.has(src.slice(i + 1, close))) { out += src.slice(i, close + 1); i = close + 1; continue }
      out += c
      i++
      while (i < n && src[i] !== c && src[i] !== '\n') { if (src[i] === '\\') { out += ' '; i++ } out += ' '; i++ }
      if (i < n) { out += src[i]; i++ }
      continue
    }
    if (c === '`' || (c === '}' && templates.length > 0 && templates[templates.length - 1] === depth)) {
      if (c === '}') { templates.pop(); depth-- }
      out += c
      i++
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') { out += '  '; i += 2; continue }
        if (src[i] === '$' && src[i + 1] === '{') { depth++; templates.push(depth); out += '${'; i += 2; break }
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      if (i < n && src[i] === '`') { out += '`'; i++ }
      continue
    }
    if (c === '{') depth++
    else if (c === '}') depth--
    out += c
    i++
  }
  return out
}

const IMPORT_RE = /\b(?:import|export)\s+(?:type\s+)?\{[^}]*\}\s*from\s*(['"])\s*\1/g

export function countCloudModeReads(src: string): number {
  const code = codeOnly(src).replace(IMPORT_RE, ' ')
  // `\b` does not split WALNUT_CLOUD_MODE, so the env key needs its own pattern.
  return (code.match(/\bCLOUD_MODE\b/g) ?? []).length + (code.match(/\bWALNUT_CLOUD_MODE\b/g) ?? []).length
}

/** Every .ts file under `dir`, repo-relative with forward slashes. */
export function listTsFiles(root: string, dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && /\.(ts|tsx|mts)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(path.relative(root, p).split(path.sep).join('/'))
    }
  }
  walk(path.join(root, dir))
  return out.sort()
}

/** Raw CLOUD_MODE reads per file under src/ (files with none left out). */
export function scanCloudModeReads(root: string): Map<string, number> {
  const found = new Map<string, number>()
  for (const rel of listTsFiles(root, 'src')) {
    const n = countCloudModeReads(fs.readFileSync(path.join(root, rel), 'utf8'))
    if (n > 0) found.set(rel, n)
  }
  return found
}

/**
 * Every way a server file asks "is this server the cloud companion" (AGENTS.md, "The cloud
 * companion is a replica with capabilities"): a raw CLOUD_MODE read (also through an import
 * alias), any reference to isCompanion (a call, a value passed on, an alias), followerKind()
 * or a `placement` value compared with 'companion' / 'cloud' in either quote style, a switch on
 * followerKind(), and a read of the WALNUT_PLACEMENT env key. Named meanings in server-role.ts
 * (runsSessions(), confinesLocalFiles(), ...) are what a feature should ask, so they do not count.
 */
export function countCompanionChecks(src: string): number {
  const full = codeOnly(src)
  const aliases = new Set<string>()
  for (const m of full.matchAll(/\b(?:isCompanion|CLOUD_MODE)\s+as\s+(\w+)/g)) aliases.add(m[1])
  // A destructured rename (`const { isCompanion: ic } = await import(...)`): every use of `ic` counts.
  for (const m of full.matchAll(/\b(?:isCompanion|CLOUD_MODE)\s*:\s*(\w+)\s*[,}]/g)) aliases.add(m[1])
  const code = full.replace(IMPORT_RE, ' ')
  const q = `['"]`
  const count = (re: RegExp) => (code.match(re) ?? []).length
  let n = countCloudModeReads(src)
  n += count(/\bisCompanion\b/g) - count(/\bfunction\s+isCompanion\b/g)
  n += count(new RegExp(`\\bfollowerKind\\s*\\(\\s*\\)\\s*[!=]==?\\s*${q}companion${q}|${q}companion${q}\\s*[!=]==?\\s*followerKind\\s*\\(\\s*\\)`, 'g'))
  n += count(new RegExp(`\\bplacement\\b(?:\\s*\\(\\s*\\))?\\s*[!=]==?\\s*${q}cloud${q}|${q}cloud${q}\\s*[!=]==?\\s*(?:\\w+\\.)*placement\\b`, 'g'))
  n += count(/\bswitch\s*\(\s*(?:followerKind|placement)\s*\(\s*\)\s*\)/g)
  n += count(/\.includes\s*\(\s*(?:followerKind|placement)\s*\(\s*\)\s*\)/g)
  n += count(/\bWALNUT_PLACEMENT\b/g)
  for (const a of aliases) n += count(new RegExp(`\\b${a}\\b`, 'g'))
  return n
}

/** Companion checks per file under src/ (files with none left out). */
export function scanCompanionChecks(root: string): Map<string, number> {
  const found = new Map<string, number>()
  for (const rel of listTsFiles(root, 'src')) {
    const n = countCompanionChecks(fs.readFileSync(path.join(root, rel), 'utf8'))
    if (n > 0) found.set(rel, n)
  }
  return found
}
