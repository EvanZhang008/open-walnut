/**
 * An agent's record of its own tab: the requests the page makes (`network`, then a response's body
 * with `network_body`, a request's with `network_request_body`) and its console (`console`), for
 * scripts that read a site's own data the way the page does (a shop's order history, an API a
 * page calls). The browser's debugger stays attached to the tab while it records, so it needs the
 * person's real-input switch, as evaluate does, and Chrome shows its "started debugging" bar on
 * every tab meanwhile (a global bar); the person ends it with that bar's Cancel, or Stop on the page.
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
import { CdpError, acquireDebugger, dropDebugger, holdersOf, releaseDebugger, type Send } from './cdp'
import { AgentError, agentTabs, allowed, filledHere, filledOrigins, nearPerson, originOf, walnutCheck, where, type AgentTab, type WireCommand } from './agent-shared'
import { walnutAddress } from './walnut-address'
import { siteKey } from '../../../src/core/vault/url-match'
import { NET_MAX, bodyOut, fold, listConsole, listRequests, maskEntry, maskUrlsIn, newRecord, urlsOf, type ConsoleEntry, type Judge, type NetEntry, type NetRecord } from './net-record'
import { REAL_INPUT_SWITCH, trustedReady } from './agent-trusted'
import { DIALOG_OPEN, heldForDialog, leaveDialog, watchDialogs } from './agent-dialog'
import { REAL_INPUT_KEY } from './trusted-switch'

const siteOf = (u: string): string => siteKey(u)?.domain ?? ''

export const NET_OPS = new Set(['network', 'network_body', 'network_request_body', 'console'])

const records = new Map<number, NetRecord & { send: Send }>()
/**
 * Each tab's recording generation: a Stop (or close, give-back, agents off) moves it on, so a start
 * still attaching then lets go when it comes back (review 2026-11-07: the debugger stayed on a tab
 * already given back).
 */
const generation = new Map<number, number>()
const genOf = (tabId: number) => generation.get(tabId) ?? 0
/** Tabs where the person cancelled the debugging bar: no agent records there again. */
const cancelled = new Set<number>()
/** Tabs whose debugger attach is under way: a Cancel then still counts (review 2026-11-07). */
const attaching = new Set<number>()
let listening = false

function listen(): void {
  if (listening || !more.debugger?.onEvent) return
  listening = true
  more.debugger.onEvent.addListener((source, method, params) => {
    const r = typeof source?.tabId === 'number' ? records.get(source.tabId) : undefined
    if (r) fold(r, method, params as Record<string, unknown> | undefined)
  })
  more.debugger.onDetach?.addListener((source, reason) => {
    const tabId = source?.tabId
    if (typeof tabId !== 'number' || (!records.has(tabId) && !attaching.has(tabId))) return
    // Whatever was starting or recording there is over: a start still under way sees it.
    generation.set(tabId, genOf(tabId) + 1)
    records.delete(tabId)
    dropDebugger(tabId)
    if (reason === 'canceled_by_user') cancelled.add(tabId)
  })
  ext.tabs.onRemoved.addListener((tabId) => { records.delete(tabId); dropDebugger(tabId); cancelled.delete(tabId) })
  // The person turned real input off (the debugger permission went): every recording ends with it.
  ext.permissions.onRemoved?.addListener((p) => {
    if (!p.permissions?.includes('debugger')) return
    for (const tabId of [...records.keys()]) void stopRecording(tabId)
  })
  // Or turned the switch alone off (the permission may stay for live pictures): the same.
  ext.storage.onChanged?.addListener((changes, area) => {
    if (area !== 'local' || changes[REAL_INPUT_KEY]?.newValue !== false) return
    for (const tabId of [...records.keys()]) void stopRecording(tabId)
  })
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
  // A dialog holds the debugger on this tab until it is answered (agent-dialog.ts).
  if (heldForDialog(tabId)) throw new AgentError(DIALOG_OPEN, 'dialog_open')
  listen()
  watchDialogs()
  const dbg = more.debugger!
  const gen = genOf(tabId)
  attaching.add(tabId)
  let send: Send
  try {
    // The tab's one session (cdp.ts): joined when live pictures hold it already, left attached after.
    send = await acquireDebugger(dbg, tabId, 'record')
  } catch (err) {
    throw new AgentError(err instanceof Error ? err.message : String(err), err instanceof CdpError ? err.code : 'debugger_busy')
  } finally {
    attaching.delete(tabId)
  }
  // Stopped, cancelled, or no longer this holding while the browser attached: let go, record nothing.
  const gone = () => (cancelled.has(tabId)
    ? new AgentError('The person cancelled Chrome\'s debugging bar on this tab, which ends recording there. Ask them before you record again (in a new tab).', 'recording_cancelled')
    : new AgentError('The tab was given back while its recording started: nothing is recorded.', 'not_your_tab'))
  const stale = async () => {
    if (genOf(tabId) !== gen || cancelled.has(tabId)) return true
    const now = await agentTabs.get(tabId)
    return now?.owner !== rec.owner || (!!rec.grant && now?.grant !== rec.grant)
  }
  if (await stale()) {
    await releaseDebugger(dbg, tabId, 'record')
    throw gone()
  }
  const r = { ...newRecord(), send }
  records.set(tabId, r)
  try {
    // Bodies stay in the browser's own buffer (the newest few MB) until an agent asks for one.
    await send('Network.enable', { maxTotalBufferSize: 30_000_000, maxResourceBufferSize: 10_000_000 })
    await send('Runtime.enable')
    await send('Log.enable')
    // Its dialogs too: a page action that opens one answers with it, and dialog answers it.
    await send('Page.enable')
  } catch (err) {
    await stopRecording(tabId)
    throw new AgentError(`The browser would not record that tab: ${err instanceof Error ? err.message : String(err)}`, 'debugger_busy')
  }
  if (await stale()) {
    if (records.get(tabId) === r) await stopRecording(tabId)
    else await releaseDebugger(dbg, tabId, 'record')
    throw gone()
  }
  return true
}

