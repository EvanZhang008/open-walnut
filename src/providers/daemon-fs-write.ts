/**
 * The session daemon's file writes, run on this host: image.save (the one write the cloud
 * bridge may make), fs.write, fs.mkdir, fs.rename, fs.rm, fs.copy, and vscode.ensure (the
 * host's embedded editor, 'vscode-v1'). The reads are daemon-fs-read.ts.
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts), whose command table
 * takes the returned answers by name; the runtime's start also sweeps its registry's stale temps with
 * sweepStaleWriteTemps. The code is the runtime's as it was; deps carry the runtime's own names.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import type { createCodeServer } from './vscode-server-core.js'
import { ok, fail, type Answer, type Answers, type DaemonEnv, type DaemonLog } from './daemon-module-deps.js'

export interface DaemonFsWriteDeps {
  daemonEnv: DaemonEnv
  HOME_DIR: string
  /** The runtime's dir: pictures a session was sent are saved under it. */
  DAEMON_DIR: string
  /** The home daemon dir ($HOME/.cache/open-walnut). */
  FALLBACK_DAEMON_DIR: string
  /** The shared temp dir (/tmp/open-walnut): the server's scratch dir when it is this user's own. */
  PROD_DAEMON_DIR: string
  /** The runtime's embedded editor. */
  codeServer: ReturnType<typeof createCodeServer>
  /** The image sniff fs.readImage uses (daemon-fs-read.ts). */
  looksLikeImage: (data: Buffer) => boolean
  logMsg: DaemonLog
}

/**
 * The images dir the server of this machine named to its daemon (WALNUT_DAEMON_IMAGES_DIR,
 * local-daemon.ts): its own scratch dir's, which is not the daemon's dir since the daemon's files
 * moved out of /tmp (lib/daemon-dir.ts). Null on a host no server named one to: `<daemon dir>/images`.
 */
export function serverImagesDirOf(env: Record<string, string | undefined>): string | null {
  const dir = env.WALNUT_DAEMON_IMAGES_DIR
  return dir && path.isAbsolute(dir) ? dir.replace(/\/+$/, '') : null
}

/**
 * Where the server of this machine keeps its pictures, as this daemon must name it: the dir the
 * server named; else, for a daemon in the home dir that no server started (a login service's: its
 * unit carries no images dir), the shared temp dir's when that dir is this user's own real dir,
 * which is the server's own rule for its scratch (lib/daemon-dir.ts chooseLocalLogDir); else
 * `<daemon dir>/images`, where both were before the daemon's files left the temp dir.
 */
export function serverImagesDir(io: {
  env: Record<string, string | undefined>
  daemonDir: string
  homeDaemonDir: string
  sharedDir: string
  /** The shared dir is a real directory of this user (looked at when asked: the server may make it after this daemon started). */
  ownsShared: () => boolean
}): string {
  const named = serverImagesDirOf(io.env)
  if (named) return named
  if (path.resolve(io.daemonDir) === path.resolve(io.homeDaemonDir) && io.ownsShared()) return path.join(io.sharedDir, 'images')
  return path.join(io.daemonDir, 'images')
}

