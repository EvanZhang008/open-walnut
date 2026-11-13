import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PluginLifecycleChangedEvent } from '../../core/event-types.js'
import type { WalnutServerPluginApi } from '../../core/plugins/server-api.js'
import { MailAccounts } from './accounts.js'
import type { MailAgentDeps } from './agent-surface.js'
import { createMailBaseApi } from './api.js'
import { MailApprovals } from './approvals.js'
import { MailBodyStore } from './bodies.js'
import { reconcileBodyRevision, reconcileRefusalRevision } from './body-revision.js'
import { reconcileIdentityRevision } from './identity-revision.js'
import { providerIdOf, type MailAccountDto } from './contract.js'
import { openMailDatabase } from './db.js'
import { MailDigest } from './digest.js'
import { MailDrafts } from './drafts.js'
import { MailEvents } from './events.js'
import { MailFilterMover } from './mail-filter-moves.js'
import { registerMailItemSource } from './item-source.js'
import { readRouterAreas } from '../../core/router/areas.js'
import { registerMailRouterSource } from './router-source.js'
import { tidyNoiseMail } from './router-noise.js'
import type { RouterNoiseOutcome } from '../../core/router/source-registry.js'
import type { RouterSource } from '../../core/router/types.js'
import { decorateMailRoutes } from './router-decoration.js'
import { bindMailAccounts, createMailRouterIntake } from './router-intake.js'
import { createMailOps } from './ops.js'
import { guardMailOps, guardMailTools, keepUnassignedMail } from './router-read-guard.js'
import { createMailMentionSource } from './mention-source.js'
import { MailProviderRegistry, PROVIDERS_CHANGED_EVENT } from './provider-registry.js'
import { createMailTriggerTemplate } from './trigger-template.js'
import { MailRetention } from './retention.js'
import { registerMailRoutes } from './routes.js'
import { MailSends } from './sends.js'
import { MailService } from './service.js'
import { MailSortEngine } from './sort-engine.js'
import { MailStore } from './store.js'
import { MailSync, mailSyncForTesting, setActiveMailSync } from './sync.js'
import { createMailTools } from './tools.js'
import { MailUnsubscribe } from './unsubscribe.js'
import { asksPerson, recordUnasked } from '../../core/approvals/ask-me.js'

/**
 * The Mail base, as a capability plugin.
 *
 * It owns the domain: the provider contract, the cache, the sync loop, the routes, and later
 * the drafts, approvals, tools and skill. The kernel keeps only the loader, the bus, storage
 * primitives, the App Registry, letters, auth and the server, and it never learns the word
 * "mail".
 *
 * The agent surface is GATED ON AN ACCOUNT EXISTING. A zero-account install must leave the
 * agent's prompt byte-identical to a boot with this plugin disabled, so nothing is registered
 * until `listAccounts()` answers with something, and everything is withdrawn again when the last
 * account goes. The first account pays exactly one prompt-cache miss, which is the honest price
 * of a new capability; an install that never asks for mail pays nothing. See `syncAgentSurface`.
 *
 * Activation only REGISTERS. Nothing here awaits I/O and nothing here STARTS I/O either: a plugin
 * has 20 seconds to activate, the database opens itself on first use (see db.ts), and the poll
 * loop reads its config and arms its interval on its own time (see sync.ts). The two reads
 * activation cannot avoid needing (the account count for the gate, the frozen-draft sweep) are
 * therefore armed on HOST TIMERS rather than launched as floating promises. The difference is
 * ownership: a floating promise that opens the database keeps running after the loader has torn
 * the plugin down and re-creates its data directory behind it, while a host timer is cancelled by
 * the disposal that tore it down.
 */

/**
 * The loader's lifecycle announcement (payload: `PluginLifecycleChangedEvent`, declared in
 * src/core/event-types.ts). Spelled out because `walnut.events.on` takes a plain string; the
 * PAYLOAD is typed, so the two ends cannot drift.
 */
const PLUGIN_LIFECYCLE_CHANGED = 'plugin:lifecycle-changed'

/** States in which a plugin is still around to own its registrations. */
const LIVE_STATES = new Set(['discovered', 'activating', 'active'])

