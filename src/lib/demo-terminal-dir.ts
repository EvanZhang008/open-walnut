// Keep sockets below macOS's 103-byte limit without moving persistent data.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

/** /tmp, not os.tmpdir(): /var/folders/…/T/ alone is 49 bytes on macOS. */
export const DEMO_TERMINAL_BASE = '/tmp'

/** Same name as DTACH_OWNER_MARKER in web/terminal/spawn.ts (not imported: constants.ts reads this file). */
const OWNER_MARKER = '.owner'

const GENERATION_RE = /^[a-zA-Z0-9-]{1,64}$/
const DIR_RE = /^walnut-demo-(?:\d+|user)-[0-9a-f]{16}$/

function ownUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null
}

/** The terminal socket dir of one Demo generation; the root's own rules are assertDemoPaths's. */
export function demoTerminalDir(root: string, generation: string): string {
  if (!path.isAbsolute(root)) throw new Error('Demo terminals need an absolute Demo root')
  if (!GENERATION_RE.test(generation)) throw new Error('Invalid Demo generation')
  const hash = createHash('sha256').update(`${path.resolve(root)}\0${generation}`).digest('hex').slice(0, 16)
  return path.posix.join(DEMO_TERMINAL_BASE, `walnut-demo-${ownUid() ?? 'user'}-${hash}`)
}

/** The Demo terminal dir a complete, valid Demo identity in the env names, else null. */
export function demoTerminalDirFromEnv(env: NodeJS.ProcessEnv): string | null {
  const root = env.WALNUT_DEMO_ROOT
  const generation = env.WALNUT_DEMO_GENERATION
  if (!root || !generation || !path.isAbsolute(root) || path.basename(root) !== 'open-walnut-demo') return null
  try { return demoTerminalDir(root, generation) } catch { return null }
}

function assertShape(dir: string): void {
  if (path.posix.dirname(dir) !== DEMO_TERMINAL_BASE || !DIR_RE.test(path.posix.basename(dir))) {
    throw new Error(`Not a Demo terminal directory: ${dir}`)
  }
}

function assertOwnDir(stat: fs.Stats, dir: string): void {
  const uid = ownUid()
  if (stat.isSymbolicLink() || !stat.isDirectory() || (uid !== null && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
    throw new Error(`Demo terminal directory is not a private directory of this account: ${dir}`)
  }
}

/** The marker's text, or null when there is none; a symlink or another account's file throws. */
function readMarker(dir: string): string | null {
  const marker = path.join(dir, OWNER_MARKER)
  let fd: number
  try {
    fd = fs.openSync(marker, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const stat = fs.fstatSync(fd)
    const uid = ownUid()
    if (!stat.isFile() || (uid !== null && stat.uid !== uid)) throw new Error(`Demo terminal owner marker is not this account's: ${marker}`)
    return fs.readFileSync(fd, 'utf8').trim()
  } finally {
    fs.closeSync(fd)
  }
}

function assertClaimedBy(dir: string, owner: string): void {
  const claimed = readMarker(dir)
  if (claimed !== owner) throw new Error(`Demo terminal directory belongs to another Walnut (${claimed ?? 'unclaimed'}): ${dir}`)
}

/** Make or reuse the dir, claimed for `owner` (the generation's data dir); anything else throws, opening nothing. */
export function ensureDemoTerminalDir(dir: string, owner: string): void {
  assertShape(dir)
  try {
    fs.mkdirSync(dir, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const stat = fs.lstatSync(dir)
  assertOwnDir(stat, dir)
  if ((stat.mode & 0o777) !== 0o700) throw new Error(`Demo terminal directory needs mode 0700: ${dir}`)
  try {
    fs.writeFileSync(path.join(dir, OWNER_MARKER), `${owner}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  assertClaimedBy(dir, owner)
}

/** False when the dir is absent; true when it is this account's private dir claimed for `owner`; else throws. Creates and removes nothing. */
export async function checkDemoTerminalDir(dir: string, owner: string): Promise<boolean> {
  assertShape(dir)
  let stat: fs.Stats
  try {
    stat = await fs.promises.lstat(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  assertOwnDir(stat, dir)
  assertClaimedBy(dir, owner)
  return true
}

/** Remove the dir of a generation whose terminals were confirmed ended: only when claimed for `owner`, or unclaimed and empty. */
export async function removeDemoTerminalDir(dir: string, owner: string): Promise<void> {
  assertShape(dir)
  let stat: fs.Stats
  try {
    stat = await fs.promises.lstat(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  assertOwnDir(stat, dir)
  const claimed = readMarker(dir)
  if (claimed === null) {
    if ((await fs.promises.readdir(dir)).length > 0) throw new Error(`Demo terminal directory has no owner marker; it was kept: ${dir}`)
    await fs.promises.rmdir(dir)
    return
  }
  if (claimed !== owner) throw new Error(`Demo terminal directory belongs to another Walnut (${claimed}); it was kept: ${dir}`)
  await fs.promises.rm(dir, { recursive: true, force: true })
}
