/**
 * thread_update reads known: true as "all" (2026-11-23: a node sent known: true and was refused
 * bad_request, then gave up closing his cards). The op's input accepts it; the handler sends "all".
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { getOp } from '../../src/ops/index.js'

describe('thread_update known', () => {
  it('takes true as "all", and still refuses a word that is neither', () => {
    const input = z.object(getOp('thread_update')!.input as z.ZodRawShape)
    expect(input.safeParse({ id: 'th-aaaaaaaaaaaa', known: true }).success).toBe(true)
    expect(input.safeParse({ id: 'th-aaaaaaaaaaaa', known: 'all' }).success).toBe(true)
    expect(input.safeParse({ id: 'th-aaaaaaaaaaaa', known: false }).success).toBe(false)
    expect(input.safeParse({ id: 'th-aaaaaaaaaaaa', known: 'yes' }).success).toBe(false)
  })

  it('the handler sends "all" for true', async () => {
    const op = getOp('thread_update')!
    let sent: Record<string, unknown> | null = null
    const call = async (_m: string, path: string, body?: unknown) => {
      if (path.startsWith('/tasks/') && path.includes('/threads/')) { sent = body as Record<string, unknown>; return { thread: { id: 'th-aaaaaaaaaaaa', title: 'x', state: 'answered' } } }
      return { task: { id: 'lead-1' } }
    }
    await (op.handler as (a: unknown, c: unknown) => Promise<unknown>)({ id: 'th-aaaaaaaaaaaa', known: true, task: 'lead-1' }, call).catch(() => undefined)
    expect(sent).toMatchObject({ known: 'all' })
  })
})
