import { afterEach, describe, expect, it } from 'vitest'
import {
  definePluginOp,
  getOp,
  removePluginOps,
  type WalnutOp,
} from '../../src/ops/registry.js'

const owners = ['plugin-ops-a', 'plugin-ops-b']

function operation(name: string, title: string): WalnutOp {
  return {
    name,
    title,
    description: title,
    input: {},
    handler: async () => ({ title }),
    tags: { readonly: true, remote: 'allow' },
  }
}

afterEach(() => {
  for (const owner of owners) removePluginOps(owner)
})

describe('owner-scoped Plugin ops', () => {
  it('removes a contribution through its disposable', () => {
    const registration = definePluginOp(
      owners[0],
      operation('plugin_ops_disposable', 'Disposable'),
    )

    expect(getOp('plugin_ops_disposable')?.title).toBe('Disposable')
    registration.dispose()
    expect(getOp('plugin_ops_disposable')).toBeUndefined()
  })

  it('removes one owner without touching another', () => {
    definePluginOp(owners[0], operation('plugin_ops_first', 'First'))
    definePluginOp(owners[0], operation('plugin_ops_second', 'Second'))
    definePluginOp(owners[1], operation('plugin_ops_other', 'Other'))

    expect(removePluginOps(owners[0])).toBe(2)
    expect(getOp('plugin_ops_first')).toBeUndefined()
    expect(getOp('plugin_ops_second')).toBeUndefined()
    expect(getOp('plugin_ops_other')?.title).toBe('Other')
  })

  it('does not let a stale handle remove a later registration', () => {
    const stale = definePluginOp(
      owners[0],
      operation('plugin_ops_reload', 'Before'),
    )
    removePluginOps(owners[0])
    const current = definePluginOp(
      owners[0],
      operation('plugin_ops_reload', 'After'),
    )

    stale.dispose()
    expect(getOp('plugin_ops_reload')?.title).toBe('After')

    current.dispose()
    expect(getOp('plugin_ops_reload')).toBeUndefined()
  })
})
