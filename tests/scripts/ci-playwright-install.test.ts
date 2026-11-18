import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// `playwright install --with-deps` runs apt, whose mirror can stall with no output (run
// 42763058265: a browser leg sat 58 minutes in apt-get update until the job's limit cancelled
// it, before one spec ran) or crawl (runs 44183551860 and 44223991725: 17 of 18 shards whose
// runner listed one cloud's regional mirror first fetched at about 100 kB/s, 15 to 22 minutes).
// Every such install in a workflow goes through scripts/ci/install-browsers.sh, which installs
// only what the runner lacks, from the fastest mirror, and bounds every network step.
const ROOT = path.resolve(__dirname, '../..')
const DIR = path.join(ROOT, '.github/workflows')
const SCRIPT = 'scripts/ci/install-browsers.sh'
const source = () => fs.readFileSync(path.join(ROOT, SCRIPT), 'utf8')

export function directInstalls(name: string, yml: string): string[] {
  return yml.split('\n').flatMap((line, i) =>
    /playwright install --with-deps/.test(line) ? [`${name}:${i + 1}: ${line.trim()}`] : [])
}

describe('workflows bound the browser install', () => {
  it('no workflow runs playwright install --with-deps itself', () => {
    const files = fs.readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f))
    const found = files.flatMap((f) => directInstalls(f, fs.readFileSync(path.join(DIR, f), 'utf8')))
    expect(found).toEqual([])
    const users = files.filter((f) => fs.readFileSync(path.join(DIR, f), 'utf8').includes(SCRIPT))
    expect(users, 'the workflows that install browsers with their system packages').toEqual(
      expect.arrayContaining(['ci.yml', 'push-gate.yml']))
  })

  it('the script bounds apt and every network step, and waits out a killed apt-get', () => {
    const s = source()
    expect(s).toMatch(/Acquire::https?::Timeout/)
    expect(s).toMatch(/Acquire::Retries/)
    expect(s).toMatch(/DPkg::Lock::Timeout/)
    expect(s).toMatch(/fuser \/var\/lib\/dpkg\/lock-frontend/)
    // Run as root under their own timeout, so a kill reaches apt-get, not only a wrapper.
    expect(s).toMatch(/sudo timeout \d+ apt-get update/)
    expect(s).toMatch(/sudo timeout \d+ apt-get .*--download-only/)
    expect(s).toMatch(/timeout \d+ xargs -r -P \d+/)
    expect(s).toMatch(/sudo timeout \d+ dpkg --configure -a/)
    expect(s).toMatch(/timeout \d+ bun x playwright install --with-deps "\$@"/)
  })

  it('the scan catches a direct install', () => {
    expect(directInstalls('x.yml', '      - run: bun x playwright install --with-deps chromium')).toHaveLength(1)
    expect(directInstalls('x.yml', '        run: bash scripts/ci/install-browsers.sh chromium webkit')).toEqual([])
  })
})

