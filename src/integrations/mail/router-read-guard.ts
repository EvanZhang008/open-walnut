// The gateway and tool belts run these in-process, past router-area-reader.ts, so the area check lives here.
import { routerStore } from '../../core/router/runtime.js'
import { firstCopyEach } from './one-copy.js'
import { sourceReaderFor, type ScopedSourceReader, type SourceCaller, type SourceReader } from '../../core/router/source-reader.js'
import { MailServiceError, type DraftDto, type MailMessageDto } from './contract.js'
import type { MailAgentDeps } from './agent-surface.js'
import type { MailOpSpec } from './ops.js'
import { mailRouterKey } from './router-source.js'
import type { MailToolSpec } from './tools.js'

const forbidden = () => new MailServiceError('area_forbidden', 'This session may not read mail of another incoming-item area. Nothing was read or changed.', 403)
const unverifiable = () => new MailServiceError(
  'area_unverifiable',
  'Walnut cannot check the incoming-item area of this mail for this caller (no session id, or the area registry or ledger could not be read). Nothing was read or changed.',
  503,
)
const unknownSource = () => new MailServiceError(
  'area_unknown_source',
  'The message this draft replies to is not in the mail cache, so its area cannot be checked. Nothing was changed.',
  409,
)

export type LedgerLookup = (areaId: string, keys: readonly string[]) => Promise<ReadonlySet<string>>

const defaultLedger: LedgerLookup = async (areaId, keys) => new Set((await routerStore(areaId).getMany(keys)).keys())

// `plugin:<id>` and `external` are sids with no area, never a person.
export function mailCallerOf(ctx: unknown, absent: 'person' | 'agent'): SourceCaller {
  const c = ctx && typeof ctx === 'object' ? ctx as { callerSid?: unknown; callerKind?: unknown } : {}
  if (typeof c.callerSid === 'string' && c.callerSid.trim()) return { kind: 'session', sid: c.callerSid.trim() }
  if (c.callerKind === 'person' || c.callerKind === 'agent') return { kind: c.callerKind }
  return { kind: absent }
}

// The row's `from_addr` (the DTO's address) and subject, as confirm matches them; an empty address reads as unknown.
function ruleMetadataOf(row: Pick<MailMessageDto, 'from' | 'subject'>): { sender?: string; subject?: string } {
  const from = row.from as unknown
  const raw = typeof from === 'string' ? from : (from as { address?: unknown } | null | undefined)?.address
  const address = typeof raw === 'string' ? raw : ''
  return { ...(address ? { sender: address } : {}), ...(typeof row.subject === 'string' ? { subject: row.subject } : {}) }
}

// The canonical key comes from the cached row, never the caller's words, so a moved copy with the
// same RFC id matches the confirmed item. The ledger stays a fallback for items saved without a key.
async function judgeRows(reader: Exclude<SourceReader, { kind: 'open' }>, rows: MailMessageDto[], ledger: LedgerLookup): Promise<boolean[]> {
  if (reader.kind === 'unverifiable') throw unverifiable()
  const scoped: ScopedSourceReader = reader
  if (rows.length === 0) return []
  const versions = rows.map((row) => row.deliveryVersion)
  const keys = rows.map((row) => mailRouterKey(row.accountId, row.messageId, row.rfcMessageId))
  const exactKeys = rows.map((row, i) => mailRouterKey(row.accountId, row.messageId, '', versions[i]))
  const refs = rows.map((row, i) => ({
    kind: 'mail' as const, account: row.accountId, message: row.messageId, version: versions[i], canonicalKey: keys[i]!,
    ...ruleMetadataOf(row),
  }))
  const legacyKeys = rows.map((row) => [mailRouterKey(row.accountId, row.messageId), mailRouterKey(row.accountId, row.messageId, row.rfcMessageId)])
  const targets = refs.map((ref) => scoped.itemAreas(ref))
  // `areaIds` is every area of the registry, not the caller's: ledger hits here only restrict.
  await Promise.all(scoped.areaIds.map(async (areaId) => {
    let hits: ReadonlySet<string>
    try { hits = await ledger(areaId, [...new Set([...keys, ...exactKeys, ...legacyKeys.flat()])]) } catch { throw unverifiable() }
    keys.forEach((key, i) => { if (hits.has(key) || hits.has(exactKeys[i]!) || legacyKeys[i]!.some((old) => hits.has(old))) targets[i]!.add(areaId) })
  }))
  // Only the exact registry row grants; a copy matched by key or ledger is never a new body's permission.
  return targets.map((target, i) => scoped.allowsItem(target, versions[i] ? scoped.exactAreas(refs[i]!) : new Set<string>()))
}

