import { hostRuntime } from './_host.js'

const runtime = hostRuntime().jsxRuntime as any

export const Fragment = runtime.Fragment
export const jsx = runtime.jsx
export const jsxs = runtime.jsxs
