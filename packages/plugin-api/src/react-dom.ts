import { hostRuntime } from './_host.js'

const ReactDOM = hostRuntime().ReactDOM as any

export default ReactDOM
export const createPortal = ReactDOM.createPortal
export const createRoot = ReactDOM.createRoot
export const flushSync = ReactDOM.flushSync
export const hydrateRoot = ReactDOM.hydrateRoot
export const preconnect = ReactDOM.preconnect
export const prefetchDNS = ReactDOM.prefetchDNS
export const preinit = ReactDOM.preinit
export const preinitModule = ReactDOM.preinitModule
export const preload = ReactDOM.preload
export const preloadModule = ReactDOM.preloadModule
export const requestFormReset = ReactDOM.requestFormReset
export const unstable_batchedUpdates = ReactDOM.unstable_batchedUpdates
export const useFormState = ReactDOM.useFormState
export const useFormStatus = ReactDOM.useFormStatus
export const version = ReactDOM.version
