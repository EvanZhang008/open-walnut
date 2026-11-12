/**
 * The user's grant for a task to use another host (host_exec, host_mcp, host_http, host_copy):
 * a grant the task holds, one made at once for a task on one of the user's own hosts, or a letter
 * that asks the user, once per task and host (exec-grants.ts keeps them).
 */
import { log } from '../../logging/index.js'
import { HostExecError, hostName, type Caller } from './host-exec.js'

const LOCAL = '__local__'

/** One ask at a time per task and host, so two first calls at once send one letter. */
const asking = new Map<string, Promise<unknown>>()

/** The grant for this task on this host, or the refusal that asks the user (once) for one. */
export async function grantFor(caller: Caller, host: string, preview: string | null): Promise<string> {
  const key = `${caller.taskId}\u0000${host}`
  const before = asking.get(key) ?? Promise.resolve()
  const mine = before.catch(() => {}).then(() => grantOrAsk(caller, host, preview))
  const settled = mine.catch(() => {})
  asking.set(key, settled)
  void settled.then(() => { if (asking.get(key) === settled) asking.delete(key) })
  return mine
}

/** The shape of a grant id (exec-grants.ts `grant`), for a caller that names one. */
export const GRANT_ID_RE = /^xg-[A-Za-z0-9-]{4,64}$/

/**
 * A call that names the grant it may use (`grant_id`): only that grant, never another. It makes
 * no grant (not even the own-host one) and asks no one, so a call refused here sends no letter
 * (2026-11-04: a task that must run only under a grant the user gave checked the grant first, and
 * a revoke between that check and its call made the call ask the user again by letter).
 */
export async function pinnedGrant(caller: Caller, host: string, grantId: string): Promise<string> {
  const grants = await import('./exec-grants.js')
  const name = await hostName(host)
  if (grants.isHostClosed(host)) {
    throw new HostExecError(`The user closed ${name} to tasks on other hosts (Settings › Remote Hosts); nothing ran. Walnut asked no one.`, 403, 'exec_host_closed')
  }
  const g = grants.grantById(grantId)
  if (!g || g.taskId !== caller.taskId || g.host !== host) {
    // The id to name instead, so a wrong one costs no lookup (2026-11-04 review).
    const mine = grants.findGrant(caller.taskId, host)
    const hint = mine ? ` This task's grant on ${name} is ${mine.id}: name that one.` : ` This task holds no grant on ${name}: an ordinary host_exec there asks the user for one.`
    throw new HostExecError(`Grant ${grantId} is not this task's grant on ${name}; nothing ran. Walnut made no grant and asked no one.${hint}`, 403, 'exec_grant_mismatch', { grantId, ...(mine ? { current: mine.id } : {}) })
  }
  if (g.revokedAt) {
    throw new HostExecError(`Grant ${grantId} for ${name} was revoked; nothing ran. Walnut made no grant and asked no one.${newerGrant(grants, caller.taskId, host, grantId)}`, 403, 'exec_grant_revoked', { grantId, ...current(grants, caller.taskId, host, grantId) })
  }
  return g.id
}

/** The task's live grant on the host other than `named` (one the user gave after revoking that one), for a pinned refusal to name. */
function current(grants: Grants, taskId: string, host: string, named: string): { current?: string } {
  const g = grants.findGrant(taskId, host)
  return g && g.id !== named ? { current: g.id } : {}
}

function newerGrant(grants: Grants, taskId: string, host: string, named: string): string {
  const { current: id } = current(grants, taskId, host, named)
  // No grant there now: say what gets one, since the pinned mode never asks (2026-11-05 review: no next step).
  return id ? ` This task holds another grant there now, ${id}: name that one to run under it.`
    : ' This task holds no grant there now: an ordinary host_exec asks the user for one by letter, or do the step another way.'
}

