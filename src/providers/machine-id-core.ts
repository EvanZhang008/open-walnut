/**
 * This machine's stable id: 32 lowercase hex, random, made once per OS account and never
 * rewritten, kept in `<home>/.local/state/open-walnut/machine-id`. Never XDG_STATE_HOME (the
 * same rule as net-config-core.ts netStateDirOf): a shell may set it and the login service not,
 * and two paths would be two ids for one machine.
 *
 * It lives outside every Walnut data dir, so a new or moved data dir, a reinstall that keeps the
 * account's home, a new port and a renamed hosts alias all keep it, and a copy of the data dir on
 * another machine does not carry it. The server reads it through src/core/machine-id.ts; the
 * daemon twins send it in their hello (daemon-standalone.ts imports this file, daemon-source.ts
 * inlines `machineIdOf` as `__MACHINE_ID_OF__`, so its body references nothing at module scope).
 */

/** A machine id's form, the one every reader checks an id with (machineIdOf keeps its own copy: its body is inlined). */
export const MACHINE_ID_RE = /^[0-9a-f]{32}$/

/** `value` is a machine id (32 lowercase hex). */
export function isMachineId(value: unknown): value is string {
  return typeof value === 'string' && MACHINE_ID_RE.test(value)
}

/** What machineIdOf touches, handed in (the source twin has no imports of its own here). */
export interface MachineIdIo {
  /** The account's home dir. */
  home: string
  /**
   * The Walnut data dir this process serves, when it knows one (the server's WALNUT_HOME, a
   * daemon's OPEN_WALNUT_HOME). An older build kept an id in a data dir's `local/machine-id`; the
   * first valid one seeds a missing file: this data dir's, then the default one's
   * (`<home>/.open-walnut`). The same rule for the server and both twins, so whichever makes the
   * file first seeds it alike.
   */
  dataHome: string | null
  fs: {
    readFileSync(p: string, enc: 'utf8'): string
    mkdirSync(p: string, opts: { recursive: true; mode: number }): unknown
    writeFileSync(p: string, data: string, opts: { mode: number; flag?: string }): void
    linkSync(from: string, to: string): void
    renameSync(from: string, to: string): void
    rmSync(p: string, opts: { force: true }): void
  }
  join: (...parts: string[]) => string
  /** 32 random lowercase hex digits. */
  randomHex: () => string
  log: (level: 'info' | 'warn', message: string, data: Record<string, unknown>) => void
}

/**
 * The id: read, or made once (seeded, else random) and put in place exclusively, so two processes
 * that start together agree on one: a hard link of a whole temp file, or where the file system has
 * none an exclusive create, whose short empty moment a reader waits out. A file that holds no valid
 * id is replaced only while it still holds none. Throws when the id can be neither read nor made.
 */
export function machineIdOf(io: MachineIdIo): string {
  const ID = /^[0-9a-f]{32}$/ // MACHINE_ID_RE, inlined
  const dir = io.join(io.home, '.local', 'state', 'open-walnut')
  const file = io.join(io.home, '.local', 'state', 'open-walnut', 'machine-id')
  const raw = (p: string): string | null => { try { return String(io.fs.readFileSync(p, 'utf8')).trim() } catch { return null } }
  const valid = (p: string): string | null => { const t = raw(p); return t !== null && ID.test(t) ? t : null }
  const kept = valid(file)
  if (kept) return kept
  const corrupt = raw(file) !== null
  let seededFrom: string | null = null
  let fresh: string | null = null
  const seeds = [io.join(io.home, '.open-walnut', 'local', 'machine-id')]
  if (io.dataHome) seeds.unshift(io.join(io.dataHome, 'local', 'machine-id'))
  for (const seed of seeds) {
    fresh = valid(seed)
    if (fresh) { seededFrom = seed; break }
  }
  if (!fresh) fresh = io.randomHex()
  if (!ID.test(fresh)) throw new Error('machine id: the random id is not 32 lowercase hex')
  io.fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${io.randomHex().slice(0, 12)}`
  io.fs.writeFileSync(tmp, `${fresh}\n`, { mode: 0o600 })
  const codeOf = (error: unknown): string | undefined => (error as { code?: string } | null)?.code
  // A file another process is making is whole within moments (an exclusive create opens it
  // empty, then writes): read it a few times before judging it broken.
  const settled = (): string | null => {
    for (let i = 0; i < 10; i++) {
      const theirs = valid(file)
      if (theirs) return theirs
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
    return null
  }
  try {
    try {
      // A link never replaces a file another process just put there (a rename would).
      io.fs.linkSync(tmp, file)
      io.log('info', 'machine id made', { file, seededFrom })
      return fresh
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') {
        // No hard links on this file system (FUSE, exFAT): an exclusive create, which also never
        // replaces a file another process made, so two processes never keep two ids.
        try {
          io.fs.writeFileSync(file, `${fresh}\n`, { mode: 0o600, flag: 'wx' })
          io.log('info', 'machine id made', { file, seededFrom })
          return fresh
        } catch (created) {
          if (codeOf(created) !== 'EEXIST') throw created
        }
      }
      const theirs = settled()
      if (theirs) return theirs
      // Still no valid id there: the broken file is replaced whole.
      io.fs.renameSync(tmp, file)
      io.log('warn', 'machine id file held no valid id; replaced', { file, seededFrom, wasCorrupt: corrupt })
      return valid(file) ?? fresh
    }
  } finally {
    try { io.fs.rmSync(tmp, { force: true }) } catch { /* gone already */ }
  }
}
