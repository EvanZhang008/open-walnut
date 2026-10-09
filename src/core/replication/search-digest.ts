/**
 * One number that says whether two sides hold the same search docs, kept
 * current one doc at a time (core/replication/search-replica*.ts).
 *
 * Each entry is a key and a value (the primary's hash and vector state; on the
 * companion, the stamp that doc arrived with). The digest is the entry count
 * and the sum of a 48-bit hash of every entry, so it does not depend on order
 * and a change costs one subtraction and one addition instead of a pass over
 * twelve thousand docs.
 */

import crypto from 'node:crypto'

const MOD = 2 ** 48

export function entryHash48(key: string, value: string): number {
  return parseInt(crypto.createHash('sha1').update(key).update('\n').update(value).digest('hex').slice(0, 12), 16)
}

export class DigestMap {
  private readonly byId = new Map<number, { key: string; value: string; h: number }>()
  private readonly idByKey = new Map<string, number>()
  private sum = 0

  get size(): number { return this.byId.size }

  get digest(): string { return `${this.byId.size}.${this.sum.toString(16)}` }

  set(id: number, key: string, value: string): void {
    const old = this.byId.get(id)
    if (old && old.key === key && old.value === value) return
    if (old) this.delete(id)
    const prior = this.idByKey.get(key)
    if (prior !== undefined) this.delete(prior)
    const h = entryHash48(key, value)
    this.byId.set(id, { key, value, h })
    this.idByKey.set(key, id)
    this.sum = (this.sum + h) % MOD
  }

  delete(id: number): void {
    const old = this.byId.get(id)
    if (!old) return
    this.byId.delete(id)
    if (this.idByKey.get(old.key) === id) this.idByKey.delete(old.key)
    this.sum = (this.sum - old.h + MOD) % MOD
  }

  has(id: number): boolean { return this.byId.has(id) }

  valueOfKey(key: string): string | undefined {
    const id = this.idByKey.get(key)
    return id === undefined ? undefined : this.byId.get(id)?.value
  }

  countValues(pred: (value: string) => boolean): number {
    let n = 0
    for (const e of this.byId.values()) if (pred(e.value)) n++
    return n
  }

  entries(): Array<{ id: number; key: string; value: string }> {
    return [...this.byId].map(([id, e]) => ({ id, key: e.key, value: e.value }))
  }

  clear(): void {
    this.byId.clear()
    this.idByKey.clear()
    this.sum = 0
  }
}