/**
 * Right before a call's work leaves for the host, after its wait for a slot and its dial (each can
 * take seconds): the grant it came in under still stands and the host is still open, so a revoke
 * or the hard stop that came while it waited starts nothing there. `pinned`: only that grant
 * counts; otherwise any live grant of the task on that host does (one the user gave again in the
 * meantime). Never asks anyone and never makes a grant. Every grantFor that lets work start has
 * this check before the work is sent (ratchet: tests/core/hosts/grant-recheck-ratchet.test.ts).
 */
export async function assertStillGranted(taskId: string, host: string, grantId: string, pinned = false): Promise<string> {
  const grants = await import('./exec-grants.js')
  // The reads are synchronous and nothing is awaited between them and the return, so a revoke
  // the user's route finished before this point is seen.
  const live = liveGrant(grants, taskId, host, grantId, pinned)
  if (live) return live
  throw grantRefusal(grants, taskId, host, grantId, pinned, await hostName(host))!
}

type Grants = typeof import('./exec-grants.js')

/** The grant id the call may still use (the named one when pinned, else the task's live grant), or null. Synchronous. */
function liveGrant(grants: Grants, taskId: string, host: string, grantId: string, pinned: boolean): string | null {
  if (grants.isHostClosed(host)) return null
  const g = pinned ? grants.grantById(grantId) : grants.findGrant(taskId, host)
  return g && !g.revokedAt && g.taskId === taskId && g.host === host ? g.id : null
}

/**
 * assertStillGranted for a caller that must not await between the check and its send (a gate
 * read again at each step of a longer job): the refusal, or null while the grant stands.
 */
export function grantRefusal(grants: Grants, taskId: string, host: string, grantId: string, pinned: boolean, name: string): HostExecError | null {
  if (liveGrant(grants, taskId, host, grantId, pinned)) return null
  const closed = grants.isHostClosed(host)
  log.session.info('host exec: refused at dispatch', { taskId, host, grantId, pinned, closed })
  if (closed) {
    return new HostExecError(`The user closed ${name} to tasks on other hosts (Settings › Remote Hosts) while this call waited; nothing ran there.`, 403, 'exec_host_closed')
  }
  const newer = pinned ? newerGrant(grants, taskId, host, grantId) : ''
  return new HostExecError(`This task's grant to use ${name} was revoked while this call waited; nothing ran there.${newer}`, 403, 'exec_grant_revoked', { grantId, ...(pinned ? current(grants, taskId, host, grantId) : {}) })
}

/**
 * Stopping or listing the task's own runs on `host`: a live grant, or one the user revoked (its
 * runs there keep going, and the task may still stop them; the host only ever answers with the
 * task's own jobs). A task that never had a grant there is refused as grantFor refuses it.
 */
export async function mayTendRuns(caller: Caller, host: string): Promise<{ revoked: boolean; grantId: string | null }> {
  const grants = await import('./exec-grants.js')
  const g = grants.findGrant(caller.taskId, host)
  if (g) return { revoked: false, grantId: g.id }
  if (grants.wasRevoked(caller.taskId, host)) return { revoked: true, grantId: null }
  return { revoked: false, grantId: await grantFor(caller, host, null) }
}

/** A refusal that ends a read in flight: the user took the task's way to that host away. */
export function isReadStop(err: unknown): boolean {
  return err instanceof HostExecError && err.status === 403 && (err.code === 'exec_grant_revoked' || err.code === 'exec_host_closed')
}

/**
 * A read of a job's output, at its send and again when its answer comes back (a read may wait a
 * minute on the host): the task still holds a grant there and the host is open, so a revoke or a
 * closed host while a call waited shows nothing more of the job (2026-11-04 review: a wait that
 * began before a revoke went on returning the lines the job printed after it). Any live grant of
 * the task counts, as for every read. The run itself keeps going: stop and list still reach it.
 */
