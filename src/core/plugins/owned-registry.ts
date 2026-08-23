import { toDisposable, type Disposable } from './disposable.js'

export interface OwnedRegistryEntry<T> {
  owner: string
  key: string
  value: T
}

export type OwnedRegistryChange =
  | { type: 'registered' | 'replaced' | 'removed'; owner: string; key: string }
  | { type: 'owner-removed'; owner: string; keys: string[] }
  | { type: 'cleared'; keys: string[] }

interface InternalEntry<T> extends OwnedRegistryEntry<T> {
  token: symbol
}

export class OwnedRegistry<T> {
  private readonly valuesByKey = new Map<string, InternalEntry<T>>()
  private readonly listeners = new Set<(change: OwnedRegistryChange) => void>()
  private revision = 0

  get version(): number {
    return this.revision
  }

  get size(): number {
    return this.valuesByKey.size
  }

  register(owner: string, key: string, value: T): Disposable {
    this.assertIdentity(owner, key)
    if (this.valuesByKey.has(key)) {
      const existing = this.valuesByKey.get(key)!
      throw new Error(`Registry key "${key}" is already registered by "${existing.owner}"`)
    }
    return this.install('registered', owner, key, value)
  }

  replace(owner: string, key: string, value: T): Disposable {
    this.assertIdentity(owner, key)
    const existing = this.valuesByKey.get(key)
    if (existing && existing.owner !== owner) {
      throw new Error(`Registry key "${key}" is owned by "${existing.owner}", not "${owner}"`)
    }
    return this.install(existing ? 'replaced' : 'registered', owner, key, value)
  }

  get(key: string): T | undefined {
    return this.valuesByKey.get(key)?.value
  }

  getEntry(key: string): OwnedRegistryEntry<T> | undefined {
    const entry = this.valuesByKey.get(key)
    return entry ? this.copyEntry(entry) : undefined
  }

  has(key: string): boolean {
    return this.valuesByKey.has(key)
  }

  entries(): OwnedRegistryEntry<T>[] {
    return Array.from(this.valuesByKey.values(), (entry) => this.copyEntry(entry))
  }

  values(): T[] {
    return Array.from(this.valuesByKey.values(), (entry) => entry.value)
  }

  ownedBy(owner: string): OwnedRegistryEntry<T>[] {
    return this.entries().filter((entry) => entry.owner === owner)
  }

  remove(owner: string, key: string): boolean {
    const entry = this.valuesByKey.get(key)
    if (!entry || entry.owner !== owner) return false
    this.valuesByKey.delete(key)
    this.emit({ type: 'removed', owner, key })
    return true
  }

  removeOwner(owner: string): number {
    const keys: string[] = []
    for (const [key, entry] of this.valuesByKey) {
      if (entry.owner !== owner) continue
      this.valuesByKey.delete(key)
      keys.push(key)
    }
    if (keys.length > 0) this.emit({ type: 'owner-removed', owner, keys })
    return keys.length
  }

  clear(): void {
    if (this.valuesByKey.size === 0) return
    const keys = Array.from(this.valuesByKey.keys())
    this.valuesByKey.clear()
    this.emit({ type: 'cleared', keys })
  }

  subscribe(listener: (change: OwnedRegistryChange) => void): Disposable {
    this.listeners.add(listener)
    return toDisposable(() => { this.listeners.delete(listener) })
  }

  private install(
    type: 'registered' | 'replaced',
    owner: string,
    key: string,
    value: T,
  ): Disposable {
    const token = Symbol(key)
    this.valuesByKey.set(key, { owner, key, value, token })
    this.emit({ type, owner, key })
    return toDisposable(() => {
      const current = this.valuesByKey.get(key)
      if (!current || current.token !== token) return
      this.valuesByKey.delete(key)
      this.emit({ type: 'removed', owner, key })
    })
  }

  private copyEntry(entry: InternalEntry<T>): OwnedRegistryEntry<T> {
    return { owner: entry.owner, key: entry.key, value: entry.value }
  }

  private assertIdentity(owner: string, key: string): void {
    if (!owner.trim()) throw new Error('Registry owner must not be empty')
    if (!key.trim()) throw new Error('Registry key must not be empty')
  }

  private emit(change: OwnedRegistryChange): void {
    this.revision++
    for (const listener of this.listeners) {
      try {
        listener(change)
      } catch {
        // A broken observer must not roll back a completed registry mutation.
      }
    }
  }
}