function overlay<T extends object>(target: T, overrides: Partial<T>): T {
  return new Proxy(target, {
    get(t, prop) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop as keyof T]
      const value: unknown = Reflect.get(t, prop, t)
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(t) : value
    },
  })
}

export function scopeMailDeps(
  deps: MailAgentDeps,
  reader: Exclude<SourceReader, { kind: 'open' }>,
  ledger: LedgerLookup = defaultLedger,
  refreshReader?: () => Promise<SourceReader>,
): MailAgentDeps {
  const raw = deps.service
  const currentReader = async () => {
    const current = refreshReader ? await refreshReader() : reader
    if (current.kind === 'open') throw unverifiable()
    return current
  }
  const keep = async (rows: MailMessageDto[]) => {
    const ok = await judgeRows(await currentReader(), rows, ledger)
    return rows.filter((_, i) => ok[i])
  }
  // Cache only: judged before any provider call.
  const envelope = async (accountId: string, messageId: string): Promise<MailMessageDto> => {
    if (reader.kind === 'unverifiable') throw unverifiable()
    const row = await raw.readEnvelope(accountId, messageId)
    if (!(await judgeRows(await currentReader(), [row], ledger))[0]) throw forbidden()
    return row
  }
  const gateDraft = async (draft: DraftDto): Promise<DraftDto> => {
    if (reader.kind === 'unverifiable') throw unverifiable()
    if (!draft.inReplyTo) return draft
    try {
      await envelope(draft.accountId, draft.inReplyTo)
    } catch (error) {
      if (error instanceof MailServiceError && error.code === 'unknown_message') throw unknownSource()
      throw error
    }
    return draft
  }
  const service = overlay(raw, {
    readEnvelope: envelope,
    async readMessage(accountId, messageId, options) {
      const before = await envelope(accountId, messageId)
      // A mutable provider handle can return a reply the cache has not seen or confirmed yet.
      if (!before.hasBody) return { message: before, body: null, ...(before.bodyError ? { bodyError: before.bodyError } : {}) }
      const result = await raw.readMessage(accountId, messageId, { ...options, cacheOnly: true })
      const after = await envelope(accountId, messageId)
      if (!before.deliveryVersion || before.deliveryVersion !== after.deliveryVersion
        || before.deliveryVersion !== result.message.deliveryVersion) throw forbidden()
      if (!(await judgeRows(await currentReader(), [result.message], ledger))[0]) throw forbidden()
      return result
    },
    // Every folder's copy is judged, then one per mail: the copy this area may read is often not the
    // one the store would keep (its inbox copy), and keeping that one first left the router nothing.
    async threadMessages(accountId, threadId, limit) {
      if (reader.kind === 'unverifiable') throw unverifiable()
      return firstCopyEach(await keep(await raw.threadMessages(accountId, threadId, limit, { allCopies: true })))
    },
    async listMessages(query) {
      if (reader.kind === 'unverifiable') throw unverifiable()
      const page = await raw.listMessages(query)
      return { ...page, messages: await keep(page.messages) }
    },
    async search(query) {
      if (reader.kind === 'unverifiable') throw unverifiable()
      const found = await raw.search({ ...query, cacheOnly: true, allCopies: true })
      return { ...found, messages: firstCopyEach(await keep(found.messages)) }
    },
    async replyTarget(accountId, messageId) {
      const before = await envelope(accountId, messageId)
      const target = await raw.replyTarget(accountId, messageId)
      const after = await envelope(accountId, messageId)
      if (!before.deliveryVersion || target.deliveryVersion !== before.deliveryVersion || after.deliveryVersion !== before.deliveryVersion) throw forbidden()
      return target
    },
    async markRead(accountId, messageId, read) {
      await envelope(accountId, messageId)
      return raw.markRead(accountId, messageId, read)
    },
    async markReadMany(accountId, messageIds, read) {
      for (const id of messageIds) await envelope(accountId, id)
      return raw.markReadMany(accountId, messageIds, read)
    },
  })
  const drafts = overlay(deps.drafts, {
    async get(draftId) { return gateDraft(await deps.drafts.get(draftId)) },
    async patch(draftId, patch) {
      await gateDraft(await deps.drafts.get(draftId))
      return deps.drafts.patch(draftId, patch)
    },
  })
  const approvals = overlay(deps.approvals, {
    async requestSend(draftId, revision) {
      await gateDraft(await deps.drafts.get(draftId))
      return deps.approvals.requestSend(draftId, revision)
    },
  })
  const unsubscribe = overlay(deps.unsubscribe, {
    async requestFromAgent(accountId, messageId) {
      await envelope(accountId, messageId)
      return deps.unsubscribe.requestFromAgent(accountId, messageId)
    },
  })
  return { ...deps, service, drafts, approvals, unsubscribe }
}