export async function assertMayRead(taskId: string, host: string, jobId: unknown): Promise<void> {
  const grants = await import('./exec-grants.js')
  const closed = grants.isHostClosed(host)
  if (!closed && grants.findGrant(taskId, host)) return
  const job = typeof jobId === 'string' ? `job ${jobId}` : 'the job'
  const then = `It keeps running to its deadline: host_exec_stop stops it, and host_exec_list shows how it ends.`
  log.session.info('host exec: read stopped', { taskId, host, jobId, closed })
  if (closed) throw new HostExecError(`The user closed ${await hostName(host)} to tasks on other hosts (Settings › Remote Hosts) while this call waited, so Walnut shows nothing more of ${job}. ${then}`, 403, 'exec_host_closed', { jobId })
  throw new HostExecError(`The user revoked this task's grant to use ${await hostName(host)} while this call waited, so Walnut shows nothing more of ${job}. ${then}`, 403, 'exec_grant_revoked', { jobId })
}

/**
 * The moment the task loses its way to `host` while a read is held there (a revoke, a closed host):
 * `stopped` rejects with assertMayRead's refusal then, so the call answers at once instead of when
 * the host's read comes back, up to a minute later (2026-11-05 review: a revoke during a 30 s wait
 * was answered 25 s on). `off` when the read is done.
 */
export async function readStopWatch(taskId: string, host: string, jobId: unknown): Promise<{ stopped: Promise<never>; off: () => void }> {
  const grants = await import('./exec-grants.js')
  let off = () => {}
  const stopped = new Promise<never>((_resolve, reject) => {
    off = grants.onAccessChange((may) => {
      if (may(taskId, host)) return
      off()
      assertMayRead(taskId, host, jobId).then(() => {}, reject)
    })
  })
  stopped.catch(() => { /* a stop that comes after the read is nobody's */ })
  return { stopped, off: () => off() }
}

/**
 * A host the user registered: this Mac, or a host in Settings > Remote Hosts (the
 * cloud companion is one). A task there uses the user's other hosts without a letter.
 */
export async function isOwnHost(host: string): Promise<boolean> {
  if (host === LOCAL) return true
  const { getConfig } = await import('../config-manager.js')
  return Object.hasOwn((await getConfig()).hosts ?? {}, host)
}

