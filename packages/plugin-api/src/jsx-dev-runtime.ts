import { hostRuntime } from './_host.js'

const runtime = hostRuntime().jsxDevRuntime as any

export const Fragment = runtime.Fragment
export const jsxDEV = runtime.jsxDEV
