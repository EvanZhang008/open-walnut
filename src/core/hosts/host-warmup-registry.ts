/**
 * The live HostWarmup instance, published for whoever needs to poke it.
 *
 * A tiny module on purpose: server.ts owns the instance's lifetime, and the
 * routes only need to reach it. Without this indirection the route would import
 * server.ts (which imports the routes) and the two would form a cycle.
 * `null` is a normal answer: the warmup is deliberately absent under vitest, in
 * ephemeral sandboxes and on a cloud replica.
 */

import type { HostWarmup } from './host-warmup.js'

let instance: HostWarmup | null = null

export function setHostWarmup(warmup: HostWarmup | null): void {
  instance = warmup
}

export function getHostWarmup(): HostWarmup | null {
  return instance
}
