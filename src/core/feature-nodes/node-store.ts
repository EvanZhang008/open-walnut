import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { withFileLock } from '../../utils/file-lock.js'
import { capabilityKey, capabilitySchema, identifierSchema, immutableJson } from './protocol.js'
import type { Authority, PermissionGrant } from './contracts.js'

const MAX_STORE_BYTES = 1024 * 1024
const tokenSchema = z.string().regex(/^fn\.[a-f0-9]{64}$/)
const grantsSchema = z.array(z.strictObject({
  capability: capabilitySchema, fingerprint: identifierSchema,
})).min(1).max(64).refine((grants) => new Set(grants.map((grant) => capabilityKey(grant.capability))).size === grants.length)
const recordSchema = z.strictObject({
  nodeId: identifierSchema,
  accountId: identifierSchema,
  permissionVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  grants: grantsSchema,
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  revoked: z.boolean(),
})
const storeSchema = z.strictObject({ version: z.literal(1), nodes: z.array(recordSchema).max(32) })
  .refine((store) => new Set(store.nodes.map((node) => node.nodeId)).size === store.nodes.length
    && new Set(store.nodes.map((node) => node.tokenHash)).size === store.nodes.length)
type NodeRecord = z.infer<typeof recordSchema>
type NodeStore = z.infer<typeof storeSchema>
export type NodeStoreCode = 'invalid_input' | 'unavailable' | 'conflict' | 'denied' | 'busy'
export class NodeStoreError extends Error {
  constructor(readonly code: NodeStoreCode) { super(code) }
}

function digest(token: string): string { return createHash('sha256').update(token).digest('hex') }
function authority(record: NodeRecord): Authority {
  return Object.freeze({
    nodeId: record.nodeId, accountId: record.accountId, permissionVersion: record.permissionVersion,
    grants: Object.freeze(record.grants.map((grant) => Object.freeze({
      fingerprint: grant.fingerprint, capability: Object.freeze({ ...grant.capability }),
    }))),
  })
}
function nextVersion(record: NodeRecord): number {
  if (record.permissionVersion === Number.MAX_SAFE_INTEGER) throw new NodeStoreError('unavailable')
  return record.permissionVersion + 1
}

export class FeatureNodeStore {
  constructor(private readonly filePath: string) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new NodeStoreError('invalid_input')
  }

  private async load(): Promise<NodeStore> {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
      const metadata = await fs.lstat(this.filePath)
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new NodeStoreError('unavailable')
      handle = await fs.open(this.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > MAX_STORE_BYTES
        || process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new NodeStoreError('unavailable')
      const bytes = Buffer.alloc(MAX_STORE_BYTES + 1)
      let offset = 0
      while (offset <= MAX_STORE_BYTES) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null)
        if (!bytesRead) break
        offset += bytesRead
      }
      if (offset > MAX_STORE_BYTES) throw new NodeStoreError('unavailable')
      const parsed = storeSchema.safeParse(JSON.parse(bytes.subarray(0, offset).toString('utf8')))
      if (!parsed.success) throw new NodeStoreError('unavailable')
      return parsed.data
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { version: 1, nodes: [] }
      throw new NodeStoreError('unavailable')
    } finally {
      try { await handle?.close() } catch { throw new NodeStoreError('unavailable') }
    }
  }

  private async persist(store: NodeStore): Promise<void> {
    const directory = path.dirname(this.filePath)
    const temporary = path.join(directory, `.feature-${randomBytes(16).toString('hex')}.pending`)
    const parent = await fs.open(directory, 'r')
    try {
      await parent.sync()
      const handle = await fs.open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify(store, null, 2))
        await handle.sync()
      } finally { await handle.close() }
      await fs.rename(temporary, this.filePath)
      await parent.sync()
    } finally {
      try { await parent.close() } finally { await fs.rm(temporary, { force: true }) }
    }
  }

  private async change<T>(mutate: (store: NodeStore) => T): Promise<T> {
    try {
      const directory = await fs.lstat(path.dirname(this.filePath))
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new NodeStoreError('unavailable')
      return await withFileLock(this.filePath, async () => {
        const store = await this.load()
        const result = mutate(store)
        const checked = storeSchema.safeParse(store)
        if (!checked.success || Buffer.byteLength(JSON.stringify(store, null, 2) + '\n') > MAX_STORE_BYTES) throw new NodeStoreError('invalid_input')
        await this.persist(checked.data)
        return result
      })
    } catch (error) {
      throw error instanceof NodeStoreError ? error : new NodeStoreError('unavailable')
    }
  }

  async provision(input: { nodeId: string; accountId: string; grants: readonly PermissionGrant[] }): Promise<{ token: string; authority: Authority }> {
    const copied = immutableJson(input)
    if (!copied.success) throw new NodeStoreError('invalid_input')
    const checked = recordSchema.omit({ permissionVersion: true, tokenHash: true, revoked: true }).safeParse(copied.payload)
    if (!checked.success) throw new NodeStoreError('invalid_input')
    return this.change((store) => {
      if (store.nodes.some((node) => node.nodeId === checked.data.nodeId)) throw new NodeStoreError('conflict')
      if (store.nodes.length >= 32) throw new NodeStoreError('busy')
      const token = `fn.${randomBytes(32).toString('hex')}`
      const record: NodeRecord = { ...checked.data, permissionVersion: 1, tokenHash: digest(token), revoked: false }
      store.nodes.push(record)
      return { token, authority: authority(record) }
    })
  }

  async verify(token: unknown): Promise<Authority | undefined> {
    if (!tokenSchema.safeParse(token).success) return undefined
    const tokenHash = Buffer.from(digest(token as string), 'hex')
    const store = await this.load()
    let found: NodeRecord | undefined
    for (const record of store.nodes) {
      if (timingSafeEqual(tokenHash, Buffer.from(record.tokenHash, 'hex')) && !record.revoked) found = record
    }
    return found ? authority(found) : undefined
  }

  async lookup(nodeId: string, accountId: string): Promise<Authority | undefined> {
    const store = await this.load()
    const record = store.nodes.find((node) => node.nodeId === nodeId && node.accountId === accountId && !node.revoked)
    return record ? authority(record) : undefined
  }

  async rotate(nodeId: string): Promise<{ token: string; authority: Authority }> {
    return this.change((store) => {
      const record = store.nodes.find((node) => node.nodeId === nodeId && !node.revoked)
      if (!record) throw new NodeStoreError('denied')
      const token = `fn.${randomBytes(32).toString('hex')}`
      record.permissionVersion = nextVersion(record)
      record.tokenHash = digest(token)
      return { token, authority: authority(record) }
    })
  }

  async revoke(nodeId: string): Promise<void> {
    await this.change((store) => {
      const record = store.nodes.find((node) => node.nodeId === nodeId)
      if (!record) throw new NodeStoreError('denied')
      if (!record.revoked) { record.permissionVersion = nextVersion(record); record.revoked = true }
    })
  }
}
