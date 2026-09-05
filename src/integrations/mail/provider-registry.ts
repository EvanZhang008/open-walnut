import type { Disposable, MailProviderSpec, MailProviderSummary } from './types.js'

/**
 * The in-memory provider registry the `mail:base` service wraps.
 *
 * Same shape as every owned slot in the host: register returns a Disposable carrying a token,
 * so a dispose that arrives after the entry was replaced is a no-op instead of removing
 * somebody else's provider.
 *
 * Deliberately the same id shape as a plugin id (see src/core/plugins/ids.ts), restated here
 * rather than imported: `validatePluginId` would refuse a bad provider id with the words
 * "Invalid plugin id", which sends the author looking at their manifest instead of at
 * `spec.id`. Keep the two patterns identical if either one ever changes.
 */
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/

export const PROVIDERS_CHANGED_EVENT = 'providers-changed'

export interface ProvidersChangedEvent {
  action: 'registered' | 'removed'
  providerId: string
  providers: MailProviderSummary[]
}

interface Entry {
  spec: MailProviderSpec
  token: symbol
}

export class MailProviderRegistry {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly onChange: (event: ProvidersChangedEvent) => void) {}

  register(spec: MailProviderSpec): Disposable {
    const id = spec?.id
    if (typeof id !== 'string' || !PROVIDER_ID.test(id)) {
      throw new Error(
        `Invalid mail provider id: ${JSON.stringify(id)} (allowed: ${PROVIDER_ID.source})`,
      )
    }
    if (typeof spec.label !== 'string' || !spec.label.trim()) {
      throw new Error(`Mail provider "${id}" requires a label`)
    }
    if (!spec.capabilities || typeof spec.capabilities !== 'object') {
      throw new Error(`Mail provider "${id}" requires a capabilities block`)
    }
    for (const method of ['listAccounts', 'health', 'listMailboxes', 'poll', 'getBody', 'send'] as const) {
      if (typeof spec[method] !== 'function') {
        throw new Error(`Mail provider "${id}" is missing the required method "${method}"`)
      }
    }
    // `setup` is required, and the console renders it generically: a missing `fields` array or
    // a missing `submit` would only be discovered by the human who clicked "add an account",
    // long after the plugin claimed to have loaded fine.
    if (!spec.setup || !Array.isArray(spec.setup.fields) || typeof spec.setup.submit !== 'function') {
      throw new Error(
        `Mail provider "${id}" requires setup { fields: [], submit() }: the console renders those `
        + 'fields itself and posts the values straight back to submit.',
      )
    }
    if (this.entries.has(id)) {
      throw new Error(
        `Mail provider "${id}" is already registered: a provider id must be unique across every `
        + 'mail provider plugin, because account ids are "<providerId>:<providerAccountId>" and a '
        + 'second provider claiming the id would take over the first one\'s accounts. Pick another '
        + 'id, or dispose the existing registration first.',
      )
    }

    const token = Symbol(id)
    this.entries.set(id, { spec, token })
    this.emit('registered', id)

    return {
      dispose: () => {
        if (this.entries.get(id)?.token !== token) return
        this.entries.delete(id)
        this.emit('removed', id)
      },
    }
  }

  get(id: string): MailProviderSpec | undefined {
    return this.entries.get(id)?.spec
  }

  list(): MailProviderSummary[] {
    return [...this.entries.values()]
      .map(({ spec }) => ({ id: spec.id, label: spec.label, capabilities: spec.capabilities }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  get size(): number {
    return this.entries.size
  }

  private emit(action: ProvidersChangedEvent['action'], providerId: string): void {
    // A listener that throws must not roll back a completed registry mutation: the entry is
    // already in (or out of) the map, and the caller holds a Disposable for it either way.
    try {
      this.onChange({ action, providerId, providers: this.list() })
    } catch {
      /* the caller's own logger owns this; the registry stays consistent */
    }
  }
}
