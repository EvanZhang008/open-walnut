/**
 * vi.mock on bun: let vitest find the file that called it.
 *
 * vitest resolves a relative `vi.mock('../../src/x.js')` against the calling
 * file, which it reads from a stack trace: the frame after the one that says
 * ` at Object.mock` (V8) or `mock@` (Firefox, Safari). bun prints that frame as
 * ` at mock`, so vitest fell back to no file at all, resolved the path against
 * the wrong directory, and every relative mock silently did nothing: the test
 * ran against the real module (on 2026-10-22, a mocked WALNUT_HOME came back as
 * the run's shared home). A builtin (`node:os`) still mocked, which hid it.
 *
 * On bun each mocking call is wrapped in a function whose own name is
 * `Object.<name>`, which bun prints as ` at Object.<name>`: vitest's own lookup
 * then finds the caller one frame below, as on V8. Nothing changes on Node.
 */
import { vi } from 'vitest'

const MOCKING_CALLS = ['mock', 'unmock', 'doMock', 'doUnmock', 'importActual', 'importMock'] as const

if (typeof (process.versions as { bun?: string }).bun === 'string') {
  const target = vi as unknown as Record<string, (...args: unknown[]) => unknown>
  for (const name of MOCKING_CALLS) {
    const original = target[name]
    if (typeof original !== 'function' || (original as { walnutBunWrapped?: boolean }).walnutBunWrapped) continue
    const key = `Object.${name}`
    // Never a tail call: bun drops a frame that ends in one, and vitest needs it.
    const wrapper = { [key]: function (...args: unknown[]) { return [original.apply(vi, args)][0] } }[key]
    Object.defineProperty(wrapper, 'walnutBunWrapped', { value: true })
    target[name] = wrapper
  }
}
