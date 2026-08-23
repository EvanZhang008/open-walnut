interface HostRuntime {
  React: Record<string, unknown>
  ReactDOM: Record<string, unknown>
  jsxRuntime: Record<string, unknown>
  jsxDevRuntime: Record<string, unknown>
}

declare global {
  var __WALNUT_PLUGIN_HOST__: HostRuntime | undefined
}

export function hostRuntime(): HostRuntime {
  const runtime = globalThis.__WALNUT_PLUGIN_HOST__
  if (!runtime) throw new Error('Walnut Web Plugin runtime is not initialized')
  return runtime
}