/** The tab records no more: its debugger let go (a tab given back, Stop, the agents switched off). */
export async function stopRecording(tabId: number): Promise<boolean> {
  // A debugger held for a dialog's answer lets go with the tab too; a dialog still open is the person's (agent-dialog.ts).
  await leaveDialog(tabId)
  // Any start still attaching is over too.
  generation.set(tabId, genOf(tabId) + 1)
  const r = records.get(tabId)
  if (!r) return false
  records.delete(tabId)
  const shared = holdersOf(tabId).some((b) => b !== 'record')
  // Detached only when nobody else holds the session (let go at once, as before: a new recording
  // may start right after this).
  await releaseDebugger(more.debugger, tabId, 'record')
  // Another holder keeps the session (live pictures of the tab, a step under way): what the
  // recording turned on goes off, so the browser stops filling its buffers for nobody (Page stays:
  // a step under way watches it for dialogs). A recording started meanwhile keeps its own.
  if (shared) {
    for (const m of RECORDING_DOMAINS) {
      if (records.has(tabId)) break
      await r.send(`${m}.disable`).catch(() => undefined)
    }
  }
  return true
}

/** The domains a recording turns on beside Page (startRecording), turned off when it stops in a session kept for another holder. */
export const RECORDING_DOMAINS = ['Network', 'Runtime', 'Log'] as const

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
  // A site Walnut signed this owner in on, by its site (a sign-in on login.example.test may post to
  // auth.example.test): its addresses lose their query everywhere in the answer, its request
  // bodies are not given, and its pages' console stays closed.
  const filledAt = new Set(await filledOrigins(rec.owner))
  const filledSites = new Set([...filledAt].map((o) => siteOf(o)).filter(Boolean))
  const isFilled = (u: string | undefined) => !!u && /^https?:/i.test(u) && filledSites.has(siteOf(u))
  const off = new Map<string, boolean>()
  const offSite = async (u: string): Promise<boolean> => {
    // data: and blob: carry no site of their own: their page is judged.
    if (!/^https?:/i.test(u)) return false
    const o = originOf(u)
    if (!off.has(o)) off.set(o, !allowed(c.allow, u) || !!walnutAddress(c.allow.walnut, u) || await walnutCheck.isWalnutPage(u))
    return off.get(o)!
  }
  /**
   * What an agent may see of a request: nothing when any address it names (where it went, the page
   * that sent it, where it was redirected from) is a site agents may not use or Walnut's own (review
   * 2026-11-07: a body of a site not allowed came back); its addresses masked when any is a site
   * Walnut signed the agent in on.
   */
  const judgeOne = async (e: NetEntry): Promise<Judge> => {
    const urls = urlsOf(e)
    for (const u of urls) if (await offSite(u)) return 'drop'
    return urls.some(isFilled) ? 'mask' : 'show'
  }
  // Keyed by the entry itself, never its id: a redirect puts a new entry under the same id, and a
  // verdict on the old addresses must not let the new ones through (review 2026-11-07). An entry
  // that came in after the judging is left out.
  const judged = new Map<NetEntry, Judge>()
  for (const e of [...r.requests.values()]) judged.set(e, await judgeOne(e))
  const judge = (e: NetEntry): Judge => judged.get(e) ?? 'drop'
  // One masking pass over everything the answer says (the tab's own address included).
  const masked = <T,>(o: T): T => maskUrlsIn(o, isFilled)
  const since = new Date(r.since).toISOString()
  const fresh = startedNow ? { started_now: true, note: 'Recording started now: what the page did before is not in it. Navigate to the page again (or open it with record) to record its load.' } : {}
  switch (c.action) {
    case 'network': {
      const out = listRequests(r, {
        url: typeof a.url === 'string' ? a.url : undefined, method: typeof a.method === 'string' ? a.method : undefined,
        status: typeof a.status === 'number' || typeof a.status === 'string' ? a.status : undefined,
        type: typeof a.type === 'string' ? a.type : undefined, limit: typeof a.limit === 'number' ? a.limit : undefined, includeStatic: a.include_static === true,
      }, judge)
      return masked({ recording: true, since, ...fresh, ...out, kept: NET_MAX, ...(r.dropped.requests ? { dropped: r.dropped.requests } : {}), ...(await where(tabId)) })
    }
    case 'console': {
      // Each message by the page that logged it, not the page the tab shows now: a sign-in page's
      // console (its origin) stays closed after the agent moves on. A message whose page the browser did not
      // name, or names only as an opaque origin (a sandboxed frame, data:), is not given: an
      // unknown place is no allowed one (review 2026-11-07).
      const keepOf = new Map<string, boolean>()
      for (const m of r.console) {
        const k = m.origin ?? ''
        if (keepOf.has(k)) continue
        keepOf.set(k, /^https?:\/\//i.test(k) && !filledAt.has(k) && !(await offSite(k)))
      }
      const out = listConsole(r, { level: typeof a.level === 'string' ? a.level : undefined, limit: typeof a.limit === 'number' ? a.limit : undefined }, (m: ConsoleEntry) => keepOf.get(m.origin ?? '') ?? false)
      return masked({
        recording: true, since, ...fresh, ...out, ...(r.dropped.console ? { dropped: r.dropped.console } : {}),
        ...(out.withheld ? { withheld_note: `${out.withheld} message(s) withheld: logged by a page Walnut signed you in on, by a site agents may not use, or by a page the browser did not name.` } : {}),
        ...(await where(tabId)),
      })
    }
    case 'network_body': case 'network_request_body': {
      const id = reqIdOf(a)
      const e = r.requests.get(id)
      if (!e) throw new AgentError(`No request ${id} in this tab's recording (network lists them; the oldest go after ${NET_MAX}).`, 'no_such_request')
      const j = judged.get(e) ?? await judgeOne(e)
      // Still the request that was judged: a redirect meanwhile is another one (the agent lists again).
      const same = () => { if (r.requests.get(id) !== e) throw new AgentError('That request moved on (a redirect) while Walnut checked it: list the requests again (network).', 'request_changed') }
      same()
      if (j === 'drop') throw new AgentError('That request went to (or came from) a site agents may not use, or Walnut itself: its body is not read.', 'request_site_not_allowed')
      const max = typeof a.max_chars === 'number' ? a.max_chars : undefined
      const seen = j === 'mask' ? maskEntry(e) : e
      const head = { request_id: id, url: seen.url, method: e.method, ...(e.status !== undefined ? { status: e.status } : {}), ...(e.mime ? { mime: e.mime } : {}) }
      if (c.action === 'network_request_body') {
        if (j === 'mask' || await filledHere(rec.owner, (await ext.tabs.get(tabId).catch(() => null))?.url ?? '')) {
          throw new AgentError('A request\'s body is not read on a site where Walnut signed you in: the sign-in itself sent the password.', 'filled_here')
        }
        if (!e.hasBody) return masked({ ...head, body: '', length: 0, note: 'That request sent no body.' })
        same()
        const got = await r.send('Network.getRequestPostData', { requestId: id }).catch((err: unknown) => { throw noBody(err) }) as { postData?: string }
        same()
        return masked({ ...head, ...bodyOut({ body: got.postData }, max) })
      }
      if (e.failed) throw new AgentError(`That request failed (${e.failed}): it has no body.`, 'no_body')
      same()
      const got = await r.send('Network.getResponseBody', { requestId: id }).catch((err: unknown) => { throw noBody(err) }) as { body?: string; base64Encoded?: boolean }
      same()
      return masked({ ...head, ...bodyOut(got, max) })
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
