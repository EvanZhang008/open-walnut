/**
 * A stand-in `gh` for the tests of the release scripts and workflow steps
 * (release-attach.sh, release-archive-sums.sh, release.yml and
 * release-archives.yml steps): GitHub Releases as directories under
 * $FAKE_STATE/releases/<tag>/ holding their assets, a `.draft` file while one is
 * a draft and `.meta.json` with what `release create` was given. Every call is
 * appended to $FAKE_STATE/gh.log. FAKE_GH_FAIL names `release` subcommands
 * (`view,download,...`) that fail the way a GitHub outage does; FAKE_GH_FAIL_CREATE=1
 * fails `release create` alone.
 *
 * It answers only what the scripts ask (`view` with no output or with
 * `--json assets --jq '.assets[].name'` or `--json isDraft --jq .isDraft`, and
 * `download --pattern <exact name>`), and fails loudly on anything else, so a
 * script that starts asking something new is noticed here first.
 */
import fs from 'node:fs'
import path from 'node:path'

export const FAKE_GH_RELEASES = `#!/usr/bin/env node
const fs = require('fs'), path = require('path')
const state = process.env.FAKE_STATE
const args = process.argv.slice(2)
fs.appendFileSync(path.join(state, 'gh.log'), args.join(' ') + '\\n')
const die = (code, text) => { process.stderr.write(text + '\\n'); process.exit(code) }
const [cmd, sub, tag, ...rest] = args
if (cmd === 'workflow' && sub === 'run') process.exit(0)
if (cmd !== 'release') die(2, 'fake gh: unsupported ' + args.join(' '))
const failing = (process.env.FAKE_GH_FAIL || '').split(',')
if (failing.includes(sub) || (sub === 'create' && process.env.FAKE_GH_FAIL_CREATE === '1')) die(1, 'HTTP 502: Bad Gateway (https://api.github.com/)')
const dir = path.join(state, 'releases', tag)
const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined }
if (sub === 'create') {
  if (fs.existsSync(dir)) die(1, 'a release with the same tag name already exists: ' + tag)
  fs.mkdirSync(dir, { recursive: true })
  if (rest.includes('--draft')) fs.writeFileSync(path.join(dir, '.draft'), '')
  fs.writeFileSync(path.join(dir, '.meta.json'), JSON.stringify(rest.filter((a) => a !== '--draft')))
  process.exit(0)
}
if (!fs.existsSync(dir)) die(1, 'release not found')
const names = () => fs.readdirSync(dir).filter((n) => !n.startsWith('.')).sort()
if (sub === 'view') {
  const json = flag('--json'), jq = flag('--jq')
  if (json === undefined) process.exit(0)
  if (json === 'assets' && jq === '.assets[].name') { process.stdout.write(names().map((n) => n + '\\n').join('')); process.exit(0) }
  if (json === 'isDraft' && jq === '.isDraft') { process.stdout.write(String(fs.existsSync(path.join(dir, '.draft'))) + '\\n'); process.exit(0) }
  die(2, 'fake gh: unsupported ' + args.join(' '))
}
if (sub === 'edit') {
  if (rest.includes('--draft=false')) fs.rmSync(path.join(dir, '.draft'), { force: true })
  process.exit(0)
}
if (sub === 'upload') {
  const clobber = rest.includes('--clobber')
  for (const f of rest.filter((a) => a !== '--clobber')) {
    const to = path.join(dir, path.basename(f))
    if (fs.existsSync(to) && !clobber) die(1, 'asset under the same name already exists: ' + path.basename(f))
    fs.copyFileSync(f, to)
  }
  process.exit(0)
}
if (sub === 'download') {
  const pattern = flag('--pattern'), out = flag('--dir') || '.'
  if (!pattern || /[*?[]/.test(pattern)) die(2, 'fake gh: unsupported ' + args.join(' '))
  if (!names().includes(pattern)) die(1, 'no assets match the file pattern')
  fs.mkdirSync(out, { recursive: true })
  if (fs.existsSync(path.join(out, pattern)) && !rest.includes('--clobber')) die(1, 'already exists (use --clobber to overwrite file)')
  fs.copyFileSync(path.join(dir, pattern), path.join(out, pattern))
  process.exit(0)
}
die(2, 'fake gh: unsupported ' + args.join(' '))
`

/** Put the fake `gh` in `bin`. */
export function installFakeGh(bin: string): void {
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH_RELEASES, { mode: 0o755 })
}

/** A release in the fake's state, holding `assets` (name -> path or contents). */
export function makeRelease(state: string, tag: string, { draft = false, assets = {} }: { draft?: boolean; assets?: Record<string, string | Buffer> } = {}): string {
  const dir = path.join(state, 'releases', tag)
  fs.mkdirSync(dir, { recursive: true })
  if (draft) fs.writeFileSync(path.join(dir, '.draft'), '')
  for (const [name, body] of Object.entries(assets)) fs.writeFileSync(path.join(dir, name), body)
  return dir
}

/** The asset names a release holds now. */
export function releaseAssets(state: string, tag: string): string[] {
  const dir = path.join(state, 'releases', tag)
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => !n.startsWith('.')).sort() : []
}

export const isDraft = (state: string, tag: string): boolean => fs.existsSync(path.join(state, 'releases', tag, '.draft'))

/** Every `gh` call so far, one per line. */
export function ghCalls(state: string): string[] {
  const file = path.join(state, 'gh.log')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
}