// The script itself, run against stand-ins for sudo, apt, dpkg, curl and bun that log each call.
describe('install-browsers.sh', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

  function run(opts: { want: string; installed: string; aptFails?: boolean; mirrorsDown?: boolean }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-browsers-'))
    dirs.push(dir)
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(bin)
    const calls = path.join(dir, 'calls')
    const stub = (name: string, body: string) =>
      fs.writeFileSync(path.join(bin, name), `#!/bin/bash\necho "${name} $*" >>"${calls}"\n${body}\n`, { mode: 0o755 })
    stub('sudo', 'case $1 in tee) cat >/dev/null ;; fuser) exit 1 ;; *) "$@" ;; esac')
    stub('timeout', 'shift; "$@"')
    stub('dpkg', 'exit 0')
    stub('dpkg-query', `case " ${opts.installed} " in *" $3 "*) printf 'ii ' ;; *) exit 1 ;; esac`)
    stub('bun', `case "$*" in *--dry-run*) [ -n "${opts.want}" ] && echo 'sudo -- sh -c "apt-get update&& apt-get install -y --no-install-recommends ${opts.want}"' ;; esac; exit 0`)
    stub('apt-get', [
      // An epoch in the version: apt's cache file name says %3a where the pool's says nothing.
      `case "$*" in *--print-uris*) echo "'mirror+file:/etc/apt/apt-mirrors.txt/pool/main/l/libx/libx_1_amd64.deb' libx_1%3a1_amd64.deb 500000 MD5Sum:0" ;;`,
      `*install*) ${opts.aptFails ? 'exit 100' : 'exit 0'} ;; esac`,
    ].join('\n'))
    // The probe asks for "<code> <speed> <mirror>"; a fetch writes the package's 500000 bytes.
    // The first public mirror lacks every package; with mirrorsDown, every mirror does.
    stub('curl', [
      'w=""; o=""; u=""; code=200',
      'while [ $# -gt 0 ]; do case $1 in -w) w=$2; shift ;; -o) o=$2; shift ;; http*) u=$1 ;; esac; shift; done',
      `case $u in *azure*${opts.mirrorsDown ? '|*' : ''}) code=404 ;; esac`,
      'if [ -n "$w" ]; then w=${w//%\\{http_code\\}/$code}; printf "${w//%\\{speed_download\\}/1000}"; exit 0; fi',
      '[ $code = 200 ] || exit 22',
      'head -c 500000 /dev/zero >"$o"',
    ].join('\n'))
    const r = spawnSync('bash', [path.join(ROOT, SCRIPT), 'chromium', 'webkit'], {
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, RUNNER_TEMP: dir },
    })
    const log = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : ''
    return { code: r.status, out: r.stdout + r.stderr, log, dir }
  }

  it('skips apt when the runner already has every package', () => {
    const r = run({ want: 'liba libb', installed: 'liba libb' })
    expect(r.code).toBe(0)
    expect(r.log).not.toMatch(/^apt-get/m)
    expect(r.out).toMatch(/all 2 system packages are already installed/)
    expect(r.log).toMatch(/^bun x playwright install chromium webkit$/m)
  })

  it('installs only the missing packages, from a cache filled from the mirror that has them', () => {
    const r = run({ want: 'liba libb libc', installed: 'libb' })
    expect(r.code).toBe(0)
    const installs = r.log.split('\n').filter((l) => /^apt-get .*\binstall\b/.test(l) && !/--print-uris/.test(l))
    expect(installs.map((l) => /--download-only/.test(l))).toEqual([true, false])
    for (const l of installs) {
      expect(l).toMatch(/Dir::Cache::Archives=/)
      expect(l).toMatch(/--no-install-recommends liba libc$/)
    }
    expect(r.log).toMatch(/^curl .*http:\/\/archive\.ubuntu\.com\/ubuntu\/pool\/main\/l\/libx\/libx_1_amd64\.deb$/m)
    const cache = fs.readdirSync(r.dir).find((d) => d.startsWith('install-browsers.'))!
    expect(fs.statSync(path.join(r.dir, cache, 'debs', 'libx_1%3a1_amd64.deb')).size).toBe(500000)
    expect(r.out).toMatch(/prefetched 1 of 1 packages/)
    expect(r.out).not.toMatch(/::(error|warning)::/)
  })

  it('leaves the fetch to apt, and says so, when no mirror has the probed package', () => {
    const r = run({ want: 'liba', installed: '', mirrorsDown: true })
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/::warning::no apt mirror answered the probe/)
    expect(r.log).toMatch(/^apt-get .*--download-only/m)
  })

  // Nightly extra tests run 43041166867 (2026-11-11): the runner could not resolve apt's mirror on
  // either try, and every spec then failed on a browser that was never downloaded.
  it('names the packages apt never installed, and still installs the browsers', () => {
    const r = run({ want: 'liba libb', installed: '', aptFails: true })
    expect(r.out).toMatch(/::warning::apt try 2 did not finish/)
    expect(r.out).toMatch(/::error::these system packages did not install.*: liba libb/)
    // Each try first recovers dpkg from a try killed mid-unpack.
    expect(r.log.match(/^sudo timeout \d+ dpkg --configure -a$/gm)).toHaveLength(2)
    expect(r.log).toMatch(/^bun x playwright install chromium webkit$/m)
    expect(r.code).toBe(0)
  })

  it('lets Playwright install them itself when its dry run lists nothing', () => {
    const r = run({ want: '', installed: '' })
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/::warning::playwright install-deps --dry-run listed no packages/)
    expect(r.log).toMatch(/^bun x playwright install --with-deps chromium webkit$/m)
  })
})
