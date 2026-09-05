import type { PluginLifecycleChangedEvent } from '../../core/event-types.js'
import type { WalnutServerPluginApi } from '../../core/plugins/server-api.js'
import { MailAccounts } from './accounts.js'
import { createMailBaseApi } from './api.js'
import { MailApprovals } from './approvals.js'
import { MailBodyStore } from './bodies.js'
import { openMailDatabase } from './db.js'
import { MailDrafts } from './drafts.js'
import { MailEvents } from './events.js'
import { MailProviderRegistry, PROVIDERS_CHANGED_EVENT } from './provider-registry.js'
import { MailRetention } from './retention.js'
import { registerMailRoutes } from './routes.js'
import { MailSends } from './sends.js'
import { MailService } from './service.js'
import { MailStore } from './store.js'
import { MailSync, mailSyncForTesting, setActiveMailSync } from './sync.js'

/**
 * The Mail base, as a capability plugin.
 *
 * It owns the domain: the provider contract, the cache, the sync loop, the routes, and later
 * the drafts, approvals, tools and skill. The kernel keeps only the loader, the bus, storage
 * primitives, the App Registry, letters, auth and the server, and it never learns the word
 * "mail".
 *
 * Slice 1 registers NO agent tool, on purpose. A zero-account install must leave the agent's
 * prompt byte-identical, so the tools arrive in P2-3 and only once an account exists; the
 * first account then pays exactly one prompt-cache miss.
 *
 * Activation only REGISTERS. Nothing here awaits I/O: a plugin has 20 seconds to activate, the
 * database opens itself on first use (see db.ts), and the poll loop reads its config and arms
 * its interval on its own time (see sync.ts).
 */

/**
 * The loader's lifecycle announcement (payload: `PluginLifecycleChangedEvent`, declared in
 * src/core/event-types.ts). Spelled out because `walnut.events.on` takes a plain string; the
 * PAYLOAD is typed, so the two ends cannot drift.
 */
const PLUGIN_LIFECYCLE_CHANGED = 'plugin:lifecycle-changed'

/** States in which a plugin is still around to own its registrations. */
const LIVE_STATES = new Set(['discovered', 'activating', 'active'])

export function activate(walnut: WalnutServerPluginApi): { dispose(): Promise<void> } {
  const events = new MailEvents((name, data) => {
    // The host namespaces these to `plugin:mail:<name>`.
    walnut.events.emit(name, data)
  })
  const providers = new MailProviderRegistry((event) => {
    walnut.events.emit(PROVIDERS_CHANGED_EVENT, event)
  })

  const db = openMailDatabase(walnut)
  const store = new MailStore(db)
  const bodies = new MailBodyStore(walnut.storage.dataDir)
  const service = new MailService({ store, bodies, providers })
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
  sync = new MailSync({ walnut, store, service, retention, events, sends, approvals })
  setActiveMailSync(sync)

  // The letter answers. Owned by the loader through `walnut.letters`, and filtered host-side to
  // this plugin's own letters, so the ledger can never be handed a letter id it did not issue.
  walnut.letters.onAnswered((event) => approvals.onLetterAnswered(event))

  // One sweep at activate, before the first tick's interval elapses. A restart is exactly when a
  // draft left frozen by the process that just died has to be put right, and waiting two minutes
  // for the poll timer would leave the console showing a send that nobody is running.
  void approvals.reconcile().catch((error: unknown) => {
    walnut.log.warn('mail could not reconcile frozen drafts at activate', {
      error: String(error).slice(0, 200),
    })
  })

  walnut.services.publish('base', createMailBaseApi({
    providers,
    events,
    sync,
    accounts: () => service.listAccounts(),
    caller: () => walnut.services.caller(),
  }))
  registerMailRoutes(walnut, { store, service, accounts, providers, sync, drafts, approvals, sends })

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

  sync.start()
  walnut.log.info('Mail base ready', { providers: providers.size, replica: walnut.replica })

  // The only teardown edge. `dispose` closes THIS instance, so a reload cannot have the old
  // activation's teardown close the new activation's database; a module-level `deactivate`
  // reaching for "the current one" could.
  return {
    dispose: async () => {
      await sync.stop()
      // Only if it is still ours: a reload has already installed the NEW activation's loop by
      // the time the old one's dispose runs, and clearing unconditionally would blind the test
      // seam to the live instance.
      if (mailSyncForTesting() === sync) setActiveMailSync(null)
      await db.dispose()
    },
  }
}
