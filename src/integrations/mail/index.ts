import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PluginLifecycleChangedEvent } from '../../core/event-types.js'
import type { WalnutServerPluginApi } from '../../core/plugins/server-api.js'
import { MailAccounts } from './accounts.js'
import type { MailAgentDeps } from './agent-surface.js'
import { createMailBaseApi } from './api.js'
import { MailApprovals } from './approvals.js'
import { MailBodyStore } from './bodies.js'
import type { MailAccountDto } from './contract.js'
import { openMailDatabase } from './db.js'
import { MailDigest } from './digest.js'
import { MailDrafts } from './drafts.js'
import { MailEvents } from './events.js'
import { MailMessageTasks } from './message-tasks.js'
import { createMailOps } from './ops.js'
import { MailProviderRegistry, PROVIDERS_CHANGED_EVENT } from './provider-registry.js'
import { MailRetention } from './retention.js'
import { registerMailRoutes } from './routes.js'
import { MailSends } from './sends.js'
import { MailService } from './service.js'
import { MailStore } from './store.js'
import { MailSync, mailSyncForTesting, setActiveMailSync } from './sync.js'
import { createMailTools } from './tools.js'

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
 * Resolved from this module's own location because the two layouts differ and both are real:
 * `src/integrations/mail/index.ts` when the server runs from source (every test does), and
 * `dist/integrations/mail/index.js` for a built one. `import.meta.url` is right in both without
 * either being spelled out, which is why it is not derived from cwd or from the manifest path.
 */
const SKILL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'agent-skills')

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
  const bodies = new MailBodyStore(walnut.storage.dataDir)
  const service = new MailService({ store, bodies, providers, log: walnut.log })
  forgetCapabilities = (accountId) => service.forgetCapabilities(accountId)
  // The write path. `letters` is the host's, and it is the ONLY way this plugin asks the human
  // for anything: a letter renders on the console and on the phone, and its answer comes back
  // through the bus filtered to this plugin's own letters.
  const drafts = new MailDrafts({ store, events })
  const sends = new MailSends({ store, service, drafts, letters: walnut.letters, events, log: walnut.log })
  const approvals = new MailApprovals({
    store, service, drafts, sends, letters: walnut.letters, events, log: walnut.log,
  })
  // Everything that deletes, in one place, so a read path cannot reach a delete by accident.
  const retention = new MailRetention({ store, bodies, events })
  // Mail leaving the plugin, in the two directions it can: one message becomes one task, and the
  // day's unread becomes one letter. Both go through the host's own services (`walnut.tasks`,
  // `walnut.letters`), so the kernel never learns the word "mail" for either of them.
  const messageTasks = new MailMessageTasks({
    store,
    events,
    tasks: walnut.tasks,
    read: {
      message: (accountId, messageId) => service.readEnvelope(accountId, messageId),
      // From the MIRROR ROW, not from `listAccounts()`. The decorated list asks every provider what
      // each of its accounts can do, and one mail becoming one task has no business reaching a mail
      // server for a display name it can read from a column.
      accountLabel: async (accountId: string) => {
        const row = await store.getAccount(accountId)
        return row?.display_name || row?.address || accountId
      },
      bodyText: (accountId, messageId) => service.bodyTextFor(accountId, messageId),
    },
    log: walnut.log,
  })
  const digest = new MailDigest({
    store,
    events,
    letters: walnut.letters,
    // The CHEAP shape: the digest wants names and counts, and the capability half of the full shape
    // is a provider call per account.
    accounts: () => service.listAccounts({ capabilities: false }),
    config: walnut.config,
    log: walnut.log,
  })
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
  })
  // The digest rides the tick rather than a timer of its own: "is today's due" is a clock question,
  // and this plugin already owns exactly one timer. A replica arms no tick at all, which is also how
  // the digest stays off there without a second replica check.
  sync = new MailSync({ walnut, store, service, retention, events, sends, approvals, digest })
  setActiveMailSync(sync)

  // The letter answers. Owned by the loader through `walnut.letters`, and filtered host-side to
  // this plugin's own letters, so the ledger can never be handed a letter id it did not issue.
  walnut.letters.onAnswered((event) => approvals.onLetterAnswered(event))

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
  }))
  registerMailRoutes(walnut, {
    store, service, accounts, providers, sync, drafts, approvals, sends, messageTasks, digest,
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
    service, drafts, approvals, tasks: messageTasks, replica: () => walnut.replica,
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
      for (const tool of createMailTools(agentDeps)) fresh.push(walnut.registry.tool(tool))
      for (const op of createMailOps(agentDeps)) fresh.push(walnut.registry.op(op))
      fresh.push(walnut.registry.skill({ id: 'walnut-mail', directory: SKILL_DIR }))
      fresh.push(walnut.registry.agentContext(line))
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
  walnut.log.info('Mail base ready', { providers: providers.size, replica: walnut.replica })

  // The only teardown edge. `dispose` closes THIS instance, so a reload cannot have the old
  // activation's teardown close the new activation's database; a module-level `deactivate`
  // reaching for "the current one" could.
  return {
    dispose: async () => {
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
      // Only if it is still ours: a reload has already installed the NEW activation's loop by
      // the time the old one's dispose runs, and clearing unconditionally would blind the test
      // seam to the live instance.
      if (mailSyncForTesting() === sync) setActiveMailSync(null)
      await db.dispose()
    },
  }
}