/** Names the agent context line spells out before it starts counting. */
const CONTEXT_NAMES = 3

/**
 * The skill directory, GATED like the tools rather than discovered like a convention.
 *
 * A plugin's `<pluginDir>/skills` is found at LOAD time, from the manifest and a `stat`, so it is
 * indexed on an install with no mail account at all: about 176 tokens of every turn, for every
 * user, describing tools that are not there. The directory is therefore named `agent-skills`,
 * which nothing discovers by convention, and registered with `walnut.registry.skill` next to the
 * tools so it comes and goes with them. A zero-account install is byte-identical again, skill
 * index included.
 *
 * Resolved from this module's own location because the layouts differ and all are real:
 * `src/integrations/mail/` when the server runs from source (every test does). A build loads
 * mail through the host bundle (src/integrations/host-modules.ts), so `import.meta.url` is
 * dist/cli.js or dist/web/server.js there (the compiled file defines it the same way), and the
 * directory is the build's `dist/integrations/mail/agent-skills`, found by walking up.
 */
const SKILL_DIR = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [path.join(here, 'agent-skills')]
  for (let dir = here, i = 0; i < 4; i++, dir = path.dirname(dir)) {
    candidates.push(path.join(dir, 'integrations', 'mail', 'agent-skills'))
  }
  return candidates.find((c) => fs.existsSync(c)) ?? candidates[0]!
})()

/** Test seam: the registration is inside a private closure, and the path has to be assertable. */
export function mailSkillDirForTesting(): string {
  return SKILL_DIR
}

/**
 * The one line the agent is told about mail when at least one account exists.
 *
 * Deliberately tiny. It is a prompt PREFIX, paid on every turn forever, so it names the accounts
 * (an agent that does not know an account id has to spend a tool call finding out) and says
 * nothing else; the how-to lives in the `walnut-mail` skill, which loads only when needed.
 */
export function mailContextLine(accounts: MailAccountDto[]): string {
  const names = accounts.map((one) => one.displayName || one.address || one.accountId)
  const shown = names.slice(0, CONTEXT_NAMES)
  const rest = names.length - shown.length
  const list = rest > 0 ? `${shown.join(', ')}, and ${rest} more` : shown.join(', ')
  return `Mail: ${accounts.length} ${accounts.length === 1 ? 'account' : 'accounts'}: ${list}`
}