export function createDaemonFsWrite<W>(deps: DaemonFsWriteDeps) {
  const { daemonEnv, HOME_DIR, DAEMON_DIR, FALLBACK_DAEMON_DIR, PROD_DAEMON_DIR, codeServer, looksLikeImage, logMsg } = deps

  // Bridge-safe image save: mediaType allowlist + decoded-size cap + magic-byte
  // check, writing ONLY into a fixed daemon-owned directory with a generated
  // filename. The ONLY write command reachable from the cloud bridge (see
  // BRIDGE_ALLOWED_COMMANDS) — phones attach pictures to sessions, but a
  // compromised cloud box must never get arbitrary file writes on exec hosts:
  // no caller-controlled path component ever reaches the filesystem (the
  // extension comes from the mediaType allowlist, never from the caller), and
  // non-image bytes are refused, so this cannot plant scripts/configs/keys.
  const IMAGE_SAVE_MEDIA_TO_EXT: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/heic': 'heic',
  }
  const IMAGE_SAVE_MAX_BYTES = 10 * 1024 * 1024
  // ~4/3 base64 overhead + slack — refuse before decoding an oversized string.
  const IMAGE_SAVE_MAX_BASE64_LENGTH = 14_000_000
  // Beside the server's own pictures (the server reads the staged file back from there:
  // constants.ts MOBILE_STAGED_IMAGES_DIR). Asked at each save: see serverImagesDir.
  const ownsShared = (): boolean => {
    try {
      const st = fs.lstatSync(PROD_DAEMON_DIR)
      return st.isDirectory() && st.uid === os.userInfo().uid
    } catch { return false }
  }
  const imageSaveDir = (): string => path.join(serverImagesDir({ env: daemonEnv, daemonDir: DAEMON_DIR, homeDaemonDir: FALLBACK_DAEMON_DIR, sharedDir: PROD_DAEMON_DIR, ownsShared }), 'mobile')

  // HEIC rides ISO-BMFF: a 'ftyp' box at byte 4. looksLikeImage covers the rest.
  function looksLikeHeic(data: Buffer): boolean {
    return data.length >= 12 && data.slice(4, 8).toString('latin1') === 'ftyp'
  }

  async function cmdImageSave(cmd: Record<string, unknown>): Promise<Answer> {
    const data = cmd.data
    const mediaType = cmd.mediaType
    if (typeof data !== 'string' || data.length === 0) return fail('image.save: missing data')
    if (data.length > IMAGE_SAVE_MAX_BASE64_LENGTH) return fail('image.save: too large (EFBIG)')
    const ext = typeof mediaType === 'string' ? IMAGE_SAVE_MEDIA_TO_EXT[mediaType] : undefined
    if (!ext) return fail('image.save: unsupported mediaType (ENOTIMAGE)')
    const buf = Buffer.from(data, 'base64')
    if (buf.length === 0) return fail('image.save: invalid base64')
    if (buf.length > IMAGE_SAVE_MAX_BYTES) return fail('image.save: too large (EFBIG)')
    const isImage = mediaType === 'image/heic' ? looksLikeHeic(buf) : looksLikeImage(buf)
    if (!isImage) return fail('image.save: not an image (ENOTIMAGE)')
    // Generated filename — timestamp + random; extension from the mediaType
    // allowlist. NEVER from caller input: no path component crosses the bridge.
    const filename = Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext
    const IMAGE_SAVE_DIR = imageSaveDir()
    const filePath = path.join(IMAGE_SAVE_DIR, filename)
    try {
      await fs.promises.mkdir(IMAGE_SAVE_DIR, { recursive: true })
      await fs.promises.writeFile(filePath, buf)
      logMsg('info', 'image.save: saved', { path: filePath, size: buf.length })
      return ok({ path: filePath, size: buf.length })
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException
      const code = e.code ?? ''
      return fail('image.save failed: ' + e.message + (code ? ' (' + code + ')' : ''))
    }
  }

  // A conditional write hashes the whole current file; the caller could only have
  // hashed what it read, and reads stop at this ceiling (DaemonFileReader).
  const FS_WRITE_PRECONDITION_MAX_BYTES = 32 * 1024 * 1024
  // A temp sibling this old was left by a daemon that died between write and
  // rename; the live write that would have renamed it is long gone.
  const FS_WRITE_TEMP_STALE_MS = 60 * 60 * 1000

  /** Remove `.name.walnut-*.tmp` siblings an interrupted atomic write left behind. Best effort. */
  async function sweepStaleWriteTemps(dir: string, prefix: string): Promise<void> {
    let names: string[] = []
    try { names = await fs.promises.readdir(dir) } catch { return }
    const cutoff = Date.now() - FS_WRITE_TEMP_STALE_MS
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue
      const full = path.join(dir, name)
      try {
        const st = await fs.promises.lstat(full)
        if (st.isFile() && st.mtimeMs < cutoff) await fs.promises.unlink(full)
      } catch { /* another writer may have renamed or removed it first */ }
    }
  }

  async function cmdFsWrite(cmd: Record<string, unknown>): Promise<Answer> {
    const { path: filePath, data, encoding } = cmd as { path: string; data: string; encoding?: string }
    // `typeof` not truthiness: EMPTY data is legal (clearing a file to zero bytes
    // is a real save), and `!data` rejected it as "missing".
    if (!filePath || typeof data !== 'string') return fail('fs.write: missing path or data')
    // exclusive = "create a NEW file" (the Files panel's new-file affordance): no
    // mkdir -p (a missing parent is a typo, not an intent) and flag 'wx' so an
    // existing file is an EEXIST rather than a silent clobber. Absent = the
    // editor's save path, unchanged.
    const exclusive = cmd.exclusive === true
    // 'fs-write-atomic-v1' — two opt-in fields for read-modify-write callers that
    // edit a file ANOTHER process also rewrites (the engine-settings route editing
    // ~/.claude/settings.json while a CLI watches and rewrites it). `atomic` makes
    // the replacement a rename, so a watcher never observes a half-written file;
    // `expectSha256` makes the write conditional on the bytes the caller read, so a
    // concurrent edit is refused instead of clobbered. Both absent = today's
    // behaviour, unchanged.
    const atomic = cmd.atomic === true
    const expectSha256 = typeof cmd.expectSha256 === 'string' ? cmd.expectSha256 : null

    // The mutation floor applies to the exclusive (Files-panel "new file") path
    // ONLY. The plain save path predates this command and legitimately writes
    // relative and `~` paths that the floor refuses; adding the floor there would
    // break saving. So the NEW affordance gets the guard, the old one keeps its
    // contract. Without this, creating a file was the one mutation with no
    // host-side check at all, contradicting what fs-mutate-v1 advertises.
    let target = filePath
    if (exclusive) {
      const resolved = await fsMutateResolve(filePath)
      if (!resolved) return fail('fs.write refused: path outside the mutation floor (EDENIED)')
      target = resolved
    } else if (target === '~' || target.startsWith('~/')) {
      // Node fs does no shell expansion — same expansion fs.read/fs.mkdir/fs.stat
      // have always done. Its absence here meant a `~/...` write landed in a
      // literal './~' directory next to the daemon's cwd. The exclusive branch
      // expands inside fsMutateResolve, so it is deliberately not touched.
      target = HOME_DIR + target.slice(1)
    }

    // Set only once a temp file exists, so the failure path knows to remove it.
    let tmpPath: string | null = null
    try {
      const enc = encoding || 'base64'
      const buf = enc === 'base64' ? Buffer.from(data, 'base64') : Buffer.from(data, 'utf-8')

      // rename(2) replaces the NAME, not what it points to: an atomic write onto a
      // symlink (a dotfiles-managed ~/.claude/settings.json) would swap the link
      // for a plain file and quietly detach the user's repo copy. Every other step
      // here follows the link, so the rename has to as well.
      if (atomic && !exclusive) {
        try {
          target = await fs.promises.realpath(target)
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        }
      }

      // Precondition BEFORE anything is created: a refusal must leave the disk
      // exactly as it was, parents included. Regular files only, checked before
      // open, for the same reason as cmdFsRead: opening a FIFO with no writer
      // wedges a fs-pool thread forever. The size gate exists because the caller
      // can only have hashed bytes it was able to read (32MB read ceiling).
      if (expectSha256 !== null) {
        let current = 'absent'
        let st: fs.Stats | null = null
        try {
          st = await fs.promises.stat(target)
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        }
        if (st !== null) {
          if (!st.isFile()) return fail('fs.write refused: not a regular file (ENOTFILE)')
          if (st.size > FS_WRITE_PRECONDITION_MAX_BYTES) {
            return fail('fs.write refused: file too large for a conditional write (EFBIG)')
          }
          current = crypto.createHash('sha256').update(await fs.promises.readFile(target)).digest('hex')
        }
        if (current !== expectSha256) {
          return fail('fs.write refused: file changed since it was read (EMODIFIED)')
        }
      }

      if (!exclusive) await fs.promises.mkdir(path.dirname(target), { recursive: true })
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
      if (exclusive) {
        // 'wx' IS the atomicity the create path wants (and its EEXIST contract);
        // a rename would silently replace the file it exists to protect.
        await fs.promises.writeFile(target, buf, { flag: 'wx' })
      } else if (atomic) {
        // Temp file in the SAME directory: rename(2) is only atomic within one
        // filesystem, and a dotfile sibling keeps it out of the watcher's way.
        // Preserve the old mode — a fresh temp file would silently widen a 0600
        // credential file to the umask default.
        let mode: number | null = null
        try {
          mode = (await fs.promises.stat(target)).mode & 0o777
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        }
        const tmpPrefix = '.' + path.basename(target) + '.walnut-'
        await sweepStaleWriteTemps(path.dirname(target), tmpPrefix)
        tmpPath = path.join(path.dirname(target), tmpPrefix + crypto.randomBytes(4).toString('hex') + '.tmp')
        // fsync before the rename, like the registry writer in daemon-core: a
        // rename that lands before the data does leaves an empty file after a crash.
        const fh = await fs.promises.open(tmpPath, 'w')
        try {
          await fh.writeFile(buf)
          await fh.sync()
        } finally {
          await fh.close()
        }
        if (mode !== null) await fs.promises.chmod(tmpPath, mode)
        await fs.promises.rename(tmpPath, target)
        tmpPath = null
      } else {
        await fs.promises.writeFile(target, buf)
      }
      return ok({ written: true, size: buf.length, sha256 })
    } catch (err: unknown) {
      // Never leave a half-written sibling behind for the next caller to trip on.
      if (tmpPath) { try { await fs.promises.unlink(tmpPath) } catch { /* best effort */ } }
      const e = err as NodeJS.ErrnoException
      const code = e.code ?? ''
      return fail('fs.write failed: ' + e.message + (code ? ' (' + code + ')' : ''))
    }
  }

  async function cmdFsMkdir(cmd: Record<string, unknown>): Promise<Answer> {
    let dirPath = cmd.path as string
    if (!dirPath) return fail('fs.mkdir: missing path')

    // Expand ~ to home directory (Node fs doesn't do shell expansion)
    if (dirPath === '~' || dirPath.startsWith('~/')) {
      dirPath = HOME_DIR + dirPath.slice(1)
    }

    // exclusive = the UI's "new folder": recursive:false makes an existing
    // directory an EEXIST, so the panel can say "that name is taken" instead of
    // silently succeeding. Absent = the idempotent ensure-dir behavior every
    // other caller depends on.
    const exclusive = cmd.exclusive === true
    // Same split as cmdFsWrite: the floor guards the UI's "new folder" only. The
    // idempotent ensure-dir behaviour every other caller depends on keeps working
    // on paths the floor would refuse (a daemon working dir two segments up, say).
    if (exclusive) {
      const resolved = await fsMutateResolve(dirPath)
      if (!resolved) return fail('fs.mkdir refused: path outside the mutation floor (EDENIED)')
      dirPath = resolved
    }
    try {
      // recursive:true tolerates already-existing directories (idempotent)
      await fs.promises.mkdir(dirPath, { recursive: !exclusive })
      return ok({ created: true, resolvedPath: dirPath })
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException
      const code = e.code ?? ''
      return fail('fs.mkdir failed: ' + e.message + (code ? ' (' + code + ')' : ''))
    }
  }

  /**
   * Input floor EVERY mutating fs command runs before touching the disk
   * ('fs-mutate-v1': fs.rename / fs.rm / fs.copy, plus fs.write and fs.mkdir when
   * called with `exclusive` — see the note in cmdFsWrite for why only then).
   * Callers go through fsMutateResolve, which adds the denylist and the symlink
   * resolution; this function holds the string rules alone so it stays pure.
   *
   * The server validates too, but the daemon is the thing holding the file
   * descriptors and it must not depend on a caller having been careful: one
   * mis-serialized `undefined` reaching `rm -r /` is unrecoverable. Returns the
   * `~`-expanded path, or null when the request must be refused (EDENIED).
   *
   * The rules, each guarding a specific way to lose data:
   *  - absolute only (a relative path resolves against the daemon's cwd, which is
   *    not a place the caller can reason about),
   *  - no '.'/'..' SEGMENT — checked segment-wise, never by substring, so an
   *    ordinary name like '..bar' or 'mod..old' stays usable,
   *  - never '/' and never HOME_DIR itself,
   *  - at least 2 non-empty segments, so '/tmp' and '/usr' are refused and only
   *    something at '/a/b' depth or deeper can be touched.
   *and the server-side copy in
   * src/web/routes/file-ops.ts.
   */
  function fsMutateFloor(raw: unknown): string | null {
    if (typeof raw !== 'string' || raw.length === 0) return null
    let p = raw
    if (p === '~' || p.startsWith('~/')) p = HOME_DIR + p.slice(1)
    if (!path.isAbsolute(p)) return null
    // Trailing slashes are cosmetic — strip them BEFORE the comparisons, or
    // '/Users/me/' walks straight past the HOME_DIR check.
    while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
    const segments = p.split('/')
    for (const seg of segments) if (seg === '.' || seg === '..') return null
    if (segments.filter((s) => s.length > 0).length < 2) return null
    let home = HOME_DIR
    while (home.length > 1 && home.endsWith('/')) home = home.slice(0, -1)
    if (p === '/' || p === home) return null
    return p
  }

  /**
   * Host-side denylist for mutations. The server has one too, but the server's is
   * built from the SERVER's `os.homedir()` — so on a remote host it compares a
   * Linux path against a Mac home directory and matches nothing. That left this
   * host's `~/.ssh` deletable through a trusted request, while the READ path
   * (cmdFsReadBounded) has always refused it host-side. This closes that asymmetry.
   *
   * Segment-wise, never substring: `.ssh` as a path SEGMENT is the credential
   * store, whereas a file merely named `my.ssh.notes` is not.
   *
   *isProtectedStatePath/isSecretPath in
   * src/web/routes/file-ops.ts.
   */
  function fsMutateDenied(p: string): boolean {
    const segments = p.split('/').filter((s) => s.length > 0)
    const base = segments.length > 0 ? segments[segments.length - 1] : ''
    // Credential stores, wherever on this host they live. Nothing in a file
    // manager needs to rename or delete these, and losing them locks the user (and
    // Walnut's own ControlMaster access) out of the host.
    for (const seg of segments) {
      if (seg === '.ssh' || seg === '.aws' || seg === '.gnupg' || seg === '.kube' || seg === 'secrets' || seg === 'secrets-master') return true
    }
    if (base === 'auth.json' || base === 'bridge-tokens.json') return true
    // Walnut's own irreplaceable state on this host. The stream JSONLs ARE the
    // conversation history: there is no second copy to restore from.
    // Both the legacy /tmp roots and the CURRENT home: streams moved to
    // ~/.open-walnut/tmp/streams in 2026-08 (PROD_STREAMS_DIR), and every
    // override the daemon honours is covered too, so a relocated install is
    // protected on the same terms as the default one.
    const runtimeRoots = [
      '/tmp/open-walnut', '/tmp/open-walnut-streams',
      path.join(HOME_DIR, '.open-walnut', 'tmp'),
      // The daemon dir a connect uses when /tmp is unusable, protected whichever
      // dir THIS daemon runs from (a /tmp daemon must not delete a live one there).
      FALLBACK_DAEMON_DIR,
      daemonEnv.WALNUT_DAEMON_DIR, daemonEnv.WALNUT_STREAMS_DIR, daemonEnv.WALNUT_LEGACY_STREAMS_DIR,
    ].filter((r) => typeof r === 'string' && r.length > 0)
    for (const root of runtimeRoots) {
      if (p === root || p.indexOf(root + '/') === 0) return true
    }
    return false
  }

  /**
   * The floor plus the denylist, applied to the path the KERNEL will reach.
   *
   * fsMutateFloor alone reads the path as a string, but the kernel walks it as a
   * chain of directories, so any symlinked ancestor launders a target past every
   * rule: `/tmp/link/.ssh` is 3 segments deep, holds no `..`, is not `/` and is not
   * HOME_DIR, yet with `link` pointing at the home directory a recursive delete
   * destroys the real `~/.ssh`. cmdFsReadBounded already resolves before checking;
   * the destructive commands now do the same.
   *
   * Returns the ORIGINAL path, not the resolved one: a symlink must be renamed or
   * deleted as the LINK and never followed to its target (see the lstat notes in
   * cmdFsRename/cmdFsRm).
   */
  async function fsMutateResolve(raw: unknown): Promise<string | null> {
    const p = fsMutateFloor(raw)
    if (!p) return null
    if (fsMutateDenied(p)) return null
    let real: string
    try {
      real = path.join(await fs.promises.realpath(path.dirname(p)), path.basename(p))
    } catch {
      // Parent missing or unreadable: there is no symlink chain to launder through,
      // and the real fs call is about to produce an accurate ENOENT/EACCES. Do not
      // convert that into a misleading EDENIED.
      return p
    }
    if (real === p) return p
    if (!fsMutateFloor(real) || fsMutateDenied(real)) return null
    return p
  }

  async function cmdFsRename(cmd: Record<string, unknown>): Promise<Answer> {
    const from = await fsMutateResolve(cmd.from)
    const to = await fsMutateResolve(cmd.to)
    if (!from || !to) return fail('fs.rename refused: path outside the mutation floor (EDENIED)')

    try {
      // POSIX rename REPLACES an existing target without a word, so a rename in
      // the Files panel could silently delete another file. lstat first (not stat:
      // a symlink target must count as "taken", and the link itself is what moves).
      let targetExists = true
      try { await fs.promises.lstat(to) } catch { targetExists = false }
      if (targetExists) {
        return fail('fs.rename failed: target already exists (EEXIST)')
      }
      await fs.promises.rename(from, to)
      return ok({ renamed: true })
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException
      const code = e.code ?? ''
      return fail('fs.rename failed: ' + e.message + (code ? ' (' + code + ')' : ''))
    }
  }

  async function cmdFsRm(cmd: Record<string, unknown>): Promise<Answer> {
    const target = await fsMutateResolve(cmd.path)
    if (!target) return fail('fs.rm refused: path outside the mutation floor (EDENIED)')
    const recursive = cmd.recursive === true

    try {
      // The directory guard is OURS, not node's: node and bun disagree on the code
      // for rm-a-directory-without-recursive (ERR_FS_EISDIR vs EISDIR vs EPERM),
      // and the server maps on the code. lstat, so a symlink TO a directory is
      // removed as the link and never followed.
      const st = await fs.promises.lstat(target)
      if (st.isDirectory() && !recursive) {
        return fail('fs.rm failed: target is a directory (EISDIR)')
      }
      await fs.promises.rm(target, { recursive, force: false })
      return ok({ removed: true })
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException
      const code = e.code ?? ''
      return fail('fs.rm failed: ' + e.message + (code ? ' (' + code + ')' : ''))
    }
  }

  async function cmdFsCopy(cmd: Record<string, unknown>): Promise<Answer> {
    const from = await fsMutateResolve(cmd.from)
    const to = await fsMutateResolve(cmd.to)
    if (!from || !to) return fail('fs.copy refused: path outside the mutation floor (EDENIED)')

    try {
      // Same never-clobber rule as rename, and the same lstat reason. errorOnExist
      // alone is not enough: it only fires per-entry inside a recursive copy.
      let targetExists = true
      try { await fs.promises.lstat(to) } catch { targetExists = false }
      if (targetExists) {
        return fail('fs.copy failed: target already exists (EEXIST)')
      }
      try {
        await fs.promises.cp(from, to, { recursive: true, errorOnExist: true, force: false })
      } catch (cpErr) {
        // A copy that dies mid-tree (ENOSPC, EACCES on one entry) leaves a partial
        // destination behind, and the never-clobber check above then answers EEXIST
        // to every retry forever. `to` was verified absent moments ago, so whatever
        // is there now is ours to remove. Best effort: the original error is what
        // the caller needs to see.
        await fs.promises.rm(to, { recursive: true, force: true }).catch(() => {})
        throw cpErr
      }
      return ok({ copied: true })
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException
      const code = e.code ?? ''
      return fail('fs.copy failed: ' + e.message + (code ? ' (' + code + ')' : ''))
    }
  }

  /**
   * Embedded VS Code (capability 'vscode-v1'): ensure a host-local code-server
   * is installed + running, and resolve what the caller should open for a cwd.
   * The editor's traffic stays on this host; only {port, token, open} returns.
   */
  async function cmdVscodeEnsure(cmd: Record<string, unknown>): Promise<Answer> {
    try {
      const result = await codeServer.ensureCodeServer({ noInstall: cmd.noInstall === true })
      let open: { kind: string; path: string } | undefined
      if (typeof cmd.cwd === 'string' && cmd.cwd) {
        open = await codeServer.resolveOpenTarget(cmd.cwd)
      }
      if (!result.ok) {
        logMsg('warn', 'vscode.ensure failed', { error: result.error, installed: result.installed })
      }
      return ok({ ...result, open } as unknown as Record<string, unknown>)
    } catch (err: unknown) {
      return fail('vscode.ensure failed: ' + (err as Error).message)
    }
  }

  const answers: Answers<W> = {
    'image.save': cmdImageSave, 'fs.write': cmdFsWrite, 'fs.mkdir': cmdFsMkdir,
    'fs.rename': cmdFsRename, 'fs.rm': cmdFsRm, 'fs.copy': cmdFsCopy, 'vscode.ensure': cmdVscodeEnsure,
  }
  return { answers, sweepStaleWriteTemps }
}
