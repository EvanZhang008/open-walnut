/**
 * An agent's record of its own tab: the requests the page makes (`network`, then a response's body
 * with `network_body`, a request's with `network_request_body`) and its console (`console`), for
 * scripts that read a site's own data the way the page does (a shop's order history, an API a
 * page calls). The browser's debugger stays attached to the tab while it records, so it needs the
 * person's real-input switch, as evaluate does, and Chrome shows its "started debugging" bar on
 * that tab meanwhile; the person ends it with that bar's Cancel, or Stop on the page.
 *
 * Only in a tab an agent opened, never the person's own or one theirs opened (agent-shared.ts
 * nearPerson): such a tab shares the person's sign-ins, so a page they are signed in to answers
 * there too. Recording starts with the first of these actions in the tab (or `open {record}`,
 * before the page loads) and ends when the tab closes, is given back, or `network {stop}`.
 * Bodies stay in the browser until asked for, cut to size. On a site where Walnut signed the
 * agent in (fill_login), a request's body and the console are refused, and addresses lose their
 * query in the listing: they could carry the password.
 */
import { more } from './agent-api'
import { ext, isFirefox } from './ext'
import { CdpError, dropDebugger, holdDebugger, type Send } from './cdp'
import { AgentError, filledHere, nearPerson, originOf, where, type AgentTab, type WireCommand } from './agent-shared'
import { NET_MAX, bodyOut, fold, listConsole, listRequests, newRecord, type NetRecord } from './net-record'
import { REAL_INPUT_SWITCH, trustedReady } from './agent-trusted'

export const NET_OPS = new Set(['network', 'network_body', 'network_request_body', 'console'])

const records = new Map<number, NetRecord & { send: Send }>()
/** Tabs where the person cancelled the debugging bar: no agent records there again. */
const cancelled = new Set<number>()
let listening = false

function listen(): void {
  if (listening || !more.debugger?.onEvent) return
  listening = true
  more.debugger.onEvent.addListener((source, method, params) => {
    const r = typeof source?.tabId === 'number' ? records.get(source.tabId) : undefined
    if (r) fold(r, method, params as Record<string, unknown> | undefined)
  })
  more.debugger.onDetach?.addListener((source, reason) => {
    if (typeof source?.tabId !== 'number' || !records.has(source.tabId)) return
    records.delete(source.tabId)
    dropDebugger(source.tabId)
    if (reason === 'canceled_by_user') cancelled.add(source.tabId)
  })
  ext.tabs.onRemoved.addListener((tabId) => { records.delete(tabId); dropDebugger(tabId); cancelled.delete(tabId) })
}

/** Why this tab may not record, or nothing. */
async function gate(tabId: number, rec: AgentTab): Promise<void> {
  if (isFirefox) throw new AgentError('Recording a tab\'s requests and console needs Chrome: Firefox does not let extensions use its debugger.', 'trusted_off')
  if (!(await trustedReady())) throw new AgentError(`Recording a tab's requests and console uses the browser's debugger. ${REAL_INPUT_SWITCH}`, 'trusted_off')
  if (nearPerson(rec)) {
    throw new AgentError('An agent records only a tab it opened, never the person\'s own tab or one theirs opened. Open the page in a tab of your own (open {url, record: true}): it has the person\'s sign-ins too.', 'not_agent_opened')
  }
  if (cancelled.has(tabId)) {
    throw new AgentError('The person cancelled Chrome\'s debugging bar on this tab, which ends recording there. Ask them before you record again (in a new tab).', 'recording_cancelled')
  }
}

/** Start recording in an agent tab (its debugger attached and left attached), or nothing when it already records. */
export async function startRecording(tabId: number, rec: AgentTab): Promise<boolean> {
  await gate(tabId, rec)
  if (records.has(tabId)) return false
  listen()
  const dbg = more.debugger!
  const target = { tabId }
  try {
    await dbg.attach(target, '1.3')
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    throw new AgentError(/already attached/i.test(m) ? 'Another debugger (DevTools?) is open on that tab: close it and try again.' : `The browser would not attach its debugger: ${m}`, 'debugger_busy')
  }
  const send: Send = (method, params) => dbg.sendCommand(target, method, params ?? {})
  const r = { ...newRecord(), send }
  records.set(tabId, r)
  holdDebugger(tabId, send)
  try {
    // Bodies stay in the browser's own buffer (the newest few MB) until an agent asks for one.
    await send('Network.enable', { maxTotalBufferSize: 30_000_000, maxResourceBufferSize: 10_000_000 })
    await send('Runtime.enable')
    await send('Log.enable')
  } catch (err) {
    await stopRecording(tabId)
    throw new AgentError(`The browser would not record that tab: ${err instanceof Error ? err.message : String(err)}`, 'debugger_busy')
  }
  return true
}

