/**
 * skills.sync: the session daemon puts Walnut's skills where this host's engines find them
 * (one real copy per skill, a link in each engine's skill folder), and keeps what it last
 * wrote by hash so a restarted server's probe crosses the link without the skills.
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts). Its body is the
 * runtime's code as it was: deps carry the runtime's own names, never read from the process.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DaemonEnv, DaemonLog, DaemonReplies } from './daemon-module-deps.js'
import { daemonServiceConfigFiles } from './daemon-service-config.js'

export interface DaemonSkillsDeps<W> extends DaemonReplies<W> {
  daemonEnv: DaemonEnv
  HOME_DIR: string
  /** The runtime keeps sessions (the production daemon dir, or a service set's runtime): only then are skills written. */
  KEEPS_SESSIONS: boolean
  /** The service set this runtime is, '' for the default one. */
  SET_ID: string
  /** Where held-pushes.json lives. */
  OFFLINE_HOST_DIR: string
  logMsg: DaemonLog
}

export function createDaemonSkills<W>(deps: DaemonSkillsDeps<W>) {
  const { daemonEnv, HOME_DIR, KEEPS_SESSIONS, SET_ID, OFFLINE_HOST_DIR, logMsg, sendOk, sendError } = deps

  // ── skills.sync: distribute walnut's skills to this host's engine stores ──
  // The hub pushes the current content on every (re)connect (hash-skipped
  // hub-side), as `skills: [{name, skill}]` — one entry per skill the engines
  // must discover natively (`walnut`, `walnut-trigger`, …). A bare `skill`
  // string is the older hub's shape and means the `walnut` skill alone.
  // ONE real copy per skill lives in the daemon's own namespace
  // (~/.open-walnut/distributed-skills/<name>/SKILL.md — deliberately NOT the
  // user's skill store ~/.open-walnut/skills/, where a flat SKILL.md shadows
  // category sub-skills); the engines' native skill folders (~/.claude/skills,
  // ~/.agents/skills — codex's documented user-level dir; both engines follow
  // symlinked skill folders) each get a <name> symlink at it. Guards, same
  // spirit as the user-PATH shims: production daemon only, and never clobber a
  // path we do not own (the marker string is the ownership proof). Each engine
  // dir is linked only when that engine's home exists: ~/.agents for codex or
  // goose, ~/.gemini/skills for gemini. Also migrates earlier layouts: the v1
  // real file in ~/.claude/skills, the v1 fenced ~/.codex/AGENTS.md section,
  // and the short-lived v2.0 canonical inside ~/.open-walnut/skills/ (all three
  // only ever held `walnut`, so they run once, not per entry).
  const SKILL_SYNC_MARKER = 'walnut-managed v1'

  /**
   * The skills this process last wrote, by the hash the server named (push-probe-v1): a server
   * that restarted asks `{probe: true, hash}` and sends the skills (about 360 KB) only when they
   * are not held, or a canonical copy is gone from disk. A new process holds none.
   */
  let heldSkills: { hash: string; entries: Array<{ name: string; body: string }> } | null = null

  /**
   * The skills held outlive this process: a daemon update or restart otherwise held nothing, and
   * the server sent the skills (about 360 KB) and both templates again on the session link, which
   * the relay on the SSH path ended (2026-11-13). Kept by the sha256 of each copy, so a copy
   * changed on disk since is not held.
   */
  const HELD_PUSHES_FILE = path.join(OFFLINE_HOST_DIR, 'held-pushes.json')
  let heldPushesLoaded = false
  const skillCopyPath = (name: string) => path.join(HOME_DIR, '.open-walnut', 'distributed-skills', name, 'SKILL.md')
  const sha256Of = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')

  function loadHeldPushes(): void {
    if (heldPushesLoaded) return
    heldPushesLoaded = true
    let raw: { v?: unknown; skills?: { hash?: unknown; entries?: unknown } }
    try { raw = JSON.parse(fs.readFileSync(HELD_PUSHES_FILE, 'utf-8')) } catch { return }
    if (!raw || raw.v !== 1) return
    const skills = raw.skills
    if (heldSkills === null && skills && typeof skills.hash === 'string' && Array.isArray(skills.entries)) {
      const entries: Array<{ name: string; body: string }> = []
      for (const e of skills.entries as Array<{ name?: unknown; sha?: unknown }>) {
        if (typeof e?.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(e.name) || typeof e.sha !== 'string') return
        let body: string
        try { body = fs.readFileSync(skillCopyPath(e.name), 'utf-8') } catch { return }
        if (sha256Of(body) !== e.sha) return
        entries.push({ name: e.name, body })
      }
      heldSkills = { hash: skills.hash, entries }
    }
  }

  function persistHeldPushes(): void {
    // Its own temp name: an updated daemon and the one it replaces may both write for a moment.
    const tmp = HELD_PUSHES_FILE + '.' + process.pid + '.' + Date.now() + '.tmp'
    try {
      const body = {
        v: 1,
        ...(heldSkills ? { skills: { hash: heldSkills.hash, entries: heldSkills.entries.map((e) => ({ name: e.name, sha: sha256Of(e.body) })) } } : {}),
      }
      fs.mkdirSync(OFFLINE_HOST_DIR, { recursive: true, mode: 0o700 })
      fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 })
      fs.renameSync(tmp, HELD_PUSHES_FILE)
    } catch (err) {
      logMsg('warn', 'held pushes: could not keep them; the next server sends them again', { error: (err as Error).message })
      try { fs.unlinkSync(tmp) } catch {}
    }
  }

  /** The account has the default set's service: any of its config files is there (another user's system unit too). */
  function defaultServiceInstalled(): boolean {
    return daemonServiceConfigFiles(process.platform, daemonEnv.HOME || HOME_DIR).some((file) => fs.existsSync(file))
  }

  function cmdSkillsSync(ws: W, id: number, cmd: Record<string, unknown>) {
    // A service set's daemon writes none of the account's engine skill places, as it writes no user
    // PATH shim: they are one per OS account, and on a shared machine the default service is another
    // person's Walnut (2026-11-24). Answered, never refused; a probe reads held, so the skills never
    // cross again. With no default service on the account (its config files gone), the set is the
    // only Walnut there and writes them.
    if (SET_ID && defaultServiceInstalled()) {
      const kept = { skipped: 'default-service', why: "kept by the default service: the account's engine skill places (distributed-skills and the engines' skill links) are written only by the default set" }
      return sendOk(ws, id, cmd.probe === true ? { held: true, ...kept } : { applied: true, changed: false, ...kept })
    }
    const entries: Array<{ name: string; body: string }> = []
    // Held: every canonical copy on disk is still what was sent. The engine links are then put
    // right from those copies as a push would (an engine installed since, a link removed), and
    // nothing more crosses the link.
    let probeHeld = false
    loadHeldPushes()
    if (cmd.probe === true) {
      const hash = typeof cmd.hash === 'string' ? cmd.hash : ''
      const held = !!hash && heldSkills !== null && heldSkills.hash === hash && heldSkills.entries.every((e) => {
        try { return fs.readFileSync(path.join(HOME_DIR, '.open-walnut', 'distributed-skills', e.name, 'SKILL.md'), 'utf-8') === e.body } catch { return false }
      })
      if (!held) return sendOk(ws, id, { held: false })
      probeHeld = true
      entries.push(...heldSkills!.entries)
    }
    // A name becomes a directory and a symlink under the user's HOME, so it is
    // validated before any path is built from it.
    const namePattern = /^[a-z0-9][a-z0-9-]{0,63}$/
    const requested = probeHeld ? [] : Array.isArray(cmd.skills)
      ? (cmd.skills as unknown[])
      : [{ name: 'walnut', skill: cmd.skill }]
    for (const raw of requested) {
      const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      const name = typeof item.name === 'string' ? item.name : ''
      const body = typeof item.skill === 'string' ? item.skill : ''
      if (!namePattern.test(name)) {
        return sendError(ws, id, 'skills.sync: invalid skill name: ' + name)
      }
      if (!body.includes(SKILL_SYNC_MARKER)) {
        return sendError(ws, id, 'skills.sync: payload missing the managed marker')
      }
      entries.push({ name, body })
    }
    if (!KEEPS_SESSIONS) {
      return sendOk(ws, id, { applied: true, changed: false, skipped: 'non-prod' })
    }
    const wrote: string[] = []
    let canonicalFailed = false

    // One skill's real copy plus its per-engine links. Every guard reads the
    // entry's own name, so two skills in one payload never touch each other.
    function syncSkill(name: string, skill: string) {
    const canonicalDir = path.join(HOME_DIR, '.open-walnut', 'distributed-skills', name)
    // 1. the one real copy (marker-guarded: never clobber a foreign file)
    try {
      const target = path.join(canonicalDir, 'SKILL.md')
      let existing: string | null = null
      try { existing = fs.readFileSync(target, 'utf-8') } catch {}
      if (existing === null || existing.includes(SKILL_SYNC_MARKER)) {
        if (existing !== skill) {
          fs.mkdirSync(canonicalDir, { recursive: true })
          fs.writeFileSync(target, skill, { mode: 0o644 })
          wrote.push(target)
        }
      }
    } catch (err) {
      canonicalFailed = true
      logMsg('warn', 'skills.sync: canonical write failed', { error: (err as Error).message })
    }
    // 2. engine links. An existing path is handled by ownership: a symlink
    // already resolving into the canonical dir is a no-op; an owned symlink
    // (marker'd or dangling) is retargeted; a dir whose SKILL.md carries the
    // marker AND holds nothing else is the pure v1 copy and becomes the
    // symlink. A dir with ANY other entry — even alongside our marker'd
    // SKILL.md — is never deleted (2026-08-26: user sub-skill dirs lived next
    // to the v1 file); we refresh just our SKILL.md inside it. Anything
    // unowned is the user's and stays untouched.
    function ensureLink(skillsDir: string) {
      const link = path.join(skillsDir, name)
      try {
        let st: ReturnType<typeof fs.lstatSync> | null = null
        try { st = fs.lstatSync(link) } catch {}
        if (st) {
          try { if (fs.realpathSync(link) === fs.realpathSync(canonicalDir)) return } catch {}
          const skillFile = path.join(link, 'SKILL.md')
          let owned = false
          try { owned = fs.readFileSync(skillFile, 'utf-8').includes(SKILL_SYNC_MARKER) } catch { owned = st.isSymbolicLink() }
          if (!owned) return
          if (st.isDirectory()) {
            const extras = fs.readdirSync(link).filter((e) => e !== 'SKILL.md')
            if (extras.length > 0) {
              const cur = fs.readFileSync(skillFile, 'utf-8')
              if (cur !== skill) { fs.writeFileSync(skillFile, skill, { mode: 0o644 }); wrote.push(skillFile) }
              return
            }
          }
          fs.rmSync(link, { recursive: true, force: true })
        }
        fs.mkdirSync(skillsDir, { recursive: true })
        fs.symlinkSync(canonicalDir, link)
        wrote.push(link)
      } catch (err) {
        logMsg('warn', 'skills.sync: engine link failed', { link, error: (err as Error).message })
      }
    }
    ensureLink(path.join(HOME_DIR, '.claude', 'skills'))
    if (fs.existsSync(path.join(HOME_DIR, '.codex'))) ensureLink(path.join(HOME_DIR, '.agents', 'skills'))
    // goose reads ~/.agents/skills natively too (verified in the 1.31 binary), so
    // the same link is created for a goose-only host. Separate guarded call rather
    // than one OR condition: ensureLink is idempotent (an existing link already
    // resolving to the canonical dir returns immediately), and the per-engine
    // marker stays readable. opencode needs nothing — it scans ~/.claude/skills
    // and ~/.agents/skills itself.
    if (fs.existsSync(path.join(HOME_DIR, '.config', 'goose')) || fs.existsSync(path.join(HOME_DIR, '.local', 'share', 'goose'))) {
      ensureLink(path.join(HOME_DIR, '.agents', 'skills'))
    }
    if (fs.existsSync(daemonEnv.PI_CODING_AGENT_DIR || path.join(HOME_DIR, '.pi', 'agent'))) ensureLink(path.join(HOME_DIR, '.agents', 'skills'))
    // gemini is the only engine with its own dir: it discovers ONLY
    // ~/.gemini/skills and <project>/.gemini/skills, never ~/.agents or ~/.claude.
    if (fs.existsSync(path.join(HOME_DIR, '.gemini'))) ensureLink(path.join(HOME_DIR, '.gemini', 'skills'))
    }
    for (const entry of entries) syncSkill(entry.name, entry.body)
    if (!probeHeld) {
      heldSkills = typeof cmd.hash === 'string' && cmd.hash.length > 0 && cmd.hash.length <= 128 && !canonicalFailed
        ? { hash: cmd.hash, entries } : null
      persistHeldPushes()
    }
    const walnutCanonicalDir = path.join(HOME_DIR, '.open-walnut', 'distributed-skills', 'walnut')
    // 2b. v2.0 migration: remove the marker'd SKILL.md that briefly lived in
    // the user's skill store (it shadowed the category sub-skills there); the
    // dir itself and every other entry stay. Drop the dir only when we owned
    // the sole file in it.
    try {
      const legacyDir = path.join(HOME_DIR, '.open-walnut', 'skills', 'walnut')
      if (path.resolve(legacyDir) !== path.resolve(walnutCanonicalDir)) {
        const legacyFile = path.join(legacyDir, 'SKILL.md')
        let cur: string | null = null
        try { cur = fs.readFileSync(legacyFile, 'utf-8') } catch {}
        if (cur !== null && cur.includes(SKILL_SYNC_MARKER)) {
          fs.rmSync(legacyFile, { force: true })
          wrote.push(legacyFile)
          if (fs.readdirSync(legacyDir).length === 0) fs.rmdirSync(legacyDir)
        }
      }
    } catch (err) {
      logMsg('warn', 'skills.sync: legacy canonical cleanup failed', { error: (err as Error).message })
    }
    // 3. v1 migration: drop the fenced section this daemon used to keep in
    // ~/.codex/AGENTS.md (marker-guarded; a fence-only file is removed whole)
    try {
      const agentsMd = path.join(HOME_DIR, '.codex', 'AGENTS.md')
      let existing = ''
      try { existing = fs.readFileSync(agentsMd, 'utf-8') } catch {}
      const begin = existing.indexOf('<!-- BEGIN ' + SKILL_SYNC_MARKER)
      const endMark = '<!-- END ' + SKILL_SYNC_MARKER + ' -->'
      const end = existing.indexOf(endMark)
      if (begin !== -1 && end > begin) {
        let head = existing.slice(0, begin)
        while (head.endsWith('\n')) head = head.slice(0, -1)
        let tail = existing.slice(end + endMark.length)
        while (tail.startsWith('\n')) tail = tail.slice(1)
        const next = head === '' ? tail : (tail === '' ? head + '\n' : head + '\n\n' + tail)
        if (next.trim() === '') fs.rmSync(agentsMd, { force: true })
        else fs.writeFileSync(agentsMd, next, { mode: 0o644 })
        wrote.push(agentsMd)
      }
    } catch (err) {
      logMsg('warn', 'skills.sync: AGENTS.md fence removal failed', { error: (err as Error).message })
    }
    if (wrote.length > 0) logMsg('info', 'walnut skills distributed', { skills: entries.map((e) => e.name), wrote })
    if (probeHeld) return sendOk(ws, id, { held: true, wrote })
    return sendOk(ws, id, { applied: true, changed: wrote.length > 0, wrote })
  }


  return { cmdSkillsSync }
}
