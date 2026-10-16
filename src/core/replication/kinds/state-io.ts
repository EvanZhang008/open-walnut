/**
 * A copy kind's state file, `cache/replica/<kind>.json` (`{v:1, asOf, at, order,
 * hashes}`, 0600 in a 0700 dir), for a kind whose rows live in their own store
 * files (routines, conversations). A file that is the host's off marker
 * (`{v:1, off:true}`, gate.ts) reads as no state. The same shape inbox.ts keeps.
 */

import fsp from 'node:fs/promises'
import { writeCopyFile, type RowSetState } from '../kind-follower.js'
import { copyStateFile } from './gate.js'

export interface StateIo { load(): Promise<RowSetState>; save(): Promise<void>; reset(): void }

export function copyStateIo(kind: string): StateIo {
  let state: RowSetState | null = null
  return {
    load: async () => {
      if (state) return state
      let s: RowSetState = { asOf: 0, at: 0, order: [], hashes: {} }
      try {
        const raw = JSON.parse(await fsp.readFile(copyStateFile(kind), 'utf8')) as Partial<RowSetState> & { v?: number }
        if (raw?.v === 1 && raw.hashes && typeof raw.hashes === 'object') {
          s = { asOf: Number(raw.asOf) || 0, at: Number(raw.at) || 0, order: Array.isArray(raw.order) ? raw.order.map(String) : [], hashes: raw.hashes }
        }
      } catch { /* none yet */ }
      state = s
      return s
    },
    save: async () => { if (state) await writeCopyFile(copyStateFile(kind), { v: 1, ...state }) },
    reset: () => { state = null },
  }
}