/** The tab records no more: its debugger let go (a tab given back, Stop, the agents switched off). */
export async function stopRecording(tabId: number): Promise<boolean> {
  const r = records.get(tabId)
  if (!r) return false
  records.delete(tabId)
  dropDebugger(tabId)
  await more.debugger?.detach({ tabId }).catch(() => undefined)
  return true
}

const reqIdOf = (a: Record<string, unknown>): string => {
  const id = typeof a.request_id === 'string' ? a.request_id.trim() : ''
  if (!id) throw new AgentError('Which request: request_id, from network.', 'bad_request')
  return id
}

export async function netAct(c: WireCommand, tabId: number, rec: AgentTab): Promise<Record<string, unknown>> {
  const a = c.args
  if (c.action === 'network' && a.stop === true) {
    const was = await stopRecording(tabId)
    return { recording: false, stopped: was, ...(await where(tabId)) }
  }
  const startedNow = await startRecording(tabId, rec)
  const r = records.get(tabId)!
  const tab = await ext.tabs.get(tabId).catch(() => null)
  // One look per site: a listing checks every request's address and page.
  const seen = new Map<string, boolean>()
  const filledOn = async (u: string | undefined) => {
    const o = originOf(u)
    if (!o) return false
    if (!seen.has(o)) seen.set(o, await filledHere(rec.owner, o))
    return seen.get(o)!
  }
  const since = new Date(r.since).toISOString()
  const fresh = startedNow ? { started_now: true, note: 'Recording started now: what the page did before is not in it. Navigate to the page again (or open it with record) to record its load.' } : {}
  switch (c.action) {
    case 'network': {
      const hidden = new Set<string>()
      for (const e of r.requests.values()) for (const u of [e.url, e.page]) if (u && await filledOn(u)) hidden.add(u)
      const out = listRequests(r, {
        url: typeof a.url === 'string' ? a.url : undefined, method: typeof a.method === 'string' ? a.method : undefined,
        status: typeof a.status === 'number' || typeof a.status === 'string' ? a.status : undefined,
        type: typeof a.type === 'string' ? a.type : undefined, limit: typeof a.limit === 'number' ? a.limit : undefined, includeStatic: a.include_static === true,
      }, (u) => hidden.has(u))
      return { recording: true, since, ...fresh, ...out, kept: NET_MAX, ...(r.dropped.requests ? { dropped: r.dropped.requests } : {}), ...(await where(tabId)) }
    }
    case 'console': {
      if (await filledOn(tab?.url)) throw new AgentError('console is not read on a site where Walnut signed you in: a page may log what was typed, the password too.', 'filled_here')
      const out = listConsole(r, { level: typeof a.level === 'string' ? a.level : undefined, limit: typeof a.limit === 'number' ? a.limit : undefined })
      return { recording: true, since, ...fresh, ...out, ...(r.dropped.console ? { dropped: r.dropped.console } : {}), ...(await where(tabId)) }
    }
    case 'network_body': case 'network_request_body': {
      const id = reqIdOf(a)
      const e = r.requests.get(id)
      if (!e) throw new AgentError(`No request ${id} in this tab's recording (network lists them; the oldest go after ${NET_MAX}).`, 'no_such_request')
      const max = typeof a.max_chars === 'number' ? a.max_chars : undefined
      const head = { request_id: id, url: e.url, method: e.method, ...(e.status !== undefined ? { status: e.status } : {}), ...(e.mime ? { mime: e.mime } : {}) }
      if (c.action === 'network_request_body') {
        if (await filledOn(e.url) || await filledOn(e.page) || await filledOn(tab?.url)) {
          throw new AgentError('A request\'s body is not read on a site where Walnut signed you in: the sign-in itself sent the password.', 'filled_here')
        }
        if (!e.hasBody) return { ...head, body: '', length: 0, note: 'That request sent no body.' }
        const got = await r.send('Network.getRequestPostData', { requestId: id }).catch((err: unknown) => { throw noBody(err) }) as { postData?: string }
        return { ...head, ...bodyOut({ body: got.postData }, max) }
      }
      if (e.failed) throw new AgentError(`That request failed (${e.failed}): it has no body.`, 'no_body')
      const got = await r.send('Network.getResponseBody', { requestId: id }).catch((err: unknown) => { throw noBody(err) }) as { body?: string; base64Encoded?: boolean }
      return { ...head, ...bodyOut(got, max) }
    }
  }
  throw new AgentError(`Unknown action ${c.action}.`, 'bad_action')
}

function noBody(err: unknown): AgentError {
  const m = err instanceof CdpError || err instanceof Error ? err.message : String(err)
  return new AgentError(/no resource|no data|not found|no post data/i.test(m)
    ? 'The browser holds no body for that request now (still loading, none sent, or pushed out of its buffer by newer ones).'
    : `The browser would not give the body: ${m}`, 'no_body')
}
