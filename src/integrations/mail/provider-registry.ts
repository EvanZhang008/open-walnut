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
  /** The plugin that called `registerProvider`, or `'unknown'` when nobody owned the call. */
  owner: string
}

export class MailProviderRegistry {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly onChange: (event: ProvidersChangedEvent) => void) {}

  /**
   * Attach a provider on behalf of `owner`.
   *
   * `owner` closes the phantom-provider hole. A provider plugin whose `activate` throws AFTER
   * this call returns never disposes the handle it was given, so the base was left with a row
   * it could not attribute to anybody, and every retry then hit the duplicate-id refusal: the
   * provider was permanently un-installable until the server restarted. With the owner
   * recorded, one `plugin:lifecycle-changed` for a plugin leaving a live state is enough to
   * sweep it (`removeOwner`).
   */
  register(spec: MailProviderSpec, owner: string): Disposable {
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
    this.entries.set(id, { spec, token, owner: owner || 'unknown' })
    this.emit('registered', id)

    return {
      dispose: () => {
        if (this.entries.get(id)?.token !== token) return
        this.entries.delete(id)
        this.emit('removed', id)
      },
    }
  }

  /**
   * Drop everything one plugin registered, and say what went.
   *
   * Called when that plugin leaves a live state. Idempotent by construction: the ordinary
   * teardown path already disposed the handle, so this normally finds nothing, and the case it
   * exists for is the one where nobody could have.
   */
  removeOwner(owner: string): string[] {
    const removed: string[] = []
    for (const [id, entry] of [...this.entries.entries()]) {
      if (entry.owner !== owner) continue
      this.entries.delete(id)
      removed.push(id)
      this.emit('removed', id)
    }
    return removed
  }

  /** Which plugin registered `id`, for a log line or a diagnostic. */
  ownerOf(id: string): string | undefined {
    return this.entries.get(id)?.owner
  }

  get(id: string): MailProviderSpec | undefined {
    return this.entries.get(id)?.spec
  }

  /**
   * Every registered provider id, in registration order.
   *
   * For a sweep over the providers themselves (adoption), which wants the SPECS rather than the
   * console rows `list()` builds. Registration order is deliberate: it is stable, and a sweep that
   * sorted would make the first provider alphabetically the one that spends the budget.
   */
  ids(): string[] {
    return [...this.entries.keys()]
  }

  list(): MailProviderSummary[] {
    return [...this.entries.values()]
      .map(({ spec }) => ({
        id: spec.id,
        label: spec.label,
        capabilities: spec.capabilities,
        // The declared fields travel; `submit` does not. A console renders the add-an-account
        // form from this and nothing else, which is what keeps it from knowing any provider.
        setupFields: spec.setup.fields,
        // Presets travel the same way, and are OMITTED rather than defaulted to `[]`: a provider
        // that declares none has no known services, and an empty array would make the console
        // draw a chip row with nothing in it.
        ...(spec.setup.presets?.length ? { setupPresets: spec.setup.presets } : {}),
      }))
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