export function activate(walnut: WalnutServerPluginApi): { dispose(): Promise<void> } {
  const events = new MailEvents((name, data) => {
    // The host namespaces these to `plugin:mail:<name>`.
    walnut.events.emit(name, data)
  })
  // Late-bound on purpose: the service is BUILT from `providers`, so this callback cannot close over
  // it. A provider appearing or going away changes what its accounts can do, and the service caches
  // that answer per account.
  let forgetCapabilities: (accountId?: string) => void = () => undefined
  const providers = new MailProviderRegistry((event) => {
    forgetCapabilities()
    walnut.events.emit(PROVIDERS_CHANGED_EVENT, event)
  })

  const db = openMailDatabase(walnut)
  const store = new MailStore(db)
  const unregisterItemSource = registerMailItemSource(store)
  const routingHome = path.dirname(path.dirname(walnut.storage.dataDir))
  const bodies = new MailBodyStore(walnut.storage.dataDir)
  // Late-bound: the noise decision marks read through the service and archives through the mover,
  // both built below. A replica changes no mail, so its router source has no noise hook.
  let tidyNoise: (source: RouterSource) => Promise<RouterNoiseOutcome> = async () => ({ read: false, archived: false })
  const unregisterRouterSource = registerMailRouterSource(store, bodies, walnut.replica ? {} : { noise: (source) => tidyNoise(source) })
  // Inbox sorting. Built before the service because ingest classifies each row it writes. The rules
  // file lives in this plugin's data dir; its poll is a HOST timer so teardown cancels it.
  const sort = new MailSortEngine({
    store,
    events,
    dataDir: walnut.storage.dataDir,
    interval: (handler, ms) => walnut.timers.interval(handler, ms),
    canMarkRead: (accountId) => {
      const spec = providers.get(providerIdOf(accountId))
      return !!spec?.capabilities.markRead && typeof spec.markRead === 'function'
    },
    // The model labels unread mail through the HOST's call (the user's own main provider).
    ...(typeof walnut.model?.fastText === 'function' ? { model: (request) => walnut.model.fastText(request) } : {}),
    timeout: (handler, ms) => walnut.timers.timeout(handler, ms),
    log: walnut.log,
  })
  // "Keep out of the inbox" rules: ingest queues the new mail they decide, this moves it to the archive.
  const filters = new MailFilterMover({
    store,
    bodies,
    providers,
    groupsChanged: (pairs) => sort.notifyGroupsChanged(pairs, false),
    onSettled: (event) => {
      events.filtered(event)
      // A filter may have made its folder just now: list the account's folders again so it shows.
      if (event.folder && event.moved > 0) void relistNow(event.accountId)
    },
    // Asked once the rules are loaded. A sort engine that could not start moves nothing: where a
    // filter files its mail is only known from a loaded rule, and mail left in the inbox is safe.
    // A sort engine that failed to start cannot say: undefined holds the rows, it never drops them.
    ruleTarget: async (ruleId) => {
      try { await sort.ready() } catch { return undefined }
      return sort.filterTarget(ruleId)
    },
    stillDecides: (ruleId, accountId, messageIds) => sort.filterStillDecides(ruleId, accountId, messageIds),
    timeout: (handler, ms) => walnut.timers.timeout(handler, ms),
    log: walnut.log,
  })
  sort.setMoveSink((requests) => {
    void filters.queue(requests).catch((error) => walnut.log.warn('mail filter moves not queued', { error: String(error).slice(0, 200) }))
  })
  // A retry waiting when Walnut stopped has no timer any more: pick the ledger up again (the primary
  // only; a replica moves no mail).
  if (!walnut.replica) filters.schedule(30_000)
  // Late-bound like `forgetCapabilities`: the poll loop is built from the service. An unread check that
  // cleared rows moved the folder's own count too, so the loop re-lists that account's folders next.
  let relistDue: (accountId: string) => void = () => undefined
  let relistNow: (accountId: string) => Promise<void> = async () => undefined
  const service = new MailService({
    store,
    bodies,
    providers,
    routes: (messages) => decorateMailRoutes(messages, routingHome),
    // Late-bound: the sync is built from this service.
    arrivals: (accountId, headlines) => sync ? sync.routeArrivals(accountId, headlines) : Promise.resolve(),
    events: {
      unreadReconciled: (event) => {
        events.unreadReconciled(event)
        if (event.cleared > 0) relistDue(event.accountId)
      },
    },
    log: walnut.log,
    sort,
    filters,
  })
  forgetCapabilities = (accountId) => service.forgetCapabilities(accountId)
  // The write path. `letters` is the host's, and it is the ONLY way this plugin asks the human
  // for anything: a letter renders on the console and on the phone, and its answer comes back
  // through the bus filtered to this plugin's own letters.
  const drafts = new MailDrafts({ store, events })
  const sends = new MailSends({ store, service, drafts, letters: walnut.letters, events, log: walnut.log })
  const approvals = new MailApprovals({
    store, service, drafts, sends, letters: walnut.letters, events, log: walnut.log, asksPerson,
    recordUnasked: (what) => recordUnasked('mailSend', { what }),
  })
  // Leaving a mailing list. Its own module because it is the one part of this plugin that opens a url
  // a STRANGER wrote from inside the user's network, and every rule about that lives together in
  // `unsubscribe-http.ts`. Nothing here configures the guard: there is no switch to configure.
  // `drafts` + `approvals` are the mailto rung's: it sends through the ORDINARY approval ledger, on the
  // console side of it, so an unsubscribe mail is validated, recorded and settled by exactly the code
  // every other outgoing mail goes through. Nothing else about this module can send.
  const unsubscribe = new MailUnsubscribe({
    store, service, events, drafts, approvals, letters: walnut.letters, log: walnut.log, asksPerson,
    recordUnasked: (what) => recordUnasked('mailUnsubscribe', { what }),
  })
  // Everything that deletes, in one place, so a read path cannot reach a delete by accident.
  const retention = new MailRetention({
    store,
    bodies,
    events,
    // Exact mail items an area holds; a read error rejects, and retention then deletes nothing.
    protectedRouterItems: async () => new Set((await readRouterAreas(routingHome)).items
      .filter((item) => item.source.kind === 'mail')
      .map((item) => JSON.stringify([item.source.account, item.source.message]))),
  })
  // Mail leaving the plugin as a letter: the day's unread becomes one, through the host's own
  // `walnut.letters`, so the kernel never learns the word "mail" for it. A message no longer becomes
  // a task here: the Mail reader and the Inbox letter offer Talk to CEO / New task on it instead.
  const digest = new MailDigest({
    store,
    events,
    letters: walnut.letters,
    // The CHEAP shape: the digest wants names and counts, and the capability half of the full shape
    // is a provider call per account.
    accounts: () => service.listAccounts({ capabilities: false }),
    config: walnut.config,
    log: walnut.log,
    sort,
  })
  // One account's noise is tidied one mail at a time: a router deciding fifty newsletters in a row
  // queues fifty, and a mail server sees them in order, not all at once.
  const tidyChains = new Map<string, Promise<unknown>>()
  const tidyOne = (source: RouterSource) => tidyNoiseMail({
    store,
    canMarkRead: (accountId) => {
      const spec = providers.get(providerIdOf(accountId))
      return !!spec?.capabilities.markRead && typeof spec.markRead === 'function'
    },
    markRead: (accountId, messageId) => service.markRead(accountId, messageId, true),
    canArchive: (accountId) => filters.canArchive(accountId),
    archive: (accountId, messageId, stillCurrent) => filters.archiveNow(accountId, messageId, stillCurrent),
  }, source)
  tidyNoise = (source) => {
    const run = (tidyChains.get(source.account) ?? Promise.resolve()).catch(() => undefined).then(() => tidyOne(source))
    tidyChains.set(source.account, run)
    void run.catch(() => undefined).finally(() => { if (tidyChains.get(source.account) === run) tidyChains.delete(source.account) })
    return run
  }
  // One direction only: `accounts` reaches the loop (setup kicks a poll, a delete forgets the
  // account's backoff), and the loop no longer reaches back, because health writes now go
  // straight to the store as a bare UPDATE rather than through the mirror's upsert. The late
  // binding is what lets the two be constructed in either order.
  let sync: MailSync
  const accounts = new MailAccounts({
    store,
    retention,
    providers,
    events,
    kick: (accountId) => { void sync.refresh(accountId).catch(() => undefined) },
    forget: (accountId) => sync.forget(accountId),
    replica: () => walnut.replica,
    log: walnut.log,
  })
  // The digest rides the tick rather than a timer of its own: "is today's due" is a clock question,
  // and this plugin already owns exactly one timer. A replica arms no tick at all, which is also how
  // the digest stays off there without a second replica check.
  const captureIncoming = createMailRouterIntake({ store, home: routingHome, log: walnut.log })
  sync = new MailSync({ walnut, store, service, retention, events, sends, approvals, digest, sort, captureIncoming })
  relistDue = (accountId) => sync.markRelistDue(accountId)
  relistNow = (accountId) => sync.relistNow(accountId)
  setActiveMailSync(sync)
  // Each mailbox goes to the one mail router (made when there is none), so the router reads every
  // new mail; the intake also binds a mailbox added later, at its first new mail.
  if (!walnut.replica) {
    walnut.timers.timeout(() => {
      void bindMailAccounts(store, routingHome, walnut.log)
    }, 5_000)
  }

  // The letter answers. Owned by the loader through `walnut.letters`, and filtered host-side to
  // this plugin's own letters, so the ledger can never be handed a letter id it did not issue.
  //
  // A ROUTER, because this plugin now issues letters from two ledgers. The unsubscribe ledger is
  // asked first and answers whether the letter is one of ITS OWN (it looks the id up as a `ref` on its
  // own rows); everything else goes to the approval ledger exactly as before. The order is not
  // arbitrary and the fallthrough is not incidental: the approval path treats an answer it cannot find
  // a draft for as SUPERSEDED and replies so, which for an unsubscribe letter would be a confident
  // wrong answer ("the draft was edited, discarded or sent") about a message that has no draft at all.
  // So the ledger that can prove ownership goes first, and the one that guesses goes last.
  walnut.letters.onAnswered(async (event) => {
    if (await unsubscribe.onLetterAnswered(event)) return
    await approvals.onLetterAnswered(event)
  })

  /**
   * One sweep shortly AFTER activate, before the first tick's interval elapses.
   *
   * A restart is exactly when a draft left frozen by the process that just died has to be put
   * right, and waiting two minutes for the poll timer would leave the console showing a send
   * nobody is running. But it does not belong inline in activate: `reconcile()` opens the
   * database, activation only registers, and a floating promise that opens a worker-thread
   * database during activation kept the plugin's data directory busy after the loader had already
   * torn the plugin down (an `ENOTEMPTY` on the very next test's cleanup). A host timer is owned
   * by the loader, so a teardown at second 1 cancels it instead of racing it.
   *
   * Off on a replica: nothing polls there, no draft was ever frozen there, and this would be the
   * one thing that opened a mail database on a box with no mailbox.
   */
  const RECONCILE_DELAY_MS = 2_000
  const reconcileTimer = walnut.replica
    ? { dispose: () => undefined }
    : walnut.timers.timeout(async () => {
      try {
        await approvals.reconcile()
      } catch (error: unknown) {
        walnut.log.warn('mail could not reconcile frozen drafts after activate', {
          error: String(error).slice(0, 200),
        })
      }
    }, RECONCILE_DELAY_MS)

  walnut.services.publish('base', createMailBaseApi({
    providers,
    events,
    sync,
    accounts: () => service.listAccounts(),
    caller: () => walnut.services.caller(),
    adopt: (providerId) => accounts.adopt(providerId),
    // A provider saying the bodies it handed over before its own fix are wrong. Nothing on a
    // replica: the cache and its body files live on the primary, which is the only box that ever
    // fetched them. It reports its own failure because the caller is a timer with nobody to tell.
    bodyRevision: async (providerId, revision) => {
      if (walnut.replica) return
      try {
        await reconcileBodyRevision({ store, bodies, log: walnut.log }, providerId, revision)
      } catch (error: unknown) {
        walnut.log.warn('mail could not retire the bodies a provider replaced', {
          providerId, revision: revision ?? '', error: String(error).slice(0, 200),
        })
      }
    },
    // A provider that can now read mail it used to refuse as too large. Replica rule and failure
    // handling as for bodyRevision: the refusals live on the primary's rows.
    refusalRevision: async (providerId, revision) => {
      if (walnut.replica) return
      try {
        await reconcileRefusalRevision({ store, log: walnut.log }, providerId, revision)
      } catch (error: unknown) {
        walnut.log.warn('mail could not forget the refusals a provider replaced', {
          providerId, revision: revision ?? '', error: String(error).slice(0, 200),
        })
      }
    },
    // A provider saying its handles changed meaning: the whole cache for its accounts goes, and
    // the next poll lists again. Replica rule and failure handling as for bodyRevision.
    identityRevision: async (providerId, revision) => {
      if (walnut.replica) return
      try {
        await sync.resetAccountBackfill(async () => {
          const result = await reconcileIdentityRevision({ store, bodies, log: walnut.log }, providerId, revision)
            .catch((error: unknown) => {
              walnut.log.warn('mail could not drop the cache a provider re-keyed', {
                providerId, revision: revision ?? '', error: String(error).slice(0, 200),
              })
              return null
            })
          if (result && !result.swept) return []
          // A partial wipe re-lists too, so its accounts are not announced either.
          return (await store.listAccounts()).map((row) => row.account_id).filter((id) => id.startsWith(`${providerId}:`))
        })
      } catch (error: unknown) {
        walnut.log.warn('mail could not drop the cache a provider re-keyed', {
          providerId, revision: revision ?? '', error: String(error).slice(0, 200),
        })
      }
    },
    // A HOST TIMER, for the same reason the reconciler and the first surface read are: the sweep
    // opens the database, and one that outlived a teardown would re-create the plugin's data
    // directory after the loader deleted it. A timer is cancelled by dispose.
    defer: (run) => { walnut.timers.timeout(run, 0) },
  }))
  registerMailRoutes(walnut, {
    store, service, accounts, providers, sync, drafts, approvals, sends, digest,
    unsubscribe, sort, events, filters,
  })

  // The phantom-provider sweep. A provider plugin normally disposes its own registration, and
  // the case this exists for is the one where it cannot: an `activate` that threw after
  // `registerProvider` returned. Without it, that row stayed forever and every retry hit the
  // duplicate-id refusal, so the provider was un-installable until the server restarted.
  walnut.events.on(PLUGIN_LIFECYCLE_CHANGED, (event) => {
    const payload = event.data as PluginLifecycleChangedEvent | undefined
    if (!payload?.pluginId || payload.pluginId === walnut.pluginId) return
    if (LIVE_STATES.has(payload.state)) return
    const removed = providers.removeOwner(payload.pluginId)
    if (removed.length === 0) return
    walnut.log.info('mail providers dropped with their owner', {
      pluginId: payload.pluginId, state: payload.state, providers: removed,
    })
  })

  // ── the agent surface, gated on an account existing ──
  //
  // The registrations are held so BOTH edges work: the last account going away has to withdraw
  // the tools, the ops and the context line, or a mail-free Walnut keeps advertising a mailbox
  // nobody can reach. Every handle here is also owned by the loader, so a plugin teardown that
  // never reaches `dispose` below still releases them.
  const agentDeps: MailAgentDeps = {
    service, drafts, approvals, unsubscribe, replica: () => walnut.replica,
  }
  let registered: Array<{ dispose(): void | Promise<void> }> = []
  let currentLine = ''
  // Serialized on one chain: two account changes arriving in the same tick would otherwise both
  // read "nothing registered" and both register, and the tool list would carry each tool twice.
  let queue: Promise<void> = Promise.resolve()

  async function syncAgentSurface(): Promise<void> {
    // The CHEAP shape: the gate counts accounts and the context line names them. Asking for the full
    // one would make a provider call per account every time an account changes.
    const accounts = await service.listAccounts({ capabilities: false })
    const line = accounts.length === 0 ? '' : mailContextLine(accounts)
    // The line IS the signature: it moves when the count moves and when a display name changes,
    // and nothing else about the surface depends on the accounts. Equal means nothing to do, which
    // is what keeps an ordinary account poll from re-registering six tools every tick.
    if (line === currentLine) return
    for (const handle of registered.splice(0)) await handle.dispose()
    currentLine = ''
    if (!line) {
      walnut.log.info('mail agent surface withdrawn: no accounts left', {})
      return
    }
    // Built into a LOCAL array and only published on success. A throw part way through (a name
    // the host refuses, a skill directory it rejects) would otherwise leave live registrations
    // that `registered` never knew about, so nothing could ever withdraw them and the next pass
    // would register a second copy on top.
    const fresh: Array<{ dispose(): void | Promise<void> }> = []
    try {
      // Every op and tool naming an exact message judges a non-person caller's incoming-item area
      // first: the gateway and tool belts run these in-process, past the HTTP area middleware.
      for (const tool of guardMailTools(createMailTools(agentDeps), agentDeps, createMailTools)) fresh.push(walnut.registry.tool(tool))
      for (const op of guardMailOps(createMailOps(agentDeps), agentDeps, createMailOps)) fresh.push(walnut.registry.op(op))
      fresh.push(walnut.registry.skill({ id: 'walnut-mail', directory: SKILL_DIR }))
      fresh.push(walnut.registry.triggerTemplate(createMailTriggerTemplate({
        store, listAccounts: () => service.listAccounts({ capabilities: false }),
        // The watching session is judged as an agent with no area: classified mail never reaches it.
        filterIncoming: (rows) => keepUnassignedMail(rows),
      })))
      fresh.push(walnut.registry.agentContext(line))
      // The "@" picker's Mail tab. Optional on the host: an older Walnut has no picker sources.
      const mention = walnut.registry.mentionSource?.(createMailMentionSource(service))
      if (mention) fresh.push(mention)
    } catch (error) {
      for (const handle of fresh.splice(0)) {
        try { await handle.dispose() } catch { /* the throw below is the story */ }
      }
      throw error
    }
    registered = fresh
    currentLine = line
    walnut.log.info('mail agent surface registered', { accounts: accounts.length })
  }

  /**
   * The retry ladder, because "the next account change" is not a retry.
   *
   * The first attempt runs while the database is still opening, so losing it is ordinary. What is
   * not ordinary is what used to follow: nothing came back through here until an account was
   * added or removed, so one failed read at boot meant a Walnut WITH mail accounts and no mail
   * tools for the life of the process, and the only symptom was an agent saying it cannot read
   * mail. The ladder is short and then steady; it stops the moment a pass succeeds, and the
   * timers are owned by the host so teardown cancels a pending one.
   */
  const RETRY_LADDER_MS = [500, 2_000, 8_000, 30_000]
  const RETRY_STEADY_MS = 5 * 60_000
  let retryAttempt = 0
  let retryTimer: { dispose(): void } | undefined

  function scheduleAgentSurfaceSync(): void {
    queue = queue.then(async () => {
      await syncAgentSurface()
      retryAttempt = 0
      retryTimer?.dispose()
      retryTimer = undefined
    }).catch((error: unknown) => {
      // A cache that is not open yet, or a failed migration. Never fatal: mail without agent tools
      // is still a working console, and the ladder below comes back.
      const delay = RETRY_LADDER_MS[retryAttempt] ?? RETRY_STEADY_MS
      retryAttempt += 1
      // Loud once, quiet after: a five-minute cadence against a genuinely broken database should
      // not be the loudest thing in the log.
      const say = retryAttempt === 1 ? walnut.log.warn : walnut.log.debug
      say.call(walnut.log, 'mail could not settle its agent surface', {
        error: String(error).slice(0, 200), attempt: retryAttempt, retryInMs: delay,
      })
      retryTimer?.dispose()
      retryTimer = walnut.timers.timeout(() => { scheduleAgentSurfaceSync() }, delay)
    })
  }

  // On a HOST TIMER, not a floating promise, for the same reason the reconciler is: the gate needs
  // a cache read, activate may not do one, and a read that outlives a teardown re-creates the
  // plugin's data directory after the loader deleted it. A timer is cancelled by dispose.
  const firstSyncTimer = walnut.timers.timeout(() => { scheduleAgentSurfaceSync() }, 0)
  // The base's OWN account signal, in process, so this does not have to know the host's bus naming.
  // An account whose SMTP settings were just filled in must not be told for a minute that it cannot
  // send, so the cached verdict goes before the surface is re-read.
  const accountsWatch = events.onAccountsChanged((event) => {
    service.forgetCapabilities(event.accountId)
    scheduleAgentSurfaceSync()
  })

  sync.start()
  // The rules, identities and backfill load in the background; a replica sorts nothing.
  if (!walnut.replica) {
    void sort.start().catch((error) => walnut.log.warn('mail sorting could not start yet', { error: String(error) }))
  }
  walnut.log.info('Mail base ready', { providers: providers.size, replica: walnut.replica })

  // The only teardown edge. `dispose` closes THIS instance, so a reload cannot have the old
  // activation's teardown close the new activation's database; a module-level `deactivate`
  // reaching for "the current one" could.
  return {
    dispose: async () => {
      unregisterItemSource()
      unregisterRouterSource()
      accountsWatch.dispose()
      firstSyncTimer.dispose()
      retryTimer?.dispose()
      reconcileTimer.dispose()
      // Awaited on the same chain the account watcher uses, so a change that was mid-flight when
      // teardown started cannot register a tool onto a disposed activation.
      queue = queue.then(async () => {
        for (const handle of registered.splice(0)) await handle.dispose()
        currentLine = ''
      })
      await queue.catch(() => undefined)
      await sync.stop()
      sort.setMoveSink(null)
      filters.dispose()
      sort.dispose()
      events.dispose()
      // Only if it is still ours: a reload has already installed the NEW activation's loop by
      // the time the old one's dispose runs, and clearing unconditionally would blind the test
      // seam to the live instance.
      if (mailSyncForTesting() === sync) setActiveMailSync(null)
      await db.dispose()
    },
  }
}
