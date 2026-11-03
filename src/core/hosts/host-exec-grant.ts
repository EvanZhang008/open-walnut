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
  if (g) return g.id
  // Reading or stopping a job needs the grant the run had; it never asks for one.
  if (preview === null) throw new HostExecError(`This task has no grant to use ${name} (it was revoked).`, 403, 'exec_grant_required')
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
  throw new HostExecError(`This task may not use ${name} yet: a letter asks the user (${letter.id}). You will get a notice when they allow it; do other work meanwhile.`, 403, 'exec_grant_required', { letterId: letter.id })
}
