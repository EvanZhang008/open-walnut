#!/usr/bin/env node
/**
 * Build the SQLite Walnut opens on macOS when it runs on bun (src/lib/sqlite.ts).
 *
 * bun:sqlite loads the system SQLite on macOS, an Apple build that behaves unlike
 * the one Walnut was written against (better-sqlite3, its Node binding until
 * Walnut moved to bun, compiled its own): every query on a database whose file was
 * deleted or replaced while open fails (SQLITE_IOERR_VNODE), -wal and -shm stay
 * after the last close, and a WAL database with no -wal will not open read-only.
 * This compiles the pinned upstream amalgamation with that build's options
 * (better-sqlite3's deps/defines.gypi, copied into DEFINES below) into a
 * universal dylib.
 *
 *   bun scripts/build-sqlite-dylib.mjs [--force]
 *
 * Output (gitignored): vendor/sqlite/darwin/libsqlite3.dylib, its stamp.json, and
 * the verified source under vendor/sqlite/src/. A stamp that matches the pins
 * below skips the build, so postinstall runs it on every install. Needs network
 * once (sqlite.org) and clang (Xcode Command Line Tools). macOS only.
 */
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SQLITE_VERSION = '3.53.4'
export const AMALGAMATION_URL = 'https://www.sqlite.org/2026/sqlite-amalgamation-3530400.zip'
/** "SHA3-256 for sqlite3.c" on https://www.sqlite.org/releaselog/3_53_4.html */
export const SQLITE3_C_SHA3_256 = '67f423e9ebbbdc473cbc4772c872ee6b89f31fde4ed0279a5c25d5f65c043a16'

/**
 * better-sqlite3's defines, minus three it has that remove API functions
 * (OMIT_DEPRECATED, OMIT_PROGRESS_CALLBACK, OMIT_SHARED_CACHE: bun:sqlite looks
 * up the functions it calls in the library it loads) and two that are built in
 * now (ENABLE_DESERIALIZE, ENABLE_JSON1).
 */
export const DEFINES = [
  'HAVE_INT16_T=1', 'HAVE_INT32_T=1', 'HAVE_INT8_T=1', 'HAVE_STDINT_H=1',
  'HAVE_UINT16_T=1', 'HAVE_UINT32_T=1', 'HAVE_UINT8_T=1', 'HAVE_USLEEP=1',
  'SQLITE_DEFAULT_CACHE_SIZE=-16000',
  'SQLITE_DEFAULT_FOREIGN_KEYS=1',
  'SQLITE_DEFAULT_MEMSTATUS=0',
  'SQLITE_DEFAULT_WAL_SYNCHRONOUS=1',
  'SQLITE_DQS=0',
  'SQLITE_ENABLE_COLUMN_METADATA',
  'SQLITE_ENABLE_DBSTAT_VTAB',
  'SQLITE_ENABLE_FTS3',
  'SQLITE_ENABLE_FTS3_PARENTHESIS',
  'SQLITE_ENABLE_FTS4',
  'SQLITE_ENABLE_FTS5',
  'SQLITE_ENABLE_GEOPOLY',
  'SQLITE_ENABLE_MATH_FUNCTIONS',
  'SQLITE_ENABLE_RTREE',
  'SQLITE_ENABLE_STAT4',
  'SQLITE_ENABLE_UPDATE_DELETE_LIMIT',
  'SQLITE_LIKE_DOESNT_MATCH_BLOBS',
  'SQLITE_OMIT_TCL_VARIABLE',
  'SQLITE_SOUNDEX',
  'SQLITE_THREADSAFE=2',
  'SQLITE_TRACE_SIZE_LIMIT=32',
  'SQLITE_USE_URI=0',
]

