/**
 * An op whose route reaches another host (a dial, a held answer) must wait for that route's own
 * answer: the executor's default 10 s gave up first, so an offline host read as a bare
 * "Walnut request timed out after 10000ms" instead of the route's "cannot reach <host>"
 * (2026-11-01, host_mcp_list on two offline hosts). The route answers within the relayed
 * caller's hold (about 14 s), so every such op names a deadline past it.
 */
import { describe, expect, it } from 'vitest'
import '../../../src/ops/index.js'
import { listOps } from '../../../src/ops/registry.js'

const DIALS_A_HOST = /^\/hosts\/:host\/(exec|mcp|http)|^\/host-copy/

describe('ops that reach another host', () => {
  it('each waits past the route\'s own answer', () => {
    const ops = listOps().filter((op) => op.bind && DIALS_A_HOST.test(op.bind.path))
    expect(ops.map((op) => op.name)).toEqual(expect.arrayContaining(['host_exec', 'host_mcp_list', 'host_mcp_tools', 'host_mcp_call', 'host_mcp_result', 'host_http', 'host_copy', 'host_copy_result']))
    const short = ops.filter((op) => (op.timeoutMs ?? 10_000) < 30_000).map((op) => `${op.name} (${op.timeoutMs ?? 'default 10000'} ms)`)
    expect(short).toEqual([])
  })
})