async function grantOrAsk(caller: Caller, host: string, preview: string | null): Promise<string> {
  const grants = await import('./exec-grants.js')
  const name = await hostName(host)
  // The user's hard stop for this host: nothing new starts there, whatever the grant.
  if (preview !== null && grants.isHostClosed(host)) {
    throw new HostExecError(`The user closed ${name} to tasks on other hosts (Settings › Remote Hosts). Do the step another way.`, 403, 'exec_host_closed')
  }
  const g = grants.findGrant(caller.taskId, host)
  // A grant the switch made counts only while approvals stay off: turned on, this task asks.
  if (g && !(g.via === 'approvals-off' && preview !== null && await (await import('../approvals/ask-me.js')).asksPerson())) return g.id
  // Reading or stopping a job needs the grant the run had; it never asks for one.
  if (preview === null) {
    // A revoke reads as the pinned mode reads it: one code for one state (2026-11-05 review).
    if (grants.wasRevoked(caller.taskId, host)) {
      throw new HostExecError(`The user revoked this task's grant to use ${name}, so Walnut reads nothing more there for it. Runs it started there keep going to their deadline: host_exec_stop still stops them (host_exec_list lists them).`, 403, 'exec_grant_revoked')
    }
    throw new HostExecError(`This task has no grant to use ${name}.`, 403, 'exec_grant_required')
  }
  let ask = grants.findAsk(caller.taskId, host)
  // A task on one of the user's own hosts asks no one; a grant he revoked, or his Deny, still stands.
  if (ask?.state !== 'denied' && !grants.wasRevoked(caller.taskId, host) && await isOwnHost(caller.host)) {
    if (ask?.state === 'pending') {
      // Its letter is settled for the user, unless the user already answered it: then that answer stands.
      await grants.settleOwnHostAsks(isOwnHost, { taskId: caller.taskId, host, fromHost: caller.host })
      ask = grants.findAsk(caller.taskId, host)
    }
    if (ask?.state !== 'denied') {
      const own = grants.findGrant(caller.taskId, host) ?? await grants.grant(caller.taskId, host, 'own-host')
      log.session.info('host exec: a task on an own host uses another, no letter', { taskId: caller.taskId, fromHost: caller.host, host, grantId: own.id })
      return own.id
    }
  }
  if (ask?.state === 'pending') {
    const now = await grants.refreshAsk(ask)
    if (now === 'granted') {
      const g2 = grants.findGrant(caller.taskId, host)
      if (g2) return g2.id
    }
    ask = now === 'dropped' ? undefined : grants.findAsk(caller.taskId, host)
  }
  // Approvals are off: no letter asks. His own Deny and revoke above still stand.
  if (ask?.state !== 'denied' && !grants.wasRevoked(caller.taskId, host)) {
    const { asksPerson } = await import('../approvals/ask-me.js')
    if (!(await asksPerson())) {
      const off = grants.findGrant(caller.taskId, host) ?? await grants.grant(caller.taskId, host, 'approvals-off')
      log.session.info('host exec: approvals are off, the task uses the host with no letter', { taskId: caller.taskId, fromHost: caller.host, host, grantId: off.id })
      return off.id
    }
  }
  if (ask?.state === 'denied') {
    throw new HostExecError(`The user declined to let this task use ${name} (commands, MCP servers, web services). Do the step another way, or ask the user in your reply.`, 403, 'exec_grant_denied')
  }
  if (ask?.state === 'pending') {
    throw new HostExecError(`Waiting for the user to allow this task to use ${name} (letter ${ask.letterId}). You will get a notice when they allow it; do other work meanwhile.`, 403, 'exec_grant_required', { letterId: ask.letterId })
  }
  const from = caller.host === LOCAL ? null : await hostName(caller.host)
  const { HOST_EXEC_ASK } = await import('../human-inbox/walnut-letters/host-exec-ask.js')
  const { walnutLetterLanguage } = await import('../human-inbox/walnut-letters/languages.js')
  const { letterOpKey } = await import('../human-inbox/walnut-letters/kind.js')
  const rendered = HOST_EXEC_ASK.render(await walnutLetterLanguage(), { title: caller.taskTitle, from, target: host === LOCAL ? null : name, preview })
  const { sendLetter } = await import('../human-inbox/store.js')
  const letter = await sendLetter({
    subject: rendered.subject,
    type: HOST_EXEC_ASK.type,
    markdown: rendered.markdown,
    actions: rendered.actions,
    taskRefs: [caller.taskId],
    sender: { sessionId: 'external', host: 'local' },
  // The mark names the task and the host, so the sweep (walnut-letters/sweep.ts) knows them without the ask record.
  }, { opKey: letterOpKey(HOST_EXEC_ASK.id, host, caller.taskId, Date.now().toString(36)) })
  await grants.recordAsk({ taskId: caller.taskId, host, letterId: letter.id, askedAt: Date.now(), sid: caller.sid, fromHost: caller.host, state: 'pending' })
  log.session.info('host exec: asked the user for a grant', { taskId: caller.taskId, host, letterId: letter.id })
  // After a revoke the answer says so: the user took it back, and this letter asks again (2026-11-05 review claude13).
  const revokedAt = grants.lastRevokedAt(caller.taskId, host)
  if (revokedAt !== undefined) {
    throw new HostExecError(`The user revoked this task's grant to use ${name} ${agoText(Date.now() - revokedAt)}, so nothing ran; a letter asks them again (${letter.id}). You will get a notice if they allow it; meanwhile do other work, or do the step another way.`, 403, 'exec_grant_required', { letterId: letter.id, revokedAt })
  }
  throw new HostExecError(`This task may not use ${name} yet: a letter asks the user (${letter.id}). You will get a notice when they allow it; do other work meanwhile.`, 403, 'exec_grant_required', { letterId: letter.id })
}

function agoText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 172_800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86_400)} days ago`
}