export const ARCHS = ['arm64', 'x86_64']
/** The oldest macOS bun supports. */
export const MACOS_MIN = '13.0'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** Keep in sync with BUILT_SQLITE in src/lib/sqlite.ts. */
export const DYLIB = path.join(ROOT, 'vendor', 'sqlite', 'darwin', 'libsqlite3.dylib')
export const STAMP = path.join(path.dirname(DYLIB), 'stamp.json')
const SOURCE = path.join(ROOT, 'vendor', 'sqlite', 'src', `sqlite3-${SQLITE_VERSION}.c`)

/** What a build is made of: a stamp that differs means a rebuild. */
export function wantedStamp() {
  return { version: SQLITE_VERSION, sqlite3cSha3: SQLITE3_C_SHA3_256, defines: DEFINES, archs: ARCHS, macosMin: MACOS_MIN }
}

export function stampIsCurrent() {
  try {
    return fs.existsSync(DYLIB) && JSON.stringify(JSON.parse(fs.readFileSync(STAMP, 'utf8'))) === JSON.stringify(wantedStamp())
  } catch {
    return false
  }
}

const sha3 = (buf) => crypto.createHash('sha3-256').update(buf).digest('hex')

async function verifiedSource() {
  if (fs.existsSync(SOURCE) && sha3(fs.readFileSync(SOURCE)) === SQLITE3_C_SHA3_256) return SOURCE
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-sqlite-src-'))
  try {
    const res = await fetch(AMALGAMATION_URL, { signal: AbortSignal.timeout(120_000) })
    if (!res.ok) throw new Error(`download failed: ${res.status} ${AMALGAMATION_URL}`)
    const zip = path.join(tmp, 'amalgamation.zip')
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()))
    const entry = `${path.basename(AMALGAMATION_URL, '.zip')}/sqlite3.c`
    const unzip = spawnSync('unzip', ['-p', zip, entry], { maxBuffer: 64 * 1024 * 1024 })
    if (unzip.status !== 0) throw new Error(`unzip failed: ${unzip.stderr?.toString().trim()}`)
    const got = sha3(unzip.stdout)
    if (got !== SQLITE3_C_SHA3_256) throw new Error(`sqlite3.c SHA3-256 is ${got}, expected ${SQLITE3_C_SHA3_256}`)
    fs.mkdirSync(path.dirname(SOURCE), { recursive: true })
    fs.writeFileSync(SOURCE, unzip.stdout)
    return SOURCE
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

export async function build({ force = false } = {}) {
  if (!force && stampIsCurrent()) return { built: false, dylib: DYLIB }
  const source = await verifiedSource()
  fs.mkdirSync(path.dirname(DYLIB), { recursive: true })
  const temp = `${DYLIB}.${process.pid}.tmp`
  const args = [
    '-dynamiclib', '-O2', '-fPIC', ...ARCHS.flatMap((a) => ['-arch', a]),
    `-mmacosx-version-min=${MACOS_MIN}`, '-install_name', '@rpath/libsqlite3.dylib',
    ...DEFINES.map((d) => `-D${d}`), '-o', temp, source,
  ]
  const cc = spawnSync('clang', args, { stdio: ['ignore', 'inherit', 'inherit'] })
  if (cc.error || cc.status !== 0) {
    fs.rmSync(temp, { force: true })
    throw new Error(`clang failed (${cc.error?.message ?? `exit ${cc.status}`}); install the Xcode Command Line Tools: xcode-select --install`)
  }
  fs.renameSync(temp, DYLIB)
  fs.writeFileSync(STAMP, `${JSON.stringify(wantedStamp(), null, 2)}\n`)
  return { built: true, dylib: DYLIB }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'darwin') {
    console.log('build-sqlite-dylib: nothing to build here (only macOS bun needs it)')
    process.exit(0)
  }
  try {
    const { built, dylib } = await build({ force: process.argv.includes('--force') })
    console.log(`build-sqlite-dylib: SQLite ${SQLITE_VERSION} ${built ? 'built' : 'up to date'}: ${path.relative(ROOT, dylib)}`)
  } catch (err) {
    console.error(`build-sqlite-dylib: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