export interface MailGuardOptions {
  readerFor?: (caller: SourceCaller) => Promise<SourceReader>
  ledger?: LedgerLookup
}

export async function keepUnassignedMail(rows: MailMessageDto[], options: MailGuardOptions = {}): Promise<MailMessageDto[]> {
  const reader = await (options.readerFor ?? sourceReaderFor)({ kind: 'agent' })
  if (reader.kind === 'open') return rows
  const ok = await judgeRows(reader, rows, options.ledger ?? defaultLedger)
  return rows.filter((_, i) => ok[i])
}

async function depsFor(caller: SourceCaller, deps: MailAgentDeps, options: MailGuardOptions): Promise<MailAgentDeps> {
  const refresh = () => (options.readerFor ?? sourceReaderFor)(caller)
  const reader = await refresh()
  return reader.kind === 'open' ? deps : scopeMailDeps(deps, reader, options.ledger, refresh)
}

export type GuardedMailOpSpec = Omit<MailOpSpec, 'handler'> & {
  handler(args: Record<string, unknown>, ctx?: unknown): Promise<string>
}

export function guardMailOps(
  specs: MailOpSpec[],
  deps: MailAgentDeps,
  build: (deps: MailAgentDeps) => MailOpSpec[],
  options: MailGuardOptions = {},
): GuardedMailOpSpec[] {
  return specs.map((spec) => ({
    ...spec,
    async handler(args: Record<string, unknown>, ctx?: unknown): Promise<string> {
      const caller = mailCallerOf(ctx, 'agent')
      if (caller.kind === 'person') return spec.handler(args)
      const scoped = build(await depsFor(caller, deps, options)).find((one) => one.name === spec.name)
      if (!scoped) throw new Error(`mail op ${spec.name} vanished from its own factory`)
      return scoped.handler(args)
    },
  }))
}

export type GuardedMailToolSpec = Omit<MailToolSpec, 'execute'> & {
  execute(input: Record<string, unknown>, meta?: unknown): Promise<string>
}

export function guardMailTools(
  specs: MailToolSpec[],
  deps: MailAgentDeps,
  build: (deps: MailAgentDeps) => MailToolSpec[],
  options: MailGuardOptions = {},
): GuardedMailToolSpec[] {
  return specs.map((spec) => ({
    ...spec,
    async execute(input: Record<string, unknown>, meta?: unknown): Promise<string> {
      const caller = mailCallerOf(meta, 'agent')
      if (caller.kind === 'person') return spec.execute(input)
      const scoped = build(await depsFor(caller, deps, options)).find((one) => one.name === spec.name)
      if (!scoped) throw new Error(`mail tool ${spec.name} vanished from its own factory`)
      return scoped.execute(input)
    },
  }))
}
